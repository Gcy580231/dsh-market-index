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
 * 关键约束（踩过的坑，勿删）：
 *   * 官方校验器**整份拒收**：任何一处不合法（例如某个 peer 范围写成 pnpm catalog 协议
 *     `catalog:dsh 0.2.0-rc.2`）都会让整个索引 invalid-index，发现页于是什么都看不到。
 *     所以这里先用保守规则净化范围，再用官方 `parseMarketIndex` 做**解析驱动的自愈**：
 *     按报错路径回退（删掉出问题的 engines.dsh / 丢掉出问题的插件）并重试。
 *   * 发现页的分类筛选按 `plugin.metadata.category` 判定，只塞 keywords 会让分类点进去是空的。
 *
 * 用法: node generate.mjs [输出路径，默认 index.json]
 * 环境: DSH_INDEX_MAX_PLUGINS（默认 400）、DSH_INDEX_VERSIONS_PER_PLUGIN（默认 3）
 *       DSH_INDEX_VALIDATOR（默认 1；=0 关闭官方校验器，只做结构自检）
 */
import { writeFile } from 'node:fs/promises'

const OUT = process.argv[2] ?? 'index.json'
const MAX_PLUGINS = Number(process.env.DSH_INDEX_MAX_PLUGINS ?? 400)
const VERSIONS_PER_PLUGIN = Number(process.env.DSH_INDEX_VERSIONS_PER_PLUGIN ?? 3)
const USE_VALIDATOR = process.env.DSH_INDEX_VALIDATOR !== '0'
const NPMJS = 'https://registry.npmjs.org'
const NPMMIRROR = 'https://registry.npmmirror.com'
const CATALOG_PKG = 'dsh-plugin-catalog'
const VALIDATOR_PKG = '@deepseek-ai/dsh-plugin-market-index'

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

/**
 * 保守的 semver 范围净化：pnpm/npm 的协议前缀（catalog:/workspace:/npm:/file:/link:/git+/http）
 * 与不带数字的 tag（alpha/latest）都不是 semver range，官方 node-semver 会直接判不合法。
 * 返回 null 表示“丢掉这个范围”（engines.dsh 缺席 = 不限制 DSH 版本），而不是让整份索引报废。
 */
const FORBIDDEN = /(catalog:|workspace:|npm:|file:|link:|git\+|git:|https?:|\bpath:)/i
function saneRange(raw) {
  if (typeof raw !== 'string') return null
  const r = raw.trim()
  if (!r) return null
  if (FORBIDDEN.test(r)) return null
  if (!/\d/.test(r)) return null                       // tag 形式（alpha / latest 这类无数字串）
  if (/[^0-9A-Za-z.\-+^*~<>=| ]/.test(r)) return null  // 只允许 semver range 的字符集
  return r
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
    byRepo.set(key, { level: Number(v.level), scannedAt: s.scannedAt ?? null, verifiedAt: v.lastVerifiedAt ?? null })
  }
  return { generatedAt: doc?.generatedAt ?? null, count: items.length, byRepo }
}

/** 从 npm 版本清单推导 engines.dsh：优先 manifest.engines.dsh，否则合取 @deepseek-ai/dsh* 的 peer 范围 */
function dshRange(manifest) {
  const declared = saneRange(manifest?.engines?.dsh)
  if (declared) return declared
  const peers = manifest?.peerDependencies ?? {}
  const ranges = Object.keys(peers)
    .filter(k => /^@deepseek-ai\/dsh(-|$)/u.test(k))
    .map(k => saneRange(peers[k]))
    .filter(Boolean)
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

async function loadValidator() {
  if (!USE_VALIDATOR) return null
  try {
    const mod = await import(VALIDATOR_PKG)
    if (typeof mod.parseMarketIndex === 'function') return mod.parseMarketIndex
  } catch (err) { log(`official validator unavailable (${err.message}) — falling back to structural self-check`) }
  return null
}

/** 解析驱动自愈：按官方报错路径回退，直到文档通过或修不动为止 */
function repair(index, parse, indexUrl) {
  let repairs = 0
  for (let round = 0; round < 200; round++) {
    let err = null
    try { parse(index, indexUrl); return { ok: true, repairs } } catch (e) { err = e }
    const path = String(err?.path ?? '')
    const m = path.match(/^\$\.plugins\[(\d+)\](?:\.versions\[(\d+)\])?/)
    if (!m) return { ok: false, repairs, reason: `${path || '$'}: ${err?.reason ?? err?.message}` }
    const pi = Number(m[1]), vi = m[2] === undefined ? null : Number(m[2])
    if (vi === null) index.plugins.splice(pi, 1)
    else if (/\.engines\.dsh$/.test(path)) delete index.plugins[pi].versions[vi].engines.dsh
    else if (/\.engines$/.test(path)) delete index.plugins[pi].versions[vi].engines
    else index.plugins[pi].versions.splice(vi, 1)
    if (index.plugins[pi] && Array.isArray(index.plugins[pi].versions) && !index.plugins[pi].versions.length) index.plugins.splice(pi, 1)
    repairs++
    log(`repair #${repairs}: dropped ${path}`)
  }
  return { ok: false, repairs, reason: 'repair budget exhausted' }
}

/** 结构自检（无官方校验器时的兜底；有校验器时作补充） */
function selfCheck(index) {
  const problems = []
  if (index.format !== 1) problems.push('format must be 1')
  if (!index.plugins?.length) problems.push('plugins empty')
  const names = new Set()
  const declared = new Set(Object.keys(index.metadata?.categories ?? {}))
  const labels = new Set(Object.keys(index.metadata?.labels ?? {}))
  for (const [i, p] of (index.plugins ?? []).entries()) {
    if (typeof p.name !== 'string') problems.push(`plugins[${i}].name invalid`)
    if (names.has(p.name)) problems.push(`plugins[${i}].name duplicate: ${p.name}`)
    names.add(p.name)
    if (p.metadata?.category !== undefined && !declared.has(p.metadata.category)) problems.push(`plugins[${i}].metadata.category not declared: ${p.metadata.category}`)
    for (const l of p.metadata?.labels ?? []) if (!labels.has(l)) problems.push(`plugins[${i}].metadata.labels not declared: ${l}`)
    if (!Array.isArray(p.versions) || !p.versions.length) problems.push(`plugins[${i}].versions empty`)
    for (const [j, v] of (p.versions ?? []).entries()) {
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(v.version)) problems.push(`plugins[${i}].versions[${j}].version invalid`)
      if (!Number.isInteger(v.publishTimestamp) || v.publishTimestamp < 0 || v.publishTimestamp >= 1e11) problems.push(`plugins[${i}].versions[${j}].publishTimestamp invalid`)
      if (v.source?.type !== 'npm' && v.source?.type !== 'git') problems.push(`plugins[${i}].versions[${j}].source invalid`)
      if (v.engines?.dsh !== undefined && saneRange(v.engines.dsh) === null) problems.push(`plugins[${i}].versions[${j}].engines.dsh not a sane range: ${v.engines.dsh}`)
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
      // 必须写 metadata.category：发现页分类筛选按它判定，只塞 keywords 会让分类点进去是空的。
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
        'dsh-so-verified-l5': { title: { en: 'dsh.so L5 run-tested', zh: 'dsh.so L5 实机运行验证' } },
        'dsh-so-verified-l4': { title: { en: 'dsh.so L4 install-tested', zh: 'dsh.so L4 安装验证' } },
      },
      sortKeys: {},
    },
    plugins,
  }

  const indexUrl = process.env.DSH_INDEX_URL ?? 'https://example.invalid/index.json'
  const parse = await loadValidator()
  if (parse) {
    const fixed = repair(index, parse, indexUrl)
    if (!fixed.ok) {
      log(`official validation FAILED after ${fixed.repairs} repairs — ${fixed.reason}`)
      process.exitCode = 1
      return
    }
    log(`official parseMarketIndex: ok${fixed.repairs ? ` (after ${fixed.repairs} repairs)` : ''}`)
  }
  const problems = selfCheck(index)
  if (problems.length) {
    log(`self-check FAILED (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}`)
    process.exitCode = 1
    return
  }
  await writeFile(OUT, `${JSON.stringify(index, null, 1)}\n`)
  log(`wrote ${OUT}: ${index.plugins.length} plugins, ${index.plugins.reduce((a, p) => a + p.versions.length, 0)} versions, ${Object.keys(categories).length} categories`)
}

await main()
