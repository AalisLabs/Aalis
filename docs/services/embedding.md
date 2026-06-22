# embedding 服务

## 1. 一句话定位

把一段文本编码成稠密向量（`text → number[]`）的提供者，是语义检索 / 向量记忆的底层能力。

- 服务注册名：`'embedding'`（`ctx.getService<EmbeddingService>('embedding')`）。
- 契约包：`@aalis/plugin-embedding-api`。
- 该契约**有运行时服务**（非纯类型契约），但 `-api` 包本身只导出 interface + declaration merging，不含实现；实现来自 `plugin-embedding-*` 提供者插件。

## 2. 契约

`@aalis/plugin-embedding-api` 的全部导出（`packages/plugin-embedding-api/src/index.ts`）：

```ts
// packages/plugin-embedding-api/src/index.ts:6-11
export interface EmbeddingService {
  /** 将文本转为向量 */
  embed(text: string): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}
```

并通过 declaration merging 把服务名登记进核心的 `ServiceTypeMap`，使 `getService('embedding')` 拿到强类型：

```ts
// packages/plugin-embedding-api/src/index.ts:14-18
declare module '@aalis/core' {
  interface ServiceTypeMap {
    embedding: EmbeddingService;
  }
}
```

要点：

- `embed(text)` 是**唯一必须实现**的方法，返回单条文本的向量。契约**未约定向量维度**——维度由具体模型决定，跨提供者/跨模型不可混用（见 §6）。
- `listModels()` 可选，**仅服务于 WebUI 配置表单的动态下拉**（`configSchema` 里 `dynamicOptions: 'embedding'`，见 §4）。不参与 embed 主链路。
- 契约**没有批量接口**（如 `embedBatch`）。消费者要批量时只能自己并发调 `embed()`（参考实现的连接细节见 §3）。

`@aalis/plugin-embedding-api/package.json` 标记 `aalis.types: true` 且 `keywords` 含 `aalis-api`——是纯契约包，不是可加载插件。

## 3. 谁提供 / 谁消费

### 参考实现（provider）

两个一等公民提供者，互为「同名服务」竞争者：

| 包 | 端点 | 说明 |
|---|---|---|
| `@aalis/plugin-embedding-openai` | `POST {baseUrl}/v1/embeddings` | OpenAI 兼容接口，默认 `text-embedding-3-small` |
| `@aalis/plugin-embedding-ollama` | `POST {baseUrl}/api/embed`（新）或 `/api/embeddings`（旧） | 本地 Ollama，默认 `nomic-embed-text` |

OpenAI 实现（`packages/plugin-embedding-openai/src/index.ts`）：
- `embed`：取响应 `data.data[0].embedding`（`:43-57`）。失败抛 `Error`，不静默。
- `listModels`：拉 `/v1/models`，失败返回 `[]`（`:59-70`）。
- 注册：`ctx.provide('embedding', service, { label: \`OpenAI / ${model}\` })`（`:95`）。

Ollama 实现（`packages/plugin-embedding-ollama/src/index.ts`）：
- 自动探测新旧 API：首次 `embed` 先试 `/api/embed`，失败缓存为旧版走 `/api/embeddings`（`:84-117`）。
- 自带超时（`AbortController`）+ 5xx 重试（`postJson`，`:60-82`）；`embed` 失败时同样抛 `Error`。
- 注册：`ctx.provide('embedding', service, { label: \`Ollama / ${model}\` })`（`:152`）。

两者 `apply` 都做了「启动连通性自检」：调一次 `embed('ping')`，**失败只 warn 不阻塞注册**（openai `:87-93` / ollama `:144-150`）——即服务可能注册成功但实际不可用，消费者别假设 `embed` 一定成功。

### 典型消费点

**参考消费者 `@aalis/plugin-memory-vector`**（向量记忆，硬依赖）：
- 声明依赖：`export const inject = { required: ['vectorstore', 'embedding'], optional: ['memory'] }`（`packages/plugin-memory-vector/src/index.ts:17-20`），并同步写在 `package.json` 的 `aalis.service.required`。
- 取用：`function getEmbedder() { return ctx.getService<EmbeddingService>('embedding')!; }`（`:254-256`）——封装成函数，**每次用都重新 getService**（lazy）。
- 调用点：索引时 `await getEmbedder().embed(embedText)`（`:355`），查询时 `await getEmbedder().embed(query)`（`:492`、`:751`），得到向量后交给 `vectorstore` 检索。

**可选消费者 `@aalis/plugin-user-relation`**（实体/事件去重的语义召回，软依赖）：
- 取用：`const embedding = this.ctx?.getService<EmbeddingService>('embedding')`（`packages/plugin-user-relation/src/service.ts:2632`、`:3418`、`:3882`）。
- 缺失即降级：`if (!embedding) return null;`（`:2637` 附近的 `ensureEntityEmbedding`），不报错、走非语义路径。

**WebUI（`@aalis/plugin-webui-server`）** 通过 `listModels` 聚合下拉：对配置里 `dynamicOptions: 'embedding'` 的字段，调 `ctx.getAllServices('embedding')` 遍历所有提供者，逐个 `await provider.instance.listModels()` 汇总（`packages/plugin-webui-server/src/index.ts:904-944`）。单个提供者失败不影响整体。

## 4. 写一个 provider

### 必须 vs 可选

- 必须：实现 `embed(text): Promise<number[]>`；在 `apply` 里 `ctx.provide('embedding', impl)`。
- 可选：`listModels()`（仅为 WebUI 下拉服务，不实现也能正常 embed）。
- 强烈建议：启动连通性自检失败时 **warn 而非 throw**（与两个参考实现一致），让插件能装上、错误暴露在第一次真实调用。

### provides/inject 双源必须同步

DI 靠包清单 + 代码导出**双源**声明（见 [manifest-metadata](../concepts/manifest-metadata.md)）。provider 两处都要写 `provides: ['embedding']`：

`package.json`：
```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": { "service": { "provides": ["embedding"] } }
}
```

`src/index.ts` 导出：
```ts
export const provides = ['embedding'];
export const subsystem = 'embedding'; // 同子系统的提供者在 WebUI 里归组
export const reusable = true;          // 允许同插件多实例（多账号/多端点）
```

### 最小可编译骨架

```ts
import type { Context } from '@aalis/core';
import type { EmbeddingService } from '@aalis/plugin-embedding-api';

export const name = '@yourscope/plugin-embedding-foo';
export const provides = ['embedding'];
export const subsystem = 'embedding';
export const reusable = true;

class FooEmbedding implements EmbeddingService {
  constructor(private endpoint: string, private model: string) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.endpoint}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`foo embedding 失败: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { vector: number[] };
    return data.vector;
  }

  // 可选：仅供 WebUI dynamicOptions 下拉
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.endpoint}/models`);
      if (!res.ok) return [];
      return ((await res.json()) as { models: string[] }).models;
    } catch {
      return [];
    }
  }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const endpoint = (config.endpoint as string) ?? 'http://localhost:9000';
  const model = (config.model as string) ?? 'foo-embed-v1';
  const service = new FooEmbedding(endpoint, model);

  try {
    await service.embed('ping');
    ctx.logger.info(`Foo Embedding 已就绪: ${model} @ ${endpoint}`);
  } catch (err) {
    ctx.logger.warn(`Foo Embedding 连通性检查失败，服务仍将注册: ${String(err)}`);
  }

  // entryId 默认 = ctx.id；多实例/分子项时用 `${ctx.id}/${sub}` 前缀
  ctx.provide('embedding', service, { label: `Foo / ${model}` });
}
```

### priority / entryId / label

`ctx.provide(name, instance, { priority?, label?, entryId? })`（`packages/core/src/context.ts:185-204`）：

- `priority`：默认 `0`（`ServicePriority.Backend`）。同名服务竞争时，winner = **preference > priority > 注册顺序**；要让自己默认压过普通后端用 `ServicePriority.Override = 50`，系统级覆盖才用 `200`（`packages/core/src/types/service.ts:18-31`）。普通第三方提供者保持 `0` 即可，让用户在 WebUI 里用 preference 选。
- `entryId`：默认 `this.id`，**必须以 `this.id` 为前缀（`/` 分隔）**，否则卸载时无法连带注销（`context.ts:179-183`）。一个插件想登记多个 embedding 实例（如多端点）时用 `${ctx.id}/${sub}`。
- `label`：人类可读名，WebUI 选择器和 `getAllServices` 里展示（两个参考实现都用 `\`OpenAI / ${model}\`` 这种形态）。

详见 [service-model](../concepts/service-model.md) 与 [core/service](../core/service.md)。

## 5. 标准消费姿势

### lazy getService（不要缓存实例）

提供者重新 `provide` / 切换会使旧实例失效，所以**每次用都重新取**（见 [lazy-service-access](../concepts/lazy-service-access.md)）。参考实现就是包成 getter 函数：

```ts
function getEmbedder(): EmbeddingService {
  return ctx.getService<EmbeddingService>('embedding')!; // 硬依赖：inject.required 已保证存在
}
// 每个调用点：await getEmbedder().embed(text)
```

### 硬依赖 vs 可选依赖

- **硬依赖**：声明 `inject.required = ['embedding']`（双源同步到 `package.json`）。运行时框架保证存在，取用可用 `!` 断言（如 memory-vector）。
- **可选依赖**：声明 `inject.optional`（或干脆不声明），取用要判空降级：

```ts
const embedding = ctx.getService<EmbeddingService>('embedding');
if (!embedding) {
  // 降级：跳过语义召回，走纯结构化路径（user-relation 的做法）
  return null;
}
const vec = await embedding.embed(text);
```

### 错误边界

`embed()` 会抛（网络错误 / 非 2xx）。消费者批量索引时要自己兜异常，别让单条失败炸掉整批——memory-vector 是逐条入队 + 后台并发索引（`indexing.concurrency`，`index.ts:293`、默认 10），并提示「过高可能压垮本地 embedding 服务」（`:85`）。`listModels()` 按约定**永不抛**（失败返回 `[]`），消费方仍应防御性兜底。

## 6. 能力 / 风险 → 影响

- **不是 authority 风险面**：`embedding` 不直接挂 authority 风险等级或确认（`embed` 只读、无副作用）。但**触发 embed 的上层动作**可能要走授权（如 user-relation 的去重写回）——那是上层契约的事，见 [authority](../core/authority.md) / [security-model](../concepts/security-model.md)。
- **SSRF**：参考实现直接用裸 `fetch` 打配置里的 `baseUrl`（openai `:44`、ollama `:66`）。第三方 provider 若让**用户配置任意 URL** 且可被不可信输入间接驱动，应改用 `safeFetch`（`@aalis/util-network-guard`）做 SSRF 收口。本地 Ollama（`localhost:11434`）/ 受信 OpenAI 端点属常规场景，风险低。
- **维度一致性（最重要的隐性契约）**：向量库里所有向量必须同维度。**切换 embedding 提供者或模型会改变维度**，与既有 `vectorstore` 数据不兼容——消费者（如 memory-vector）需要重建索引，provider 作者切模型时要让用户知道这点。契约本身不暴露维度，无法在 DI 层校验。
- **跨会话隔离**：embedding 服务无状态、不持有会话数据，本身不涉隔离；隔离责任在持有向量的 `vectorstore` / memory 消费者。

## 7. 边界与坑

- **「注册成功 ≠ 可用」**：连通性自检失败只 warn（§3），服务照样注册。消费者第一次 `embed` 才会真正暴露端点不可达 / key 错误，要做好首调错误处理。
- **无批量 API**：契约只有单条 `embed`。大批量索引靠消费者并发，注意限流（memory-vector 的 `indexing.concurrency` / `maxQueueSize`）以免压垮本地服务。
- **`listModels` 语义弱**：Ollama 实现把 `/api/tags` 的**所有**模型都返回（未真正过滤 embedding 类，见 `ollama/src/index.ts:124-126` 的注释「没有特征可辨别就全返回」），下拉里会混入非 embedding 模型，用户可能选错。
- **OpenAI 端点形态固定**：openai provider 硬编码 `/v1/embeddings` 路径，仅适配 OpenAI 兼容协议；非兼容服务要单独写 provider。
- **维度漂移**（承 §6）：换模型后老向量与新查询向量不可比，余弦相似度结果无意义；这是运维层最常见的坑，文档/配置项应显式提醒重建。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 同名竞争）、[lazy-service-access](../concepts/lazy-service-access.md)（每次 getService）、[manifest-metadata](../concepts/manifest-metadata.md)（provides/inject 双源）、[security-model](../concepts/security-model.md)（SSRF / safeFetch）。
- 核心：[core/service](../core/service.md)、[core/context](../core/context.md)、[core/plugin](../core/plugin.md)、[core/authority](../core/authority.md)。
- 相关服务：`vectorstore`（向量存储与检索，embedding 的直接下游）、`memory`（消息历史，memory-vector 的 optional 依赖）。
