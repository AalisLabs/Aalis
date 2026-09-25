# plugin-embedding-ollama — Ollama 嵌入服务

**包名**: `@aalis/plugin-embedding-ollama`  
**源码**: `packages/plugin-embedding-ollama/src/index.ts`

## 概述

基于 Ollama HTTP API 的 `EmbeddingService` 实现，默认连接本地 `http://localhost:11434`，以 `embedding` 服务注册，标签为 `Ollama / <model>`，向量空间标识 `modelId` 为 `ollama:<model>`。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-embedding-ollama',
  subsystem: 'embedding',
  provides: [embedding],
  uses: {
    config,
    logger,
    lifecycle,
    provide,
    doctor: optional(doctor),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `'http://localhost:11434'` | Ollama 地址：本地 Ollama 服务的 HTTP 地址 |
| `model` | select | `'nomic-embed-text'` | Embedding 模型：用于生成文本向量的模型 |
| `timeoutMs` | number | `30000` | 请求超时 (ms)：单次 embedding 请求超时时间 |
| `retries` | number | `1` | 失败重试次数：fetch 失败或 5xx 时的重试次数 |

## 特性

- 首次调用先请求新版 `/api/embed`；收到 404/405 时再试旧版 `/api/embeddings`，且只有旧端点真答上来才把「这是旧版」缓存为结论。网络错误、超时、5xx 视为瞬态故障，原样抛出且不记结论，下次调用重新探测
- 模型没 pull 时新旧端点都答 404，此时结论不会被钉死，pull 好之后仍走新版端点。启动连通性检查就是首次调用，Ollama 此刻不可达只会留下一条告警，不会把实例钉在旧版接口上
- 启动时以 `embed('ping')` 做连通性检查：失败只记一条 warn，服务照常注册（Ollama 可能晚于 Aalis 起来）。检查本身会被等待，Ollama 无响应时最长约 `(retries + 1) × timeoutMs`（无响应由 AbortController 掐断后原样抛出，不会再去试旧端点）
- 向 doctor 注册检查项 `service/embedding.ollama`：每次 `/doctor` 现场探一次，模型不可用时报 error。服务注册成功不等于模型可用——`/status` 只判服务是否注册，插件状态也仍是 active，缺了这条检查，「模型没 pull」只会表现为向量记忆静默不工作
- 该检查项的探测自带上限，取 5 秒与 `timeoutMs`（下限 1 秒，与服务自身的 clamp 一致）中的小者：doctor 顺序执行各检查项且不设超时，一条网络探测不应拖住整个 `/doctor`
- 请求失败的错误消息带上 Ollama 响应体里的 `error` 字段：模型没 pull 与端点不存在都是 404，只有响应体能区分（前者是 `model "..." not found, try pulling it first`）
- `listModels()` 从 `/api/tags` 获取本地已下载的模型，原样返回、不按名字筛 embedding：`model` 是 select 字段、没有自由输入，按名筛会让 `bge-m3` 这类名称不含 `embed` 的合法嵌入模型无法从下拉里选到。因此候选里会混有对话模型，选错模型导致的不可用由上面那条 doctor 检查项报出
