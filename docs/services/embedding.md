# embedding 服务

## 1. 定位

把一段文本编码成稠密向量（`text → number[]`）的提供者，是语义检索 / 向量记忆的底层能力。

- 服务注册名：`'embedding'`（`embedding.current`）。
- 契约包：`@aalis/api-embedding`。
- 该契约**有运行时服务**（非纯类型契约），但 `-api` 包本身只导出接口类型与服务描述符 `embedding`（`defineService`），不含实现；实现来自 `plugin-embedding-*` 提供者插件。

## 2. 契约

`@aalis/api-embedding` 的全部导出（`packages/api-embedding/src/index.ts`）：

```ts
// packages/api-embedding/src/index.ts
export interface EmbeddingRequestOptions {
  /** 调用方取消或超时后停止请求，不再重试。 */
  signal?: AbortSignal;
}

export interface EmbeddingService {
  /**
   * 向量空间标识：modelId 相同的两次 embed 结果可直接比较；换模型必须换值。
   * 消费方把它并入向量缓存的失效键，换模型后即可识别并重算旧向量（含同维度换模型）。
   * 不声明时消费方无法区分模型。
   */
  readonly modelId?: string;
  /** 将文本转为向量；支持取消的 provider 应将 signal 传至底层请求。 */
  embed(text: string, options?: EmbeddingRequestOptions): Promise<number[]>;
  /** 列出远端可用模型（用于前端下拉框）*/
  listModels?(): Promise<string[]>;
}
```

服务描述符 `export const embedding = defineService<EmbeddingService>('embedding')` 携带类型，消费方把它写进 `uses` 后 `embedding.current` 即为强类型。

要点：

- `embed(text)` 是**唯一必须实现**的方法，返回单条文本的向量。契约**未约定向量维度**——维度由具体模型决定，跨提供者 / 跨模型不可混用（见 §6）。
- `modelId` 可选，是向量空间标识：同值即向量可比，换模型必须换值。它让消费方能在同维度换模型时识别旧向量；不声明则消费方无从区分。
- `listModels()` 可选，**仅服务于 WebUI 配置表单的动态下拉**（`configSchema` 里 `dynamicOptions: 'embedding'`，见 §4），不参与 embed 主链路。
- 契约**没有批量接口**（如 `embedBatch`）。消费者要批量时需自行并发调 `embed()`（参考实现的连接细节见 §3）。

`@aalis/api-embedding/package.json` 的 `keywords` 含 `aalis-api`——是契约包，不是可加载插件。

## 3. 谁提供 / 谁消费

### 参考实现（provider）

两个一等公民提供者，互为「同名服务」竞争者：

| 包 | 端点 | 说明 |
|---|---|---|
| `@aalis/plugin-embedding-openai` | `POST {baseUrl}/embeddings（baseUrl 为完整前缀，含版本段）` | OpenAI 兼容接口，默认 `text-embedding-3-small` |
| `@aalis/plugin-embedding-ollama` | `POST {baseUrl}/api/embed`（新）或 `/api/embeddings`（旧） | 本地 Ollama，默认 `nomic-embed-text` |

OpenAI 实现（`packages/plugin-embedding-openai/src/index.ts`）：
- `embed`：取响应 `data.data[0].embedding`；失败抛 `Error`，不静默。
- `listModels`：拉 `{baseUrl}/models`，失败返回 `[]`。
- `modelId`：`openai:<model>`。
- 注册：`provide(embedding, service, { label: \`OpenAI / ${model}\` })`。

Ollama 实现（`packages/plugin-embedding-ollama/src/index.ts`）：
- 自动探测新旧 API：首次 `embed` 先试 `/api/embed`，失败则缓存为旧版走 `/api/embeddings`。
- 自带超时（`AbortController`）+ 5xx 重试（`postJson`）；`embed` 失败时同样抛 `Error`。
- `modelId`：`ollama:<model>`。
- 注册：`provide(embedding, service, { label: \`Ollama / ${model}\` })`。

两者 `apply` 都做了启动连通性自检：调一次 `embed('ping')`，**失败只 warn 不阻塞注册**——即服务可能注册成功但实际不可用，消费者不应假设 `embed` 一定成功。

### 典型消费点

**参考消费者 `@aalis/plugin-memory-vector`**（向量记忆，硬依赖）：
- 声明依赖：`uses: { vectorstore, embedding, memory: optional(memory) }`（`packages/plugin-memory-vector/src/index.ts`），并同步写在 `package.json` 的 `aalis.service.required`。
- 取用：`function getEmbedder() { return embedding.current!; }`——封装成函数，**每次读取 `.current` 重新解析**（lazy）。
- 调用点：索引时 `await getEmbedder().embed(embedText)`，查询时 `await getEmbedder().embed(query)`，得到向量后交给 `vectorstore` 检索。

**可选消费者 `@aalis/plugin-user-relation`**（实体 / 事件去重的语义召回，软依赖）：
- 取用：`const embedding = this.caps.embedding.current`（`packages/plugin-user-relation/src/service.ts`）。
- 缺失即降级：`if (!embedding) return null;`（`ensureEntityEmbedding`），不报错、走非语义路径。
- 向量失效键：节点的 `embeddingHash` 由文本指纹并入 `modelId` 得出，换模型后，下一次用到向量的整理（配置了 `consolidationModel` 且开启 auto-link 的 consolidate / maintain）或 `/relation event-duplicates` 会重算旧向量。

**WebUI（`@aalis/plugin-webui-server`）** 通过 `listModels` 聚合下拉：对配置里 `dynamicOptions: 'embedding'` 的字段，调 `services.all('embedding')` 遍历所有提供者，逐个 `await provider.instance.listModels()` 汇总（`packages/plugin-webui-server/src/index.ts`）。单个提供者失败不影响整体。

## 4. 写一个 provider

### 必须 vs 可选

- 必须：实现 `embed(text): Promise<number[]>`；在 `apply` 里 `provide(embedding, impl)`。
- 可选：`listModels()`（仅为 WebUI 下拉服务，不实现也能正常 embed）。
- 建议：声明 `modelId`（如 `foo:<model>`），让缓存向量的消费方能识别换模型。
- 强烈建议：启动连通性自检失败时 **warn 而非 throw**（与两个参考实现一致），让插件能装上、错误暴露在第一次真实调用。

### provides / uses 双源必须同步

DI 靠包清单 + 代码导出**双源**声明（见 [manifest-metadata](../concepts/manifest-metadata.md)）。provider 两处都要写 `provides: ['embedding']`：

`package.json`：
```jsonc
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": { "service": { "provides": ["embedding"] } }
}
```

`src/index.ts` 入口是 `export default definePlugin({ name, subsystem: 'embedding', reusable: true, provides: [embedding], uses: { config, logger, provide }, apply })`（`packages/plugin-embedding-openai/src/index.ts`）。同子系统归组靠定义上的 `subsystem`，多实例靠 `reusable`；不要再写具名 `export const subsystem`。

### 最小可编译骨架

```ts
import { embedding } from '@aalis/api-embedding';
import type { EmbeddingService } from '@aalis/api-embedding';
import { config, definePlugin, logger, provide } from '@aalis/core';

class FooEmbedding implements EmbeddingService {
  endpoint = 'http://localhost:9000';
  model = 'foo-embed-v1';

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

export default definePlugin({
  name: '@yourscope/plugin-embedding-foo',
  subsystem: 'embedding',
  reusable: true,
  provides: [embedding],
  uses: { provide, logger, config },
  async apply({ provide, logger, config }) {
    const endpoint = (config.endpoint as string) ?? 'http://localhost:9000';
    const model = (config.model as string) ?? 'foo-embed-v1';
    const service = new FooEmbedding();
    service.endpoint = endpoint;
    service.model = model;
    try {
      await service.embed('ping');
      logger.info(`Foo Embedding 已就绪: ${model} @ ${endpoint}`);
    } catch (err) {
      logger.warn(`Foo Embedding 连通性检查失败，服务仍将注册: ${String(err)}`);
    }
    provide(embedding, service, { label: `Foo / ${model}` });
  },
});
```

### priority / entryId / label

`provide(descriptor, instance, { priority?, label?, entryId? })`（`packages/core/src/composition/core-services.ts`）：

- `priority`：默认 `0`。同名服务竞争时，winner = **preference > priority > 注册顺序**；要默认压过普通后端取更高值（如 `50`）。普通第三方提供者保持 `0` 即可，让用户在 WebUI 里用 preference 选。
- `entryId`：默认本次激活 id，**须以本次激活 id 为前缀（`/` 分隔）**，用于逻辑身份校验（`packages/core/src/composition/provide-validation.ts`）；卸载清理按激活身份归属，不依赖字符串前缀。一个插件想登记多个 embedding 实例（如多端点）时用 `${lifecycle.id}/${sub}`。
- `label`：人类可读名，WebUI 选择器和 `all()` 返回的条目里展示（两个参考实现都用 `\`OpenAI / ${model}\`` 这种形态）。

详见 [service-model](../concepts/service-model.md) 与 [core/service](../core/service.md)。

## 5. 标准消费方式

### 惰性读取 `.current`（不要缓存实例）

提供者重新 `provide` / 切换会使旧实例失效，所以**每次用都重新取**（见 [lazy-service-access](../concepts/lazy-service-access.md)）。参考实现就是包成 getter 函数：

```ts
function getEmbedder(): EmbeddingService {
  return embedding.current!; // 硬依赖：uses required 已保证存在
}
// 每个调用点：await getEmbedder().embed(text)
```

### 硬依赖 vs 可选依赖

- **硬依赖**：声明 `uses required = ['embedding']`（双源同步到 `package.json`）。运行时框架保证存在，取用可用 `!` 断言（如 memory-vector）。
- **可选依赖**：声明 `uses optional`（或干脆不声明），取用要判空降级：

```ts
const embedding = embedding.current;
if (!embedding) {
  // 降级：跳过语义召回，走纯结构化路径（user-relation 的做法）
  return null;
}
const vec = await embedding.embed(text);
```

### 错误边界

`embed()` 会抛（网络错误 / 非 2xx）。消费者批量索引时要自己兜异常，不要让单条失败中断整批——memory-vector 是逐条入队 + 后台并发索引（`indexing.concurrency`，`index.ts`、默认 10），并提示「过高可能压垮本地 embedding 服务」。`listModels()` 按约定**永不抛**（失败返回 `[]`），消费方仍应防御性兜底。

## 6. 能力 / 风险 → 影响

- **不是 authority 风险面**：`embedding` 不直接挂 authority 风险等级或确认（`embed` 只读、无副作用）。但**触发 embed 的上层动作**可能要走授权（如 user-relation 的去重写回）——那是上层契约的事，见 [authority](../plugins/plugin-authority.md) / [security-model](../concepts/security-model.md)。
- **SSRF**：参考实现直接用裸 `fetch` 打配置里的 `baseUrl`。第三方 provider 若让**用户配置任意 URL** 且可被不可信输入间接驱动，应改用 `safeFetch`（`@aalis/util-network-guard`）做 SSRF 收口。本地 Ollama（`localhost:11434`）/ 受信 OpenAI 端点属常规场景，风险低。
- **维度一致性（最重要的隐性契约）**：向量库里所有向量必须同维度。**切换 embedding 提供者或模型会改变维度**，与既有 `vectorstore` 数据不兼容——消费者（如 memory-vector）需要重建索引，provider 作者切模型时要让用户知道这点。契约本身不暴露维度，无法在 DI 层校验。
- **跨会话隔离**：embedding 服务无状态、不持有会话数据，本身不涉隔离；隔离责任在持有向量的 `vectorstore` / memory 消费者。

## 7. 注意事项与边界情形

- **「注册成功 ≠ 可用」**：连通性自检失败只 warn（§3），服务照样注册。消费者第一次 `embed` 才会真正暴露端点不可达 / key 错误，要做好首调错误处理。
- **无批量 API**：契约只有单条 `embed`。大批量索引靠消费者并发，注意限流（memory-vector 的 `indexing.concurrency` / `maxQueueSize`）以免压垮本地服务。
- **`listModels` 语义弱**：Ollama 实现把 `/api/tags` 的**所有**模型原样返回，刻意不按名字筛（选错模型的代价小于选不到，模型不可用由 doctor 检查项报出，见 `plugin-embedding-ollama/src/index.ts` 的注释），下拉里会混入非 embedding 模型，用户可能选错。
- **OpenAI 端点路径固定**：openai provider 在 `baseUrl`（完整前缀）后拼 `/embeddings`，仅适配 OpenAI 兼容协议；非兼容服务要单独写 provider。
- **维度漂移**（承 §6）：换模型后老向量与新查询向量不可比，余弦相似度结果无意义；这是运维层最常见的问题，文档 / 配置项应显式提醒重建。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名解析 / 同名竞争）、[lazy-service-access](../concepts/lazy-service-access.md)（每次读取 `.current`）、[manifest-metadata](../concepts/manifest-metadata.md)（aalis.service 与 definePlugin provides/uses 双源）、[security-model](../concepts/security-model.md)（SSRF / safeFetch）。
- 核心：[core/service](../core/service.md)、[core/context](../core/context.md)、[core/plugin](../core/plugin.md)、[plugins/plugin-authority](../plugins/plugin-authority.md)。
- 相关服务：`vectorstore`（向量存储与检索，embedding 的直接下游）、`memory`（消息历史，memory-vector 的 optional 依赖）。
