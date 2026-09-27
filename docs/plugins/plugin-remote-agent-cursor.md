# plugin-remote-agent-cursor — Cursor 云端代理

**包名**: `@aalis/plugin-remote-agent-cursor`  
**源码**: `packages/plugin-remote-agent-cursor/src/`

## 概述

`remote-agent` 服务的提供者，对接 Cursor Cloud Agents API v1：建云端代理、在同一个代理上开新一轮、跟踪事件流到终态、按轮取费用、取回成品与工程包，以及归档、恢复、删除与列举代理。契约见 [api-remote-agent](../api/api-remote-agent.md)，第一方消费方是白纸枢纽 [plugin-paper](./plugin-paper.md)。

插件可多实例：多个账号，或同一账号换模型，写成 `@aalis/plugin-remote-agent-cursor:<后缀>`，消费方按实例 id 精确取。激活时只构造提供者，不发任何请求；鉴权与模型参数校验在消费方第一次调 `ready()` 时做，key 失效或网络不通不会拖住激活。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-remote-agent-cursor',
  displayName: 'Cursor 云端代理',
  subsystem: 'external',
  reusable: true,
  provides: [remoteAgent],
  uses: { provide, lifecycle, logger, config },
  apply(caps) { /* 见源码 */ },
});
```

提供者的展示标签为 `Cursor / <模型 id>`。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | Cursor 后台生成的 API key（secret）。只在宿主进程里用，不传给远端代理；缺失时 apply 抛错，插件转 error 态 |
| `baseUrl` | string | `'https://api.cursor.com'` | Cloud Agents API 的根地址，插件在其后拼 `/v1/…` |
| `model.id` | string | `'grok-4.7'` | 建代理用的模型 id，按 `/v1/models` 的 id 严格匹配，不认别名 |
| `model.params` | map | `{ reasoning_effort: 'high', context: '256k', fast: 'false' }` | 模型参数，值一律按字符串交给接口（yaml 里没加引号的 `false`、数字会转成字符串）。须写全，并等于 `/v1/models` 列出的某个变体 |
| `egressMode` | select | `'unknown'` | owner 在 Cursor 后台给云端代理设的出网方式：`none` / `allowlist` / `open` / `unknown`。接口读不到它，Aalis 无法核实 |
| `createTimeoutSeconds` | number | `30` | 建代理请求的超时（最小 5）。建代理约 60 秒才回，超时后用同一 agentId 取回，不会重复建 |
| `requestTimeoutSeconds` | number | `30` | 其余请求的超时（最小 15）。实测单次请求有时要 5 秒以上 |
| `streamIdleSeconds` | number | `60` | 事件流与下载的读空闲超时（最小 45）。事件流连上后约 30 秒才有第一次心跳，之后每 15 到 30 秒一次，设得更短会在每段安静期断线重连 |
| `reconcileIgnoreNames` | list | `[]` | owner 自管的代理名。`listAgents` 不列出这些代理，消费方对账时不把它们当成账本外的代理 |

三个超时的最小值由配置校验告警把关；值不是正数时退回默认值。

```yaml
plugins:
  '@aalis/plugin-remote-agent-cursor':
    apiKey: '<Cursor API key>'
    model: { id: grok-4.7, params: { reasoning_effort: high, context: 256k, fast: 'false' } }
    egressMode: unknown
    reconcileIgnoreNames: ['<owner 自己的代理名>']
```

## 能力声明

- `transcriptIsolation: 'shared'`：同一 Cursor 账号下的无仓库代理能用内置工具读出彼此的完整对话，归档挡不住，删除才挡得住。消费方据此限制同一账号下能用它的白纸数。
- `egress()` 返回 `{ mode: egressMode, source: 'owner-config' }`：出网方式取自配置，白纸页与诊断项标「未核实」，`unknown` 按不限计。
- `layout`：工作目录 `/agent`，交付目录 `/opt/cursor/artifacts/out`（每件任务放在 `out/<任务 id>/`），工程包 `/opt/cursor/artifacts/workspace.tar.gz`。`policyNotes` 两条：不要创建或修改 `AGENTS.md`、`.cursor/rules` 这类会影响以后各轮的规则文件；不要使用订阅或定时唤醒工具（如 `subscribe_timer`）。这些约束写进前言，只是软约束，代理不一定遵守。

## 行为

### 鉴权与模型校验

`ready()` 依次请求 `/v1/me` 与 `/v1/models`：

- `accountKey` 取 `/v1/me` 响应里 `userId`（整数）的十进制写法的 SHA-256 前 16 位十六进制。同一账号的不同 key 得到同一个值，值里不含账号原文与 key。响应里没有 `userId`，或它不是安全范围内的整数时抛 `unavailable`，不按 key 计。
- 模型不存在、参数少写或多写、参数组合不等于 `/v1/models` 列出的任何一个变体，都抛 `unavailable` 并写明原因。只写模型 id 时远端按默认变体（fast、500k）计费，价格是写全参数时的数倍，所以参数不成立时提供者不可用。
- 鉴权失败抛 `unavailable`；断线、超时、5xx 抛 `transient`。
- 成功结果缓存 10 分钟，失败不缓存。

`createAgent` 在建代理之前先调一次 `ready()`（有缓存），参数没校验过就不建代理。

### 建代理与开轮

- 建代理：`POST /v1/agents`，body 带消费方给的 `agentId`、代理名、前言与模型参数，不带 `envVars`，key 不进入云端虚拟机。超时或临时故障时用同一 `agentId` 重发一次（建代理约 60 秒才回，默认超时 30 秒，首个请求超时是常态，只记 debug；两次都不成时抛出，由消费方记）；远端回 409 `agent_id_conflict` 就按 id 取回首轮的 `runId`。首轮开跑的时刻取建代理响应里 `run.createdAt`，按 id 取回时取代理的 `createdAt`：实测两者相同，都是请求到达远端的时刻。
- 开新一轮：`POST /v1/agents/{id}/runs`。409 `agent_busy` 映射为 `busy`，409 `agent_archived` 映射为 `archived`。
- 无参 POST（取消、归档、恢复）一律发 `{}` 加 JSON 头：只带头不带 body 时远端回 400。
- 两种错误体都解析：业务错误 `{error:{code,message}}` 与框架层的 `{code:'error',message}`。
- 429：按 `Retry-After` 等，没有这个头按 60 秒，映射为 `rate-limited`。

### 事件流

`followRun` 读 `GET /v1/agents/{id}/runs/{runId}/stream`：

- 只按简化事件（thinking、assistant、tool_call、result、done）推进续传位置；`status` 与 `heartbeat` 没有 id，`interaction_update` 与简化事件共用 id，都不推进。
- 终态以 `result` 事件或查询这一轮为准，不看 `status` 事件：被取消的一轮 `status` 写 FINISHED，`result` 写 CANCELLED。
- `error` 之后的 `done`、没有 `done` 就断开、读空闲超时，都先查一次这一轮，未到终态才退避后带 `Last-Event-ID` 重连。退避从 1 秒起翻倍，封顶 30 秒，收到新事件后复位。
- 续传位置无效（400）时不带位置从头重放，跳过见过的事件；事件流过期（410）时改为每 15 秒查一次这一轮。
- 断线、5xx、超时一直重试到 `signal` 中止；遇到限流按 `Retry-After` 等；只有 `unavailable`、`not-found`、`rejected` 往外抛。远端返回认不出的状态时按 running 处理并记 warn。
- 每个新的简化事件交出一条进展（只带续传位置）。

### 取回成品

`collectArtifacts` 列出 `GET /v1/agents/{id}/artifacts`，只取 `artifacts/out/<任务 id>/` 下的文件与 `artifacts/workspace.tar.gz`，去掉前缀后交给写入口：

- 路径含 `..`、绝对路径、反斜杠、控制字符或 Unicode Cf 类字符（含双向控制符）、空段或 `.` 段的，拒收并记进 `rejected`；任务 id 本身不能用作目录名时整次抛 `rejected`。
- 文件数超过上限的多余项拒收。列表报的 `sizeBytes` 只用于预检；下载时按实际读到的字节计量，超过单文件或本轮合计上限就中止并拒收。
- 下载先取 `GET …/artifacts/download?path=<列表给的 path>` 返回的预签名链接（约 15 分钟有效），再经 `safeFetch` 下载，逐跳核对私网与重定向，不带 Authorization。
- 列产物出错时整次取回失败；产物列表不分页，响应没有 `items` 数组或带了下一页标记时抛 `unavailable`，不当作只有已列出的这些。单个文件的问题只记进 `rejected`，不中断其余文件：取下载链接遇到非临时错误（404、400、414 等，如文件已被删、路径过长）、下载失败、实际大小超限、写入口拒收。取下载链接遇到临时故障或限流时照抛，由消费方整次重来。

### 其他接口

- `runCost`：`GET /v1/agents/{id}/usage?runId=<runId>`，在 `runs[]` 里按 `runId` 找对应项，花费取 `cost.chargedCents` 与 `cost.rawCostCents` 的较大者，另带 token 用量；没有 `cost` 时返回 `undefined`（费用暂缺）。取较大者是因为文档写计划内额度、BYOK、赠送额度的用量 `chargedCents` 为 0，按请求计价的用量 `rawCostCents` 为 0；只取 `chargedCents` 时，计划内额度的用量按 0 入账，白纸的日上限与换新都不再生效。试点账号实测两者恒等，不能依赖。
- `cancelRun`：409 `run_not_cancellable` 表示已到终态，视为成功。
- `deleteAgent`：404 视为已删。
- `listAgents`：`GET /v1/agents`（默认含已归档的代理），排除 `reconcileIgnoreNames` 里的名字。
- 翻页：`listRuns` 与 `listAgents` 每页带 `limit=100`（接口上限，超过回 400；文档写不带 `limit` 时默认 20 条）。响应带 `nextCursor` 时以 `cursor` 取下一页，直到末页；跨页重复的项按 id 只算一次。取不全时整次抛错，不把已取到的当完整列表，白纸枢纽的对账与开轮认领都依赖列表完整：
  - 任何一页出错都照抛；
  - 响应没有 `items` 数组、`nextCursor` 不是非空字符串、超过 50 页、下一页标记出现过（不会前进）时抛 `unavailable`；
  - 带着 `cursor` 取到空页又没有下一页标记时抛 `transient`：实测列代理遇到认不出的 `cursor` 回 200 空页（列轮次回 400），标记指向的代理在翻页期间被删就是这样，重新列举即可。
- 列表不是快照：列代理按 `updatedAt` 倒序，翻页期间更新的代理会挪到已读过的头部，这一次可能漏掉，下一次对账再补上。只有账号下超过 100 个代理、要翻页时才会出现。

### 凭据与日志

key 只放在发往 `baseUrl` 的请求头里。错误信息与日志先去掉 key 的 8 字以上片段（远端可能在错误信息里回显 key 的一段），再去掉 URL 的查询串（预签名链接的签名在查询串里）；错误信息里的请求路径也去掉查询串（取下载链接的查询串带远端可控的成品路径，翻页请求带远端给的标记），超时与断线的错误同样如此。所有请求都受本次调用的超时与插件激活的取消信号约束。

## 注意事项

- `egressMode` 要与 Cursor 后台的实际设置一致。写得比实际严，白纸的出网上限就形同虚设。
- 以后在这个账号新建自管的云端代理时，先把名字加进 `reconcileIgnoreNames`，否则白纸枢纽对账时会把它当成账本外的代理，停开用这个实例的白纸，直到 owner 在 WebUI 把那条告警标为已读。
- 账号级的 MCP 连接会进入这个账号下的每个云端代理，API 侧去不掉；不想让群友经代理操作的服务，要在 Cursor 后台移除或永不授权。
- 同一账号下的代理能互读对话。不要在这个账号里建放私事的无仓库云端代理。

## 相关

- 契约：[api-remote-agent](../api/api-remote-agent.md)
- 消费方：[plugin-paper](./plugin-paper.md)
- 出网与隔离的边界：[安全模型](../concepts/security-model.md) 的「远端代理与白纸」一节
- `safeFetch`：[util-network-guard](../utils/network-guard.md)
