# message-archive 服务

## 1. 定位

把**原始入站消息流 + 我方出站富文本 + 平台 notice 事件**持久化成 `Message` 历史条目，写入底层 `memory` 服务，供后续上下文渲染、向量检索、引用回复反查、用户档案事实提取等场景消费。它是「消息文本最终成形（发送者前缀 / 引用回复 / 图片描述 / 附件名）」的**唯一烘焙入口**——预处理器只写元信息，content 的拼接全在归档阶段一锤定音。

- 服务注册名：`getService('message-archive')`（字符串键）
- 契约包：`@aalis/plugin-message-archive-api`
- 参考实现：`@aalis/plugin-message-archive`

`message-archive` 本身不持久化，它委派给 `memory`（必需依赖）。它是 `memory` 之上的「会话语义层」——把会话身份、附件描述、触发来源等烘焙进 `Message.content` 与 `metadata`，让 `memory` 这个纯 KV/向量层不必理解平台语义。

## 2. 契约

契约接口（`packages/plugin-message-archive-api/src/index.ts:35-46`）：

```ts
export interface MessageArchiveService {
  saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void>;
  archiveIncoming(message: IncomingMessage): Promise<ArchiveIncomingResult>;
  /** 平台 notice/事件入档（系统级条目，不会触发 agent 响应） */
  archiveNotice?(options: ArchiveNoticeOptions): Promise<Message | null>;
  /** 在指定会话最近 scanLimit 条历史中查找 metadata.messageId 命中的归档消息，缺省 scanLimit=100 */
  findByMessageId?(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null>;
}
```

方法语义：

- **`saveMessage`**（必需）：直写一条已成形的 `Message` 到指定会话。最薄的一层——直接转发给 `memory.saveMessage`，`options.debugLabel` 仅用于按配置打调试日志（`packages/plugin-message-archive/src/index.ts:98-103`）。用于出站消息回档（如 image-sender 的图片占位、subtask 的系统提示）。
- **`archiveIncoming`**（必需，核心）：吃一条 `IncomingMessage`，做完整烘焙——调用 `media` 识别附件、拼接发送者前缀 / 引用回复 / 附件描述、抽取 @提及、写会话身份 `metadata`，落库后**发出 `inbound:message:archived` 事件**，返回最终 `Message` + content（`packages/plugin-message-archive/src/index.ts:105-188`）。
- **`archiveNotice?`**（可选）：把平台 notice/事件（禁言、撤回、入群等）作为 `role:'notice'` 系统条目入档，`kind` 取 `noticeType`。返回 `null` 表示内容为空被跳过（`:190-220`）。
- **`findByMessageId?`**（可选）：按平台侧 `messageId` 在最近 `scanLimit`（夹取 1..500，缺省 100）条历史里从新往旧反查归档原文，命中我方已烘焙的富文本（含图片描述）。未命中返回 `null`（`:222-233`）。

重要类型（同文件）：

- `ArchiveIncomingResult { message: Message; content: string }`（`:4-7`）——`message` 是落库实体，`content` 是烘焙后的纯文本，调用方常直接拿去喂 LLM。
- `ArchiveNoticeOptions`（`:9-33`）：`sessionId` / `noticeType` / `content` 必填（`content` 为人类可读描述，作为 system 消息正文写入）；`subType` / `platform` / `userId` / `targetId` / `groupId` / `operatorId` / `timestamp` / `data` 可选，`data` 整体透传进 `metadata`。字段语义对齐 OneBot v11/v12 notice 规范。
- `Message`（来自 `@aalis/plugin-message-api`，`packages/plugin-message-api/src/index.ts:82-119`）：`role` + `content: string | null` + 可选 `name` / `kind` / `timestamp` / `metadata`。
- `inbound:message:archived` 事件 payload（`packages/plugin-message-api/src/index.ts:306`）：`{ sessionId, incoming: IncomingMessage, archivedMessage: Message }`。注意 `archivedMessage.content` 可能已不同于 `incoming.content`（已烘焙）。

> `message-archive-api` 标了 `aalis.types: true`（纯类型/契约包，仅在 `@aalis/core` 的 `ServiceTypeMap` 上做 declaration merging，见 `:49-53`），运行时服务由 `plugin-message-archive` 提供。

## 3. 谁提供 / 谁消费

**提供方**：`@aalis/plugin-message-archive`，在 `apply` 末尾 `ctx.provide('message-archive', service)`（`packages/plugin-message-archive/src/index.ts:236`）。manifest 见 `package.json` 的 `aalis.service.provides: ['message-archive']` + 源码 `export const provides = ['message-archive']`（`:22`）。

**典型消费点**（全部走 `ctx.getService<MessageArchiveService>('message-archive')`，且都列为 `inject.optional`）：

- `plugin-agent`：主链路。`archiveIncomingMessageInOrder` 串行入档入站消息（`packages/plugin-agent/src/index.ts:419, 1573-1603`），并用 `saveMessage` 回档 assistant 产物（`:1484-1487`）。
- `plugin-adapter-onebot`：`archiveNotice` 入档群事件（`:709-712`）；`findByMessageId` 反查引用原文（`:926-929`）；`saveMessage` 入档投递失败提示（`:2265, 2275`）。
- `plugin-flow-control` / `plugin-trigger-policy`：把被流控/策略「吞掉」的入站消息做 **shadow 归档**（`plugin-flow-control/src/index.ts:244-253`，`plugin-trigger-policy/src/index.ts:103-112`）。
- `plugin-image-sender`：`saveMessage` 回档发出的图片/语音/视频占位（`:326-352`）。
- `plugin-subtask` / `plugin-memory-summary`：`saveMessage` 写系统/摘要条目（`plugin-subtask/src/index.ts:683-703`，`plugin-memory-summary/src/index.ts:352, 570`）。
- `plugin-user-profile`：不直接调服务，而是监听 `inbound:message:archived` 事件做后台事实提取（`:1801`）。

## 4. 写一个 provider

最小必须实现：`saveMessage` + `archiveIncoming`。可选：`archiveNotice`（不实现则 OneBot 等 `if (!archive?.archiveNotice) return;` 静默跳过）、`findByMessageId`（不实现则引用反查回退到平台重新拉取）。消费方一律先判 `archive?.method` 再调，所以漏实现可选方法不会崩，只是降级。

依赖：归档必须落到某个持久层。参考实现用 `memory`（`required`）+ `media`（`optional`，仅做附件识别）。

manifest 双源必须同步写（`package.json` `aalis.service` 与源码 `export const`）：

```jsonc
// package.json
{
  "aalis": {
    "service": {
      "required": ["memory"],
      "optional": ["media"],
      "provides": ["message-archive"]
    }
  }
}
```

可编译最小骨架：

```ts
import type { Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';

export const name = '@aalis/plugin-my-archive';
export const inject = { required: ['memory'] };          // 与 package.json 双源同步
export const provides = ['message-archive'];

export function apply(ctx: Context): void {
  // 懒查：provider 重载后裸引用会失效，禁止在 apply 时缓存（见 §5）
  const getMemory = (): MemoryService => {
    const m = ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('message-archive 需要 memory 服务');
    return m;
  };

  const service: MessageArchiveService = {
    async saveMessage(sessionId, message) {
      await getMemory().saveMessage(sessionId, message);
    },
    async archiveIncoming(incoming: IncomingMessage) {
      const content = incoming.content;                  // 你自己的烘焙逻辑放这
      const message: Message = { role: 'user', content, timestamp: Date.now() };
      await getMemory().saveMessage(incoming.sessionId, message);
      // 落库后必须发事件，否则 user-profile 等后台消费者收不到
      ctx
        .emit('inbound:message:archived', { sessionId: incoming.sessionId, incoming, archivedMessage: message })
        .catch(err => ctx.logger.debug(`inbound:message:archived 分发失败: ${err}`));
      return { message, content };
    },
  };

  ctx.provide('message-archive', service);
}
```

注册要点（参考 `docs/concepts/service-model.md`）：

- `priority`：默认 `ServicePriority.Backend=0`。要覆盖内置归档实现时用 `Override=50`（裸数字是允许的——`service-helpers.ts:56-66` 仅 `logger.debug` 记一笔、不告警，注释明确把裸数字当作细粒度预留滩位的合理设计，不强制用枚举；自定义数值须自行记载其含义以便下游推断胜者）。同名竞争胜者 = 偏好 > priority(Backend0/Override50/System200) > 注册顺序。
- `entryId`：单实例服务无须分桶；若一个插件按子来源拆多个归档实例，用 `entryId: '${ctx.id}/${sub}'`（见 `docs/concepts/manifest-metadata.md`）。
- `label`：可选展示名，便于 WebUI 服务面板辨识。

## 5. 标准消费姿势

**永远 lazy `getService()`，不要缓存裸引用。** memory provider bounce/重载会让缓存引用失效，缓存还会让你被级联 dispose。参考实现在每个方法体里现查 `memory`（`packages/plugin-message-archive/src/index.ts:89-95` 的注释把这条说透了），消费方同理：

```ts
const archive = ctx.getService<MessageArchiveService>('message-archive');
if (!archive) return;                       // 服务缺失：优雅降级，不要抛
await archive.archiveIncoming(message);
```

- 把 `message-archive` 放进 `inject.optional`（所有现有消费方都这么做），缺失时降级而非崩溃。
- 调可选方法先判存在：`if (archive?.archiveNotice)` / `if (archive?.findByMessageId)`（`plugin-adapter-onebot/src/index.ts:710, 927`）。
- 错误边界：归档失败不应阻断主链路。所有消费方都 `try/catch` 后 `logger.warn` 吞掉（如 `plugin-agent/src/index.ts:1596-1602`、两处 shadowArchive）。

详见 `docs/concepts/lazy-service-access.md`。

## 6. 串行归档契约（重点 / 审计项）

`archiveIncoming` **不是天然有序的**。`memory.saveMessage` 是异步写，多条入站消息若并发 `await archiveIncoming(...)`，落库顺序取决于各自 await 的完成时机——会出现**乱序归档**：后到的消息先落库，下一轮拉历史时漏看前一条输入，或时间线错乱。

主链路用一条 **per-lane 串行队列**解决（`plugin-agent` 权威实现，`packages/plugin-agent/src/index.ts:1573-1589`）：

```ts
private async archiveIncomingMessageInOrder(lane: string, incoming: IncomingMessage) {
  const previous = this.archiveQueues.get(lane) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => this.archiveIncomingMessage(incoming));
  const tail = current.then(() => undefined, () => undefined);
  this.archiveQueues.set(lane, tail);                  // 把队尾接上，强制同 lane 顺序执行
  try { return await current; } finally {
    if (this.archiveQueues.get(lane) === tail) this.archiveQueues.delete(lane);
  }
}
```

- **lane key**：`${sessionId}::${source ?? 'user'}`（`:118-122`）——同会话同来源共用一条 lane，串行；不同来源（如用户输入 vs proactive 注入）互不阻塞。
- 设计意图见 `MEMORY` 注释「同一 lane 的入站消息归档串行化，避免连续消息读取历史时漏掉前一条输入」（`:67`）。

> ⚠️ **审计 caveat——绕过串行队列的 shadow 归档会乱序。**
> `plugin-flow-control` 与 `plugin-trigger-policy` 直接 `await archive.archiveIncoming(message)`（`plugin-flow-control/src/index.ts:249`、`plugin-trigger-policy/src/index.ts:108`），**没有经过 `archiveIncomingMessageInOrder` 的 per-lane 队列**。当 shadow 归档与 agent 主链路归档落在同一 `sessionId`/`source` 上并发触发时，两条写入彼此无序，可能造成归档时间线乱序（后吞的消息先落库、连续消息漏看前一条）。
>
> 现状：服务契约本身**不提供**跨调用方的串行保证——有序性是 `plugin-agent` 在消费侧自建的，且队列状态私有，shadow 路径触达不到。
> 规避：
> 1. **provider 侧**（推荐根治）：在实现内部用 per-`sessionId` 队列对 `saveMessage`/`archiveIncoming` 的落库做串行化，让有序性变成服务的硬保证，所有调用方（含 shadow）自动受益。
> 2. **consumer 侧**：任何旁路归档都应复用主链路的 lane 串行机制，而不是裸 `await archiveIncoming`。
> 3. `Message.timestamp` 都取 `Date.now()`（`plugin-message-archive/src/index.ts:162`），毫秒级近邻消息可能撞同值——下游排序不要只靠 timestamp，需保留落库顺序。

## 7. 能力 / 风险 → 影响

- **跨会话隔离**：`sessionId` 是唯一隔离维度，provider 必须严格按 `sessionId` 分桶落库，绝不能把 A 会话的消息写进 B。proactive 跨会话委派被特殊标成 `role:'notice'` + `kind:'cross-session-delegation'`，避免 B 回看历史时把派发任务误读为「曾有用户说过」（`:155-159`）。
- **审计溯源**：`archiveIncoming` 把 `triggerType` / `source` 写进 `metadata`（`:147-148`），用于区分真实用户消息 vs 系统注入，是事后审计「agent 在某群做过什么」的依据。provider 应保留这些字段。
- **本服务无 authority/SSRF/沙盒语义**：它不发起网络请求、不做权限判定。但若你的归档实现要落到外部存储，写文件请走 `storage` 的 `'<root>:/path'` 文法（注意 storage 不是沙箱，见 `docs/concepts/storage-uri-grammar.md`），拉远端资源请走 `safeFetch`（SSRF 防护，见 `docs/concepts/security-model.md`）。
- **附件富信息**：`archiveIncoming` 是图片/语音/视频描述合入对话文本的唯一入口（`:70-79`）。文件附件已被 `plugin-file-reader` 替换 `att.data` 为 `aalis-file://ID`，归档只保留 `att.name` 进 `metadata.fileNames`，避免 inline 内容污染气泡显示（`:138-144`）。

## 8. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)、[懒服务访问](../concepts/lazy-service-access.md)、[manifest 元数据](../concepts/manifest-metadata.md)、[消息-LLM 管线](../concepts/message-llm-pipeline.md)、[安全模型](../concepts/security-model.md)、[storage URI 文法](../concepts/storage-uri-grammar.md)
- 核心：[service](../core/service.md)、[context](../core/context.md)、[events](../core/events.md)、[types](../core/types.md)
- 相关服务/契约：`@aalis/plugin-memory-api`（落库后端）、`@aalis/plugin-media-api`（附件识别）、`@aalis/plugin-message-api`（`Message` / `IncomingMessage` / `WellKnownKinds` / `inbound:message:archived` 事件）
