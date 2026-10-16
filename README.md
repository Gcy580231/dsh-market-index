# dsh-market-index

一份给 **DeepSeek Harness 官方插件市场**用的、**格式 1**（`MarketIndex`）索引。

官方插件页的「发现」标签页只读格式 1 索引；而社区现有的目录（awesome-dsh-plugin 的
`plugins.json`、dsh.so 的 `plugins-index.json`、dsh-market 的 registry）**都不是**这个格式，
所以这里把三份数据交叉后重新生成一份。

## 用法

在 DSH 里把下面两条加进插件市场的索引地址（设置页的索引输入框，或 profile 的
`cordis.patch.yml` → `plugin-market.config.indexes`）：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://cdn.jsdelivr.net/gh/Gcy580231/dsh-market-index@main/index.json     # 主线路（可在 CI 里 purge）
      - https://raw.githubusercontent.com/Gcy580231/dsh-market-index/main/index.json # 备用线路
```

两条都填，互为兜底。填完重启一次 DSH（或经设置页修改，volatile 字段即时生效）。
**不需要安装任何插件**，也不需要 GitHub 账号或 token —— 索引是公开静态文件。

### 线路与缓存（实测）

| 线路 | 缓存 | 说明 |
|---|---|---|
| jsDelivr `@main` | 12 小时 | 每次 Action 跑完会主动 purge，所以正常不会滞后 |
| raw.githubusercontent | 标称 5 分钟 | 实测在部分网络（经代理）明显更久，故列为备用 |

索引内容更新后，消费端的 `plugin-market` 自身还有 10 分钟缓存（`cacheTtlMs`），
所以“Action 跑完”到“界面看到”之间可能有几分钟延迟；发现页刷新或稍等即可。

## 收录规则（三条同时满足才收）

| 条件 | 来源 |
|---|---|
| 包存在于 npm registry | npm |
| 在 awesome-dsh-plugin 目录里 —— 该目录的收录门禁是 `package.json` 声明 `dsh.bundle`，即真的能用 `dsh plugin add` 装 | dsh-plugin-catalog |
| dsh.so 的验证结论为 **L4/L5**、安全扫描 `audited` + `riskLevel: low` + `critical = 0`，且仓库未被 rename/delete | dsh.so |

版本发布时间取 npm registry 的 `time` 字段**真值**（格式 1 要求 `publishTimestamp`，官方校验器
并不核验它 —— 这里刻意不编造）。`engines.dsh` 优先用包自己声明的值，缺失时按
`@deepseek-ai/dsh*` 的 `peerDependencies` 合取推导（与官方参考生成器的规则一致）。

每条还带 `metadata.category`（发现页的分类筛选按它判定，只塞进 `keywords` 的话分类会是空的）
和 `dsh.so-verified-l4` / `-l5` 标签。

## 不保证什么

- **不是安全背书**：dsh.so 是静态扫描（启发式），"低危"不等于无风险。
- **不是全量**：只收两源都能对上 npm 包名的条目（数百量级），不是上万条目录的镜像。
- 收录判断在本仓库，与 DeepSeek、awesome-dsh-plugin 均无隶属关系。

## 刷新

`generate.mjs` 每天由 `.github/workflows/refresh.yml` 重跑（也可手动 `workflow_dispatch`），
跑完会 purge jsDelivr。生成失败时**不覆盖**上一次成功的 `index.json`。
想调规模：`DSH_INDEX_MAX_PLUGINS`、`DSH_INDEX_VERSIONS_PER_PLUGIN`。

本地跑：

```sh
node generate.mjs index.json
```

## 许可与出处

- 验证/安全结论：dsh.so（https://www.dsh.so ，CC-BY-4.0，需署名并保留其 freshness 标记）
- 目录数据：awesome-dsh-plugin（CC0-1.0，https://github.com/awesome-dsh-plugin/awesome-dsh-plugin）
- 版本与发布时间：npm registry
- 本仓库生成的索引：CC0-1.0
