#!/usr/bin/env node
/**
 * 生成 DSH 官方市场可读的「格式 1」索引（MarketIndex）。
 *
 * 数据链路（三源交叉，任一环缺失的条目直接丢弃）：
 *   1. dsh.so /plugins-index.json —— 约 21k 条目的验证与安全结论（L4/L5、audited、riskLevel）;
 *   2. awesome-dsh-plugin 目录（npm 包 dsh-plugin-catalog）—— 收录门禁是 package.json 声明
 *      `dsh.bundle`（即真正可 `dsh plugin add` 的插件），并提供可靠的 npm 包名;
 *   3. npm registry —— 每个版本的**真实**发布时间（格式 1 要求 publishTimestamp，官方校验器
 *      并不核验它，所以这里刻意取真值）与 engines.dsh 推导所需的 peerDependencies。
 *
 * 用法: node generate.mjs [输出路径，默认 index.json]
 * 环境: DSH_INDEX_MAX_PLUGINS（默认 400）、DSH_INDEX_VERSIONS_PER_PLUGIN（默认 3）
 */
import { writeFile } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'index.json'
const MAX_PLUGINS = Number(process.env.DSH_INDEX_MAX_PLUGINS ?? 400)
const VERSIONS_PER_PLUGIN = Number(process.env.DSH_INDEX_VERSIONS_PER_PLUGIN ?? 3)
const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CATALOG_PKG = 'dsh-plugin-catalog'

const now = () => new Date().toISOString()
const log = (...a) => console.error(`[${now()}]`, ...a)

async function getJson(url, { timeoutMs = 30_000, tries = 3 } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'user-agent': 'dsh-market-index/1' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

/** 仓库标识：github.com/owner/repo → owner/repo（小写，去 .git 与子目录） */
function repoKey(url) {
  const m = String(url ?? '').match(/github\.com\/([^/]+)\/([^/#?]+)/i)
  return m ? `${m[1]}/${m[2]}`.replace(/\.git$/, '').toLowerCase() : null
}

/** 社区目录：先问版本，再按版本取 plugins.json（三条镜像依次尝试） */
async function loadCatalog() {
  for (const base of [NPMJS, NPMMIRROR]) {
    try {
      const meta = await getJson(`${base}/${CATALOG_PKG}`, { timeoutMs: 20_000 })
      const v = meta?.['dist-tags']?.latest
      if (typeof v === 'string' && v) {
        for (const url of [
          `https://cdn.jsdelivr.net/npm/${CATALOG_PKG}@${encodeURIComponent(v)}/plugins.json`,
          `https://unpkg.com/${CATALOG_PKG}@${encodeURIComponent(v)}/plugins.json`,
          `${NPMMIRROR}/${CATALOG_PKG}/${encodeURIComponent(v)}/files/plugins.json`,
        ]) {
          try {
            const doc = await getJson(url, { timeoutMs: 60_000, tries: 2 })
            if (Array.isArray(doc?.plugins) && doc.plugins.length) return { version: v, doc, url }
          } catch (err) { log(`catalog route failed ${url}: ${err.message}`) }
        }
      }
    } catch (err) { log(`catalog meta failed ${base}: ${err.message}`) }
  }
  throw new Error('无法获取社区目录（三条镜像与两个 registry 全部失败）')
}

/** dsh.so 验证索引 → 合规仓库表（verification ≥ L4、audited、低危、无 critical、仓库存活） */
async function loadVerified() {
  const doc = await getJson('https://www.dsh.so/plugins-index.json', { timeoutMs: 120_000, tries: 3 })
  const items = Array.isArray(doc?.plugins) ? doc.plugins : []
  const byRepo = new Map()
  for (const it of items) {
    const v = it?.verification ?? {}, s = it?.security ?? {}, h = it?.repoHealth ?? {}
    if (!(Number(v.level) >= 4)) continue
    if (s.status !== 'audited' || s.riskLevel !== 'low') continue
    if (Number(s?.counts?.critical ?? 0) > 0) continue
    if (['merged', 'deleted', 'gone', 'renamed'].includes(h.status)) continue
    const key = repoKey(it.source)
    if (!key || byRepo.has(key)) continue
    byRepo.set(key, { level: Number(v.level), scannedAt: s.scannedAt ?? null, verifiedAt: v.lastVerifiedAt ?? null, alias: it.alias ?? null })
  }
  return { generatedAt: doc?.generatedAt ?? null, count: items.length, byRepo }
}

/** 从 npm 版本清单推导 engines.dsh：优先 manifest.engines.dsh，否则合取 @deepseek-ai/dsh* 的 peer 范围 */
function dshRange(manifest) {
  const declared = typeof manifest?.engines?.dsh === 'string' ? manifest.engines.dsh.trim() : ''
  if (declared) return declared
  const peers = manifest?.peerDependencies ?? {}
  const ranges = Object.keys(peers)
    .filter(k => /^@deepseek-ai\/dsh(-|$)/u.test(k))
    .map(k => String(peers[k]))
    .filter(r => r && !r.includes('workspace:'))
  const uniq = [...new Set(ranges)]
  if (!uniq.length || uniq.every(r => r === '*')) return null
  return uniq.join(' ') // npm semver：空格即合取
}

function versionsFromPackument(doc) {
  const times = doc?.time ?? {}, vs = doc?.versions ?? {}
  const all = Object.keys(vs).filter(v => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(v) && times[v])
  all.sort((a, b) => Date.parse(times[b]) - Date.parse(times[a]))
  return all.slice(0, VERSIONS_PER_PLUGIN).map(v => {
    const m = vs[v] ?? {}
    const range = dshRange(m)
    const kw = Array.isArray(m.keywords) ? m.keywords.filter(k => typeof k === 'string') : []
    return {
      version: v,
      publishTimestamp: Math.floor(Date.parse(times[v]) / 1000),
      source: { type: 'npm' },
      engines: range ? { dsh: range } : {},
      _kw: kw,
      _home: typeof m.homepage === 'string' && /^https?:\/\//u.test(m.homepage) ? m.homepage : null,
      _desc: typeof m.description === 'string' ? m.description : null,
    }
  })
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const at = i++
      out[at] = await fn(items[at], at).catch(() => null)
    }
  }))
  return out
}

/** 结构性自检：官方校验器不在运行时依赖里，这里做等价的必备项检查（上传前本地还会用官方 parseMarketIndex 复验） */
function selfCheck(index) {
  const problems = []
  if (index.format !== 1) problems.push('format must be 1')
  if (!index.plugins?.length) problems.push('plugins empty')
  const names = new Set()
  const declared = new Set(Object.keys(index.metadata?.categories ?? {}))
  const labels = new Set(Object.keys(index.metadata?.labels ?? {}))
  for (const [i, p] of (index.plugins ?? []).entries()) {
    if (typeof p.name !== 'string' || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(p.name)) problems.push(`plugins[${i}].name invalid: ${p.name}`)
    if (names.has(p.name)) problems.push(`plugins[${i}].name duplicate: ${p.name}`)
    names.add(p.name)
    if (p.metadata?.category !== undefined && !declared.has(p.metadata.category)) problems.push(`plugins[${i}].metadata.category not declared: ${p.metadata.category}`)
    for (const l of p.metadata?.labels ?? []) if (!labels.has(l)) problems.push(`plugins[${i}].metadata.labels not declared: ${l}`)
    if (!Array.isArray(p.versions) || !p.versions.length) problems.push(`plugins[${i}].versions empty`)
    for (const [j, v] of (p.versions ?? []).entries()) {
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(v.version)) problems.push(`plugins[${i}].versions[${j}].version invalid`)
      if (!Number.isInteger(v.publishTimestamp) || v.publishTimestamp < 0 || v.publishTimestamp >= 1e11) problems.push(`plugins[${i}].versions[${j}].publishTimestamp invalid`)
      if (v.source?.type !== 'npm' && v.source?.type !== 'git') problems.push(`plugins[${i}].versions[${j}].source invalid`)
    }
  }
  return problems
}

async function main() {
  log('loading dsh.so verification index …')
  const verified = await loadVerified()
  log(`dsh.so: ${verified.count} entries, ${verified.byRepo.size} verified repos (L4/L5 · audited · low risk · 0 critical · repo alive)`)

  log('loading community catalog (dsh.bundle-gated) …')
  const catalog = await loadCatalog()
  log(`catalog: ${catalog.doc.plugins.length} entries from ${catalog.url}`)

  const candidates = []
  const seen = new Set()
  for (const p of catalog.doc.plugins) {
    if (!p?.npm) continue
    const key = repoKey(p.url)
    if (!key) continue
    const so = verified.byRepo.get(key)
    if (!so) continue
    const npm = String(p.npm)
    if (seen.has(npm.toLowerCase())) continue
    seen.add(npm.toLowerCase())
    candidates.push({
      npm,
      repo: `https://github.com/${key}`,
      display: p.name ?? npm,
      zh: p?.description?.zh ?? '',
      en: p?.description?.en ?? '',
      category: p.category ?? null,
      downloads: Number(p.downloads ?? 0),
      stars: Number(p.stars ?? 0),
      so,
    })
  }
  candidates.sort((a, b) => (b.downloads - a.downloads) || (b.stars - a.stars))
  const picked = candidates.slice(0, MAX_PLUGINS)
  log(`join: ${candidates.length} candidates, taking ${picked.length}`)

  log('fetching real npm publish times …')
  let done = 0
  const fetched = await mapPool(picked, 8, async (cand) => {
    const doc = await getJson(`${NPMMIRROR}/${encodeURIComponent(cand.npm)}`, { timeoutMs: 20_000, tries: 2 })
    const versions = versionsFromPackument(doc)
    done++
    if (done % 50 === 0) log(`  …${done}/${picked.length}`)
    return versions.length ? { cand, versions } : null
  })

  const kept = fetched.filter(Boolean)
  const categories = {}
  const catalogCategories = catalog.doc.categories ?? {}
  for (const { cand, versions } of kept) {
    const keywords = new Set()
    for (const v of versions) for (const k of v._kw) keywords.add(k)
    if (cand.category) {
      keywords.add(cand.category)
      const t = catalogCategories[cand.category]
      categories[cand.category] = { title: { en: t?.en ?? cand.category, zh: t?.zh ?? cand.category } }
    }
    keywords.add(`dsh.so-verified-L${cand.so.level}`)
    cand._keywords = [...keywords].slice(0, 24)
  }
  for (const { cand } of kept) if (cand.category && !categories[cand.category]) categories[cand.category] = { title: cand.category }

  const plugins = kept.map(({ cand, versions }) => {
    const home = versions.map(v => v._home).find(Boolean)
    const descEn = (cand.en || versions[0]._desc || '').slice(0, 400)
    const descZh = (cand.zh || cand.en || versions[0]._desc || '').slice(0, 400)
    return {
      name: cand.npm,
      title: cand.display,
      ...(descEn || descZh ? { description: { en: descEn, zh: descZh } } : {}),
      author: cand.repo.split('/')[3] ?? '',
      ...(home ? { homepage: home } : {}),
      repository: { url: cand.repo },
      // 必须写 metadata.category：发现页的分类筛选是按它判定的
      // （dsh-plugin-market：`selection.category === undefined || metadata.category === selection.category`）。
      // 只把分类 id 塞进 keywords，分类会出现在侧栏但点进去永远是空。
      metadata: { ...(cand.category ? { category: cand.category } : {}), keywords: cand._keywords, labels: [`dsh.so-verified-l${cand.so.level}`], sortKeys: {} },
      versions: versions.map(({ _kw, _home, _desc, ...v }) => v),
    }
  })

  const index = {
    format: 1,
    title: { en: 'Verified DSH Plugins (dsh.so L4/L5)', zh: '已验证 DSH 插件（dsh.so L4/L5）' },
    description: {
      en: `Real, installable DSH plugins only: npm-sourced, gated on a dsh.bundle manifest, and carrying a dsh.so L4/L5 verification and a low-risk security scan. Verification data from dsh.so (https://www.dsh.so, CC-BY-4.0, scanned ${kept[0]?.cand?.so?.scannedAt ?? 'n/a'}); publish times from the npm registry.`,
      zh: `只收真实可安装的 DSH 插件：npm 来源、必须有 dsh.bundle manifest，并带有 dsh.so 的 L4/L5 验证与低危安全扫描结论。验证数据来自 dsh.so（https://www.dsh.so，CC-BY-4.0）；版本发布时间取自 npm registry。`,
    },
    metadata: {
      categories,
      labels: {
        'dsh.so-verified-l5': { title: { en: 'dsh.so L5 run-tested', zh: 'dsh.so L5 实机运行验证' } },
        'dsh.so-verified-l4': { title: { en: 'dsh.so L4 install-tested', zh: 'dsh.so L4 安装验证' } },
      },
      sortKeys: {},
    },
    plugins,
  }

  const problems = selfCheck(index)
  if (problems.length) {
    log(`self-check FAILED (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}`)
    process.exitCode = 1
    return
  }
  await writeFile(OUT, `${JSON.stringify(index, null, 1)}\n`)
  log(`wrote ${OUT}: ${plugins.length} plugins, ${plugins.reduce((a, p) => a + p.versions.length, 0)} versions, ${Object.keys(categories).length} categories`)
}

await main()
