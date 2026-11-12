# message-archive 服务

## 1. 定位

把**原始入站消息流 + 我方出站富文本 + 平台 notice 事件**持久化成 `Message` 历史条目，写入底层 `memory` 服务，供后续上下文渲染、向量检索、引用回复反查、用户档案事实提取等场景消费。它是「消息文本最终成形（发送者前缀 / 引用回复 / 图片描述 / 附件名）」的**唯一烘焙入口**——预处理器只写元信息，content 的拼接全在归档阶段一锤定音。

- 服务注册名：`'message-archive'`（描述符 `messageArchive`，消费方经 `messageArchive.use` 调用）
- 契约包：`@aalis/api-message-archive`
- 参考实现：`@aalis/plugin-message-archive`

`message-archive` 本身不持久化，它委派给 `memory`（必需依赖）。它是 `memory` 之上的「会话语义层」——把会话身份、附件描述、触发来源等烘焙进 `Message.content` 与 `metadata`，让 `memory` 这个纯 KV/向量层不必理解平台语义。

## 2. 契约

契约接口（`packages/api-message-archive/src/index.ts`）：

```ts
export interface MessageArchiveService {
  saveMessage(sessionId: string, message: Message, options?: { debugLabel?: string }): Promise<void>;
  /** 空闲开话题的提示（triggerType 为 idle）不落档，回 undefined */
  archiveIncoming(message: IncomingMessage, turn?: { turnId: string; entry: 'opened' | 'joined' }): Promise<ArchiveIncomingResult | undefined>;
  /** 按送达的快照把出站消息记进会话历史，所有平台一条规则；全部记录写完才兑现，写失败时以原因拒绝 */
  recordOutbound(message: OutgoingMessage): Promise<void>;
  /** 平台 notice/事件入档（系统级条目，不会触发 agent 响应） */
  archiveNotice?(options: ArchiveNoticeOptions): Promise<Message | null>;
  /** 在指定会话最近 scanLimit 条历史中查找 metadata.messageId 命中的归档消息，缺省 scanLimit=100 */
  findByMessageId?(sessionId: string, messageId: string, scanLimit?: number): Promise<Message | null>;
}
```

方法语义：

- **`saveMessage`**（必需）：直写一条已成形的 `Message` 到指定会话。最薄的一层——直接转发给 `memory.saveMessage`，`options.debugLabel` 仅用于按配置打调试日志（`packages/plugin-message-archive/src/index.ts`）。role 为 `assistant`、有正文且不带工具调用的落库后发 `assistant:message:archived`。用于写已成形的条目（如 agent 的回复、subtask 的系统提示、投递失败提示）。
- **`archiveIncoming`**（必需，核心）：接收一条 `IncomingMessage`，做完整烘焙——调用 `media` 识别附件（消息尚无附件描述时；对传入的消息对象调用，识别结果写回入参，触发判定已启动的识别在这里命中，不再识别第二遍）、拼接发送者前缀 / 引用回复 / 附件描述（拼法是 `@aalis/schema-message` 的 `buildIncomingContent`，说话人按本包的 `speakerOf` 给，见下）、从发言人自己写的话里抽取 @提及（schema-message 的 `extractMentions`，记成 `Mentions`）、写会话身份 `metadata`；给了 `turn`（agent 开轮或插入时给）时另记它进的这一轮：回合 id 与进入方式（`opened` 开轮、`joined` 插进在跑的一轮）记成登记的键 `TurnId`、`TurnEntry`，没进一轮的（被触发判定或流控吞掉的影子归档）不给；平台事件合成的入站带 `IncomingMessage.text` 时记进元数据 `Text`（参数截到 200 字），带 `noticeType` 时 `kind` 记成它，role 仍是 `user`，读历史的一方据此画成通知；落库后**发出 `inbound:message:archived` 事件**，返回最终 `Message` + content（`packages/plugin-message-archive/src/index.ts`）。空闲开话题的提示（`triggerType: 'idle'`）不落档：它是写给模型的话，不是谁的发言，也不是要留档的事件；回 `undefined`、不发事件，agent、流控与触发插件不必各自挡。
- **`recordOutbound`**（必需）：出站消息记进会话历史的唯一实现，所有平台一条规则。不是她回复的文字记成事件标记（`outboundMarkerMessage`）；附件逐个记、不分来源与种类，按有没有地址分（`outboundAddress`：`ref`，没有时 `data` 是存储地址或网址的取 `data`），有地址的按 `outboundMediaMessage` 记（她发的 role `assistant`，插件发的 role `notice`），元数据带 `SentRef`（文件另带 `SentName`），没有地址的（data URL、`file://` 与本机路径）记成事件标记「[种类] 名字」（`unaddressedText`）并带同一句的文字对象。每条记录带出站的 `Source`、`TurnId`、`CallId`（有才记），同一会话里出站记录的时间戳各不相同。图、音、视频的描述取附件带的，发出即记、不等识图；参考实现给她发的、没带描述的网址图片与视频在后台补描述，补到后经 `memory.updateMessageContent` 改写那一条并发 `memory:messages-rewritten`，记忆后端不支持改写时不补。全部记录写完才兑现（不等后台的识图），写失败时以原因拒绝，已写成的几条不撤回。要记的内容在调用时同步取走：调用之后对消息的改写不算，调用方不必另做快照。
- **`archiveNotice?`**（可选）：把平台 notice/事件（禁言、撤回、入群等）作为 `role:'notice'` 系统条目入档，`kind` 取 `noticeType`。返回 `null` 表示内容为空被跳过。
- **`findByMessageId?`**（可选）：按平台侧 `messageId` 在最近 `scanLimit`（夹取 1..500，缺省 100）条历史里从新往旧反查归档原文，命中我方已烘焙的富文本（含图片描述）。未命中返回 `null`。

重要类型（同文件）：

- `ArchiveIncomingResult { message: Message; content: string }`——`message` 是落库实体，`content` 是烘焙后的纯文本。
- `ArchiveNoticeOptions`：`sessionId` / `noticeType` / `content` 必填（`content` 为人类可读描述，作为 system 消息正文写入）；`text?` 是给人看的那句（文字对象，`content` 写它按原文渲染的整句），记成元数据 `Text`，界面按读者语言显示；`subType` / `platform` / `userId` / `targetId` / `groupId` / `operatorId` / `timestamp` / `data` 可选，`data` 整体透传进 `metadata`。字段语义对齐 OneBot v11/v12 notice 规范。
- `Message`（来自 `@aalis/schema-message`，`packages/schema-message/src/index.ts`）：`role` + `content: string | null` + 可选 `name` / `kind` / `timestamp` / `metadata`。
- `inbound:message:archived` 事件 payload（`packages/schema-message/src/index.ts`）：`{ sessionId, incoming: IncomingMessage, archivedMessage: Message }`。注意 `archivedMessage.content` 可能已不同于 `incoming.content`（已烘焙）。

> `@aalis/api-message-archive` 是契约包（keywords 含 `aalis-api`），导出类型、`messageArchive` 描述符（`defineService<MessageArchiveService>('message-archive')`）、入站正文的说话人 `speakerOf` 与 `recordOutbound` 记法里的两样：`outboundAddress(att)`（出站附件的地址，没有时 `undefined`）与 `unaddressedText(att)`（没有地址的附件记成的那一句，文字对象）。发送前要改写 `data` 的适配器（如 onebot 换成自己落盘的副本）先按 `outboundAddress` 把原来的地址留在 `ref` 上；会话服务的实时推送按这两样给出与历史相同的通知。运行时服务由 `plugin-message-archive` 提供。

**发送者前缀**：`speakerOf(incoming, { sessionManager?, authority? })` 给出入站正文前缀里的说话人（交给 `buildIncomingContent`），存档、触发判定（plugin-trigger-laya 发给侧车的当前消息）与 agent 在存档不在时自己拼的当轮正文都按它，判定方看到的与存档逐字一致。两个服务按调用方可选依赖的在场情况给，依次：

1. 带 `source` 的（子任务、定时任务、编排、宿主通知、平台事件合成的通知等内部注入）不给：不是任何人的发言；
2. 根会话的受众只有 owner（api-session-manager 的 `roomClass` 为 `owner-only`：owner 自己的 IM 私聊，WebUI、终端与第三方客户端建的会话）时不给；
3. 从别的平台往房间里插话（入口平台不是根会话的出生平台，如 owner 从 WebUI 往群里发）、授权身份（`actor`，没有时取物理身份）是 owner 时，给 owner 在出生平台登记的账号（权限服务的 `ownerOn`，前缀写成 `[账号]: `，没有昵称），没登记时给这条消息自己的身份；
4. 其余给这条消息自己的昵称与账号。

会话管理不在时第 2、3 条判不出，按第 4 条（WebUI 的消息也带 `[console]: `）；权限服务不在时没有人是 owner。加了前缀时，存档把这次用的标签记进元数据的 `SenderLabel`：把归档文本重排给模型或界面看的一方（向量记忆的召回片段、OneBot 的撤回摘录与引用反查）按它用 schema-message 的 `stripSenderPrefix` 去掉这一层（owner 从别的平台插话时前缀写的是 owner 在出生平台登记的账号，与这条消息自己的身份不同；正文自己以 `[..]: ` 开头的不动）。

## 3. 谁提供 / 谁消费

**提供方**：`@aalis/plugin-message-archive`，在 `apply` 末尾 `provide.use(messageArchive, service)`（`packages/plugin-message-archive/src/index.ts`）。manifest 见 `package.json` 的 `aalis.service.provides: ['message-archive']` + 源码 `provides: [messageArchive]`。

**典型消费点**（全部先看 `messageArchive.present` 再经 `messageArchive.use` 调用，且都列为 `uses optional`）：

- `plugin-agent`：主链路。输入在进入一轮时经 `archiveIncoming` 归档（带回合 id 与进入方式），禁言、停机与全部停止放掉的在那一轮落定之后归档（不带回合 id，会话删除与清消息历史放掉的不归档），并用 `saveMessage` 回档 assistant 产物（`packages/plugin-agent/src/index.ts`）。
- `plugin-adapter-onebot`：`archiveNotice` 入档群事件；`findByMessageId` 反查引用原文；`saveMessage` 入档投递失败提示（一处）。
- `plugin-flow-control` / 触发插件（`plugin-trigger-policy` 等）：把被流控/触发判定「吞掉」的入站消息做 **shadow 归档**（`plugin-flow-control/src/index.ts`；触发插件经 `api-trigger/src/index.ts` 的 `archiveSwallowed`）。
- `plugin-webui-server`：发往 WebUI 自己会话的出站消息经 `recordOutbound` 记进历史，记成了回执才算送达（WebUI 的收件箱就是会话历史）。
- `plugin-subtask` / `plugin-memory-summary`：`saveMessage` 写系统/摘要条目（`plugin-subtask/src/index.ts`，`plugin-memory-summary/src/index.ts`）。
- `plugin-user-profile`：不直接调服务，而是监听 `inbound:message:archived` 事件做后台事实提取。

## 4. 写一个 provider

最小必须实现：`saveMessage` + `archiveIncoming` + `recordOutbound`。可选：`archiveNotice`（不实现则 OneBot 等 `if (!archive?.archiveNotice) return;` 静默跳过）、`findByMessageId`（不实现则引用反查回退到平台重新拉取）。消费方一律先判 `archive?.method` 再调，所以漏实现可选方法不会崩，只是降级。

依赖：归档必须落到某个持久层。参考实现用 `memory`（`required`）+ `media`（`optional`，仅做附件识别）。

入站正文的发送者前缀照参考实现调 `speakerOf` 再交给 `buildIncomingContent`：触发判定拼的当前消息按同一规则，两边不一致时判定看到的与历史里存下的那条不同。加了前缀时记下 `SenderLabel`，否则读的一方去不掉前缀；`Mentions` 用 `extractMentions` 从入站消息的 `content` 抽。空闲开话题的提示（`triggerType: 'idle'`）回 `undefined`、不落档。

出站：参考实现另监听两个事件，替换实现要同样做（见下面的骨架），否则房间、终端与子会话里发出的消息不落库，只在实时推送里：

- `outbound:delivered`：适配器送达之后发的快照，调 `recordOutbound` 记进会话历史，写失败记 warn，不阻塞同一事件的其它监听。
- `outbound:message`：子会话没有窗口，任何适配器都不认领它的出站。还没人认领（`delivery` 未设）、会话记录有 `parentId` 的同步认领，回执取 `recordOutbound(msg)`：兑现回 `ok`，拒绝回 `ok: false` 带原因。会话管理不在时判不出，不认领。

manifest 双源必须同步写（`package.json` `aalis.service` 与源码 `export const`）：

```jsonc
// package.json
{
  "aalis": {
    "service": {
      "required": ["memory"],
      "optional": ["media", "session-manager"],
      "provides": ["message-archive"]
    }
  }
}
```

可编译最小骨架：

```ts
import { events } from '@aalis/api-events';
import { memory } from '@aalis/api-memory';
import { messageArchive, outboundAddress } from '@aalis/api-message-archive';
import type { MessageArchiveService } from '@aalis/api-message-archive';
import { sessionManager } from '@aalis/api-session-manager';
import { definePlugin, logger, optional, provide } from '@aalis/core';
import {
  type IncomingMessage,
  type Message,
  type OutgoingMessage,
  outboundMarkerMessage,
  outboundMediaMessage,
  WellKnownMetadataKeys,
} from '@aalis/schema-message';

export default definePlugin({
  name: '@aalis/plugin-my-archive',
  provides: [messageArchive],
  uses: { provide, events, logger, memory, sessionManager: optional(sessionManager) },
  apply({ provide, events, logger, memory, sessionManager }) {
    const service: MessageArchiveService = {
      async saveMessage(sessionId, message) {
        await memory.use.saveMessage(sessionId, message);
      },
      async archiveIncoming(incoming: IncomingMessage) {
        // 空闲开话题的提示不落档
        if (incoming.triggerType === 'idle') return undefined;
        const content = incoming.content;
        const message: Message = { role: 'user', content, timestamp: Date.now() };
        await memory.use.saveMessage(incoming.sessionId, message);
        events.use
          .emit('inbound:message:archived', {
            sessionId: incoming.sessionId,
            incoming,
            archivedMessage: message,
          })
          .catch(err => logger.use.debug(`inbound:message:archived 分发失败: ${err}`));
        return { message, content };
      },
      async recordOutbound(msg: OutgoingMessage) {
        // 要记的内容在第一次等待之前取走：调用之后对消息的改写不算
        const { sessionId } = msg;
        const marker = outboundMarkerMessage(msg);
        const records: Message[] = marker ? [marker] : [];
        for (const att of msg.attachments ?? []) {
          const address = outboundAddress(att);
          // 没有地址的：参考实现记成事件标记，正文是 unaddressedText(att)；另有 Source、TurnId、CallId 与时间戳各不相同，见契约说明
          if (address === undefined) continue;
          const desc = att.kind === 'file' ? att.name : att.description;
          const record = outboundMediaMessage(att.kind, address, { desc, source: msg.source });
          records.push({ ...record, metadata: { [WellKnownMetadataKeys.SentRef]: address } });
        }
        for (const record of records) await memory.use.saveMessage(sessionId, { ...record, timestamp: Date.now() });
      },
    };

    provide.use(messageArchive, service);
    // 适配器送达之后发的快照记进会话历史
    events.use.on('outbound:delivered', msg => {
      service.recordOutbound(msg).catch(err => logger.use.warn(`出站消息没能记进会话历史: ${err}`));
    });
    // 子会话没人认领的出站由存档认领
    events.use.on('outbound:message', msg => {
      if (msg.delivery || !sessionManager.present) return;
      if (!sessionManager.use.getSession(msg.sessionId)?.parentId) return;
      msg.delivery = service.recordOutbound(msg).then(
        () => ({ ok: true as const }),
        error => ({ ok: false as const, error: String(error) }),
      );
    });
  },
});
```

注册要点（参考 `docs/concepts/service-model.md`）：

- `priority`：默认 `0`。要覆盖内置归档实现取更高值（数字越大越优先，含义自行记载）。同名竞争时消费方选中哪一家按本插件偏好 > 全局偏好 > priority > 位次。
- `entryId`：单实例服务无须分桶；若一个插件按子来源拆多个归档实例，用 `entryId: '${lifecycle.use.id}/${sub}'`（见 `docs/concepts/manifest-metadata.md`）。
- `label`：可选展示名，便于 WebUI 服务面板辨识。

## 5. 标准消费姿势

`messageArchive.use`、`memory.use` 是活的业务句柄，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。参考实现直接经 `memory.use` 调用（`packages/plugin-message-archive/src/index.ts` 的注释说明了这一点），消费方同理，可选依赖先看 `present`：

```ts
if (!messageArchive.present) return;        // 服务缺失：优雅降级，不要抛
await messageArchive.use.archiveIncoming(message);
```

- 把 `message-archive` 放进 `uses optional`（所有现有消费方都这么做），缺失时降级而非崩溃。
- 调可选方法先判存在：`if (archive?.archiveNotice)` / `if (archive?.findByMessageId)`（`plugin-adapter-onebot/src/index.ts`）。
- 错误边界：归档失败不应阻断主链路。所有消费方都 `try/catch` 后 `logger.warn` 吞掉（如 `plugin-agent/src/index.ts`、两处 shadowArchive）。

详见 `docs/concepts/lazy-service-access.md`。

## 6. 归档的次序（重点）

`archiveIncoming` **不是天然有序的**。`memory.saveMessage` 是异步写，多条入站消息若并发 `await archiveIncoming(...)`，落库顺序取决于各自 await 的完成时机——会出现**乱序归档**：后到的消息先落库，下一轮拉历史时漏看前一条输入，或时间线错乱。

主链路的次序由 `plugin-agent` 的通道层保证（`packages/plugin-agent/src/index.ts`）：每个会话同一时刻最多一轮，输入在进入一轮时归档——开轮的在 `agent:turn:before` 的默认动作开头按入队先后逐条归档，插进来的在插入点逐条归档，禁言、停机与全部停止放掉的在这个会话在跑的一轮落定之后按先后归档（会话删除与清消息历史放掉的不归档）。agent 在一个会话里的写入（输入、工具调用组、回复）都在这一轮的流程里依次发生，不交错；存档次序因此与当时发给模型的次序一致，排着、还没进一轮的输入不在历史里。

> ⚠️ **注意：旁路的 shadow 归档不在这条顺序里。**
> `plugin-flow-control` 与触发插件直接 `await` message-archive 的 `archiveIncoming(message)`（`plugin-flow-control/src/index.ts`、`api-trigger/src/index.ts` 的 `archiveSwallowed`），与 agent 在同一会话里的写入彼此无序：被吞掉的消息若在工具调用组写入期间影子归档，可能落进组中间。
>
> 现状：服务契约本身**不提供**跨调用方的串行保证。
> 规避：
> 1. **provider 侧**：在实现内部用 per-`sessionId` 队列对 `saveMessage`/`archiveIncoming` 的落库做串行化，让有序性变成服务的硬保证，所有调用方（含 shadow）自动受益。
> 2. **读历史侧**（第一方已这样做）：读历史的各方（agent 装载历史、会话服务的时间线、记忆摘要）按 schema-message 的 `groupToolCalls` 归组，夹在工具调用组中间的消息挪到组后。
> 3. `Message.timestamp` 都取 `Date.now()`（`plugin-message-archive/src/index.ts`），毫秒级近邻消息可能撞同值——下游排序不要只靠 timestamp，需保留落库顺序。

## 7. 能力 / 风险 → 影响

- **跨会话隔离**：`sessionId` 是唯一隔离维度，provider 必须严格按 `sessionId` 分桶落库，绝不能把 A 会话的消息写进 B。`triggerType: 'proactive'` 的代发任务（如 workflow 的 agent 节点）被特殊标成 `role:'notice'` + `kind:'cross-session-delegation'`，避免目标会话回看历史时把派发任务误读为「曾有用户说过」。宿主通知（带 `hostNotice`）同理标成 `role:'notice'` + `kind:'host-notice'`，且只归档 `content`：注入方包好的不可信段 `hostNotice.untrusted` 不写进消息与 metadata，provider 也不得把它落库。
- **审计溯源**：`archiveIncoming` 把 `triggerType` / `source` 写进 `metadata`（schema-message 登记的键 `TriggerType`、`Source`），用于区分真实用户消息 vs 系统注入，会话服务据前者标出被点名与插话，也是事后审计「agent 在某群做过什么」的依据。provider 应保留这些字段。
- **本服务无 authority/SSRF/沙盒语义**：它不发起网络请求、不做权限判定。但若你的归档实现要落到外部存储，写文件请走 `storage` 的 `'<root>:/path'` 文法（注意 storage 不是沙箱，见 `docs/concepts/storage-uri-grammar.md`），下载远端资源请走 `safeFetch`（SSRF 防护，见 `docs/concepts/security-model.md`）。
- **附件富信息**：`archiveIncoming` 是图片/语音/视频描述合入对话文本的唯一入口，归档文本给模型看。发言人自己写的话、附件清单与随附的转发另记在 `metadata` 里（schema-message 登记的键 `SpokenContent`、`Attachments`、`Forwards`，见 [schema-message 的「存档元数据的键」](../api/schema-message.md#存档元数据的键)）：发言人写的话只在与归档文本不同时记；附件清单记种类、名字与地址，地址怎么取、转发记什么见 [plugin-message-archive](../plugins/plugin-message-archive.md)。会话服务回看历史与实时推送的提问取这三样，附件描述（含文件读取插件内联的全文）不进气泡。

## 8. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)、[懒服务访问](../concepts/lazy-service-access.md)、[manifest 元数据](../concepts/manifest-metadata.md)、[消息-LLM 管线](../concepts/message-llm-pipeline.md)、[安全模型](../concepts/security-model.md)、[storage URI 文法](../concepts/storage-uri-grammar.md)
- 核心：[service](../core/service.md)、[context](../core/context.md)、[events](../api/api-events.md)、[types](../core/types.md)
- 相关服务/契约：`@aalis/api-memory`（落库后端与 `memory:messages-rewritten` 改写通知）、`@aalis/api-media`（附件识别与补描述）、`@aalis/schema-message`（`Message` / `IncomingMessage` / `OutgoingMessage` / `WellKnownKinds` / `outboundMediaMessage` / `inbound:message:archived` 与 `outbound:delivered` 事件）
