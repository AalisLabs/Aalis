# api-memory — 对话历史与元数据存储契约

**包名**: `@aalis/api-memory`  
**源码**: `packages/api-memory/src/index.ts`  
**实现**: `@aalis/plugin-memory-inmemory`, `@aalis/plugin-memory-sqlite`, `@aalis/plugin-memory-mongodb`

## 概述

`MemoryService` 是 Agent 的"长期记忆"——保存每轮 Message、按 sessionId 检索历史、提供结构化元数据 K/V 存储。可以同时装载多个实现，但每个消费方的 `memory` 只选中一家；语义检索由 `plugin-memory-vector` 经 vectorstore 另行提供，不是 `MemoryService` 的实现。描述符 `memory` 不给 bind，业务层就是 `MemoryService` 形状的活句柄（`caps.memory.use`），选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。

## 核心方法

```ts
interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  archiveSpan(sessionId: string, span: { count: number; keep: readonly number[] }): Promise<number>;
  clearAll?(): Promise<void>;
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>;
  countHistory?(sessionId: string): Promise<number>;
  getMessagesBySessionRange?(
    sessionId: string,
    fromTs: number,
    toTs: number,
    roles?: Array<Message['role']>,
    excludeKinds?: string[],
  ): Promise<Message[]>;
  getRecentMessagesAcrossSessions?(query: RecentMessagesAcrossSessionsQuery): Promise<RecentMessageRecord[]>;

  saveMetadata(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  getMetadata(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  listMetadata(namespace: string): Promise<MetadataEntry[]>;
  listMetadataKeys?(namespace: string): Promise<string[]>;
  deleteMetadata(namespace: string, key: string): Promise<void>;
  commitMetadata(ops: readonly MetadataOp[]): Promise<void>;

  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
  deleteMessagesByTimestamps?(sessionId: string, timestamps: number[]): Promise<number>;
}
```

- **带条数的读法**（`getHistory`、`getFullHistory` 的 `limit`，`getRecentMessagesAcrossSessions` 的 `query.limit`，`updateMessageContent` 的 `recentLimit`）一个规则：条数是非负整数或 `Infinity`（调用方保证），为 0 时返回空（`updateMessageContent` 一条都不改），为 `Infinity` 时返回全部（跨会话查询照样收窄到后端配置的上限）。
- **`getHistory`**：最近 `limit` 条活跃（未归档）消息。
- **`countHistory`**：活跃消息的条数，与 `getHistory(sessionId, Infinity)` 的长度相同。可选：缺了它，plugin-agent 读全部活跃历史再数。
- **`archiveSpan`**：把最早的 `count` 条活跃消息（顺序与 `getHistory` 相同：时间，同毫秒按写入序；inmemory 只按写入序，假定时间戳随写入递增）标为归档，其中 `keep` 列出的位置（这一段里从 0 数的下标）不归档、原样留在活跃历史里；返回归档条数。必填：压缩靠它落定，缺了没有降级可走。
  - `count` 与 `keep` 的元素都是非负整数（调用方保证），`count` 为 0 时什么都不归档；大于活跃条数时这一段就是全部活跃消息。`keep` 里落在这一段之外的下标不起作用，重复的下标与一个相同。
  - 位置按调用这一刻的活跃历史算。调用方读快照之后若有写入插进这一段（时间戳早于段尾的晚到消息、按时间戳删除），归档的会错位：调用方要在调用之前核对快照。之后追加的新消息在这一段之外，不受影响。
  - 原子性按后端分档（与 `commitMetadata` 同一口径）：sqlite 与 inmemory 全成或全不成；mongodb 是一次 `updateMany`，不是事务，中途出错时可能只归档了一部分。
  - 归档的消息不再进 `getHistory`；`getFullHistory` 照样有，按原来的顺序（留下的与归档的照时间交错）。

## 消费方式

```ts
import { memory } from '@aalis/api-memory';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-memory',
  uses: { memory },
  apply({ memory }) {
    if (!memory.present) return;
    void memory.use.getHistory('session-1', 20);
  },
});
```

## 跨会话取料的范围

没有共享的召回范围：跨会话取料的插件各有自己的范围字段，都标成可按会话覆盖（[api-session-settings](./api-session-settings.md)），值就是这个会话取料的上限，只有 owner 能改：

| 插件 | 字段 | 取值 |
|---|---|---|
| [plugin-memory-history](../plugins/plugin-memory-history.md) | `scope` | `session`、`same-platform`、`cross-platform` |
| [plugin-memory-vector](../plugins/plugin-memory-vector.md) | `crossSessionMode` | `isolated`、`user`、`platform`、`all` |
| [plugin-tool-session](../plugins/plugin-tool-session.md) | `scope` | `current`、`platform`、`all` |
| [plugin-user-relation](../plugins/user-relation.md) | `recallScope` | `session`、`all` |

四个字段都标 `onInvalid: 'error'`：某一层写坏了的值原样交给插件，插件按最窄处理，不回落到更宽的层。后装的记忆插件按它自己的作者默认取，已经设好的收窄管不到它，要另外设。

## 压缩服务

```ts
import { compression } from '@aalis/api-memory';

interface CompressionService {
  compress(sessionId: string, request: { reason: 'manual' }): Promise<void>;
  compressAt(sessionId: string, platform?: string): number | undefined;   // 这个会话的自动压缩线（占窗口比例），0 时为 undefined
}
```

服务名 `compression`。压缩把切分点之前的全部活跃历史压成一份摘要，摘要模型挑出的原文原样留在活跃历史里、接在摘要之后，切分点之后到达的消息再接在它们后面，提供方是 [plugin-memory-summary](../plugins/plugin-memory-summary.md)。

- **`compress`**：`manual` 是 owner 手动，短对话也完整压一次。压成才落定；没压成时以原因拒绝（这个会话正在压缩、记忆或摘要模型不在、模型失败、期间被清空或历史被改动）。没有可压的对话（历史为空、只剩分隔标记）时什么都不做，照常落定。用量或会话条数到线的自动压缩由提供方在后台自己发起，不经这个方法。
- **`compressAt`**：与 api-agent 的 `token:usage` 里 `usageRatio` 同一口径，按会话取。实际在它与裁剪预算占窗口的比例（`tokenBudget / contextWindow`）中较小的那个上压缩（见下文「触发判定」的 `compressionLine`），界面的压缩线取这个较小值。`platform` 是入口平台：没有出生平台的会话按它选平台档。
- **进度**：事件 `session:compressing { sessionId, status: 'start' | 'done' | 'error' }`，会话服务转成时间线上的压缩通知。只在真的开始压时报：`start` 之后压成报 `done`、没压成报 `error`；什么都不做的与开始之前就失败的（记忆不在、读不出历史）不报。
- **使用方**：[plugin-session-server](../plugins/plugin-session-server.md) 的 `session/compress` 调它，功能位的「压缩」与用量条目的 `compressAt` 看它在不在。

### 触发判定

```ts
interface CompressionUsage {
  used: number;            // 这次调用的输入量（token）
  contextWindow: number;   // 所用模型的上下文窗口（token）
  tokenBudget: number;     // 硬裁剪的上限（token）
  compressible: number;    // 历史与工具结果占的 token，按硬裁剪之前的列表算：全量压缩能压掉的部分
  trimmed: boolean;        // 经过了硬裁剪：到了丢内容的地步
  historyMessages: number; // 会话历史的条数
}
interface CompressionLines {
  compressAt?: number;     // 自动压缩线，占窗口比例；缺省或 0 不按用量判
  historyLimit?: number;   // 条数线；缺省或 0 不按条数判
}

function compressionLine(
  usage: Pick<CompressionUsage, 'contextWindow' | 'tokenBudget'>,
  compressAt: number | undefined,
): number;
function compressionDue(usage: CompressionUsage, lines: CompressionLines): boolean;
```

`compressionLine` 是用量一维的压缩线（token）：`compressAt` 为正时是 `min(compressAt × contextWindow, tokenBudget)`，压缩线写得比裁剪预算还高时以裁剪预算为准，压缩先于硬裁剪；`compressAt` 缺省或为 0 时取 `tokenBudget`，这时它只是上限、不是触发线（`compressionDue` 不按用量判）。

`compressionDue` 是判定是否该压缩的纯函数，两维任一到线即该压缩。

- **用量一维**：`compressAt` 为正时，用量到 `compressionLine` 或经过了硬裁剪（`trimmed`：到了丢内容的地步），且 `compressible` 至少是线的一半时该压缩。后一个条件就是回差：压完 `compressible` 只剩挑中的原文（token 默认不超过这次新压的对话的一成）与切分点之后的几条，一般到不了线的一半，不会接着再触发（留下得多、很快又到线时，下一次压缩的输入大半就是它们，留下的随之变少）；人设、工具定义这些压不掉的部分再大也不会让它空转。`compressAt` 缺省或为 0 时这一维不判，经过了硬裁剪也一样。
- **条数一维**：`historyMessages` 到 `historyLimit` 时该压缩。全量压缩之后只剩挑中的原文、切分点之后的几条与分隔标记，挑中的原文只留到三者合计不超过条数线的一半（向下取整）为止，一般要再积累条数线的一半左右才会再到线。

没压成之后多久再试由调用方决定，不在这个函数里。

## 钩子与贡献点

经 declaration merging 注入 `@aalis/api-hooks` 的 `HookContextMap`（见 [api-hooks](./api-hooks.md)）与 `@aalis/api-contributions` 的 `ContributionPointMap`（见 [api-contributions](./api-contributions.md)）：

```ts
'memory:clear': {
  scope: 'session' | 'all';
  types?: string[];
  sessionId?: string;
  results: Array<{ source; type?; success; message }>;
}

'memory:clear-type': ClearTypeContribution; // { id: string; label: string | TextRef }
```

`plugin-memory-summary` / `plugin-memory-vector` 等通过订阅此钩子统一参与"清空对话"操作。

清空之后要连带做事的中间件在 `next()` 之后用 `historyCleared(data)` 判：这次清了消息历史（没指定类型或类型含 `context`），且结果里消息历史的各行（`type` 为 `context`）都清成了；消息历史没清成就不动。会话管理据此删掉被清空会话的子会话，子任务插件据此清掉父会话记录上的回报。`clearAll` 只清消息与归档、不清元数据：在元数据里存了数据的插件，要挂这个中间件按 `scope` 与 `types` 清理自己的命名空间。结果行的 `type` 是这一行所属的清理类型。处理某个清理类型的插件经贡献点 `memory:clear-type` 登记它（`id` 是类型名，即 `/clear -t` 的写法与结果行的 `type`；`label` 是显示名，可以是文字对象），并在各行标注它，成败都标：`/clear` 只认登记了的类型，帮助按登记表列出（同一类型几家登记时显示名取收集次序里第一家的），并据结果行判断显式指定的类型有没有处理者，不标注会被回执误报为「没有已启用的插件处理」。只在清理全部会话时清的数据（跨会话的，如用户档案、关系图），由处理它的插件在会话级清理、`types` 显式含它时自己推一行未清理的结果（`success: false`，写明是跨会话数据）；不带类型的会话级清理（含删除会话）不推。

整体清空自己的命名空间用 `clearMetadataNamespaces(mem, namespaces, logger)`，它在一次 `commitMetadata` 里删掉这些命名空间的全部条目，返回各命名空间删掉的键（与传入顺序相同）。`listMetadata` 会跳过读不出的条目（数据损坏、不是对象），按它枚举键删不掉这些条目；后端实现了只列键的 `listMetadataKeys` 时，这个函数按它列键，读不出的条目一并删除、计入返回的键，并经 `logger` 记一条 info 点名（`namespace/key`，超过 10 条只列前 10 条）。后端没有实现时退回 `listMetadata`，读不出的条目留在库里。

## 记忆变更事件

落库之后动了已有消息的一方发通知，事件经 declaration merging 注入 `@aalis/core` 的 `AalisEvents`：

```ts
'memory:messages-deleted':   [payload: { sessionId: string; timestamps: number[] }]
'memory:messages-rewritten': [payload: { sessionId: string; messages: Message[] }]
'history:changed':           [payload: { sessionId: string }]
```

- `memory:messages-deleted`：某会话的若干消息被按时间戳删除（回滚），由动手的检查点发。
- `memory:messages-rewritten`：某会话已落库的消息正文被改写（`updateMessageContent`），由改写的一方在改写成功后发，`messages` 是改写后的整条（时间戳不变）。第一方的发出方有两个：message-archive 给她发出的网址图片与视频补上识图描述（见 [plugin-message-archive](../plugins/plugin-message-archive.md)），media 的 `update_image_description` 写回描述。建派生索引的下游按会话与时间戳换掉旧条目：plugin-memory-vector 删掉旧条目，删到了才按改写后的正文重收录。
- `history:changed`：会话历史发生结构性变化，会话服务据此通知订阅的客户端重新取快照。

三个事件的负载都带会话 id，不能当编排的触发源。

## 实现者

- [@aalis/plugin-memory-inmemory](../plugins/plugin-memory-inmemory.md) — 进程内 Map
- [@aalis/plugin-memory-sqlite](../plugins/plugin-memory-sqlite.md) — 持久化（默认）
- [@aalis/plugin-memory-mongodb](../plugins/plugin-memory-mongodb.md) — 远端
- [@aalis/plugin-memory-vector](../plugins/plugin-memory-vector.md) — 向量检索（消费方，非实现方；提供 `semantic-memory`，依赖 embedding + vectorstore）
- [@aalis/plugin-memory-summary](../plugins/plugin-memory-summary.md) — 压缩摘要插件（消费方，非实现方）

## 相关

- 协议层 `Message` 在 `@aalis/schema-message`
- 向量检索见 [api-vectorstore](./api-vectorstore.md)
