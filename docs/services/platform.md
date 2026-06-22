# platform 服务（平台适配器）

## 1. 定位

`platform` 是 Aalis 的**平台抽象服务**：每个聊天/终端平台（OneBot、CLI、WebUI、Telegram、Discord……）实现一个 `PlatformAdapter` 并以服务名 `platform` 注册。它统一了「查询连接状态 / 按 sessionId 发消息 / 调平台原生 API / 自报机器人身份」这几件事，使核心与其它插件无须知道具体平台细节。

- 服务注册名（DI key）：`'platform'` —— `ctx.getService<PlatformAdapter>('platform')` 取胜者，`ctx.getAllServices('platform')` 取全部（**多 adapter 并存是常态**）。
- 契约包：`@aalis/plugin-platform-api`（`packages/plugin-platform-api/src/index.ts`）。
- 该契约包**既是 runtime 服务契约也带聚合/路由 helper 纯函数**：`PlatformAdapter` 接口是要 `ctx.provide('platform', …)` 注册的真实服务；而 `getPlatform*` / `resolvePlatformBySession` / `sendPlatformMessage` / `callPlatformAction` 等是消费方应优先使用的纯函数 helper（传 `ctx` 即可，没有 entry、无自递归隐患，取代了历史上的 `PlatformRouter` facade，见 `src/index.ts:96-98`）。

> 关键认知：**`platform` 是天然的多实例服务**。同时跑 CLI + OneBot 时，`'platform'` 名下有两个 entry。消费方几乎从不用 `getService('platform')` 取「那个胜者」，而是用 helper 按 `platform` 名或按 `sessionId` 路由到正确的 adapter。

## 2. 契约

### 核心接口 `PlatformAdapter`（`src/index.ts:37-93`）

```ts
export interface PlatformAdapter {
  adapterName: string;                       // 显示名，如 'OneBot' / 'CLI'   (:39)
  platform: string;                          // 平台标识，如 'onebot'/'cli'/'webui'  (:41)
  sessionTypes?: readonly string[];          // 本平台可能发出的 sessionType 枚举（消费方据此生成作用域 UI，勿臆造）  (:50)

  getConnections(): PlatformConnection[];    // 必须：当前所有连接快照  (:52)
  sendMessage(                               // 必须：向某 sessionId 发纯文本  (:54)
    sessionId: string,
    content: string,
    options?: { skipSplit?: boolean },
  ): Promise<void>;

  canHandle?(sessionId: string): boolean | Promise<boolean>;        // 路由用，见下  (:67)
  getSelfIdentity?(sessionId?: string): PlatformSelfIdentity | undefined;  // 自报机器人身份  (:69)
  isReady?(): boolean;                       // 缺省：getConnections() 里有 online 即视为 ready  (:74)
  callAction?(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown>; // 平台原生 API  (:83)
  checkAndRecordProactiveSend?(sessionId: string): { allowed: boolean; reason?: string }; // 主动发送限速闸门  (:92)
}
```

### 重要类型

`PlatformConnection`（`src/index.ts:4-17`）——单条连接状态：`id` / `platform` / `selfId?` / `selfNickname?` / `status: 'online'|'offline'|'connecting'` / `detail?: Record<string, unknown>`。

`PlatformSelfIdentity`（`src/index.ts:20-27`）——机器人自身身份，用于 prompt 注入与归档：`platform` / `selfId?` / `nickname?`。

`PlatformAdapterEntry`（`src/index.ts:102-106`）——helper 返回的条目：`{ instance: PlatformAdapter; contextId: string; label?: string }`。

### 聚合 / 路由 helper（纯函数，传 `ctx`）

| helper | 作用 | 行号 |
| --- | --- | --- |
| `getPlatformAdapterEntries(ctx)` | 枚举所有 adapter 条目（过滤掉没有 `getConnections` 的非法 entry） | `:109-111` |
| `getPlatformAdapters(ctx)` | 枚举所有 adapter 实例 | `:114-116` |
| `getPlatformNames(ctx)` | 枚举所有平台名（`adapter.platform` 去重） | `:119-123` |
| `aggregatePlatformConnections(ctx)` | 聚合所有连接 | `:126-128` |
| `aggregatePlatformDetails(ctx)` | 聚合展示详情（含 `contextId` + `connections`） | `:131-143` |
| `getPlatformSelfIdentity(ctx, platform, sessionId?)` | 按平台名取自身身份 | `:146-156` |
| `resolvePlatformBySession(ctx, sessionId)` | 按 sessionId 找接管它的 adapter（优先 `canHandle`，否则 `startsWith(platform+':')` 兜底） | `:162-176` |
| `sendPlatformMessage(ctx, sessionId, content, options?)` | 按 sessionId 路由发文本（无 adapter 接管则抛错） | `:179-188` |
| `callPlatformAction(ctx, sessionId, action, params)` | 按 sessionId 路由调原生 action（adapter 不支持 `callAction` 则抛错） | `:191-203` |

类型注册（declaration merging）让 `getService('platform')` 自动得到 `PlatformAdapter` 类型：`src/index.ts:206-210`。

## 3. 谁提供 / 谁消费

### 参考实现（provider）

- **OneBot 适配器** `packages/plugin-adapter-onebot/src/index.ts` —— 协议类平台的完整范例：实现了全部可选方法（`getSelfIdentity` `:1127`、`isReady` `:1140`、`callAction` `:1198`、`checkAndRecordProactiveSend` `:1246`），`sessionTypes: ['group','private']`（`:1110`），注册于 `:1335`。还附带若干**非标准扩展方法**（`getSelfMutes` / `getSentMessages` / `handleFriendRequest` 等，`:1263-1326`），通过交叉类型暴露给特定消费者（`plugin-tool-onebot`），见 §6。
- **CLI 适配器** `packages/plugin-cli/src/index.ts:83-99` —— 最小实现的范例：只实现 `adapterName` / `platform` / `getConnections` / `sendMessage` + **显式 `canHandle`**（因为它的 sessionId 是配置直给的 `cli-default`，不带 `cli:` 前缀，必须自报接管，`:91-93`）；`sessionTypes: []` 表示单会话不区分类型。

> 其它带 `provides: [..., 'platform']` 的插件：`plugin-webui-server`（`src/index.ts:54`）。注意它和 CLI 都同时 provide 别的服务名（`cli` / `webui-server`），一个插件提供多服务是允许的。

### 典型消费点

- **plugin-agent**：`getPlatformSelfIdentity(this.ctx, incoming.platform, incoming.sessionId)` 给归档的 assistant 消息打 `userId`/`nickname` 元数据（`src/index.ts:1495`）；`inject.optional` 含 `'platform'`（`:1638`）。
- **plugin-persona**：在 `agent:input:before` 中间件里取 `getPlatformSelfIdentity`，把机器人自身身份装进 `PersonaIdentity` 注入人设 prompt（`src/index.ts:620`，`optional: ['platform']` `:54`）。
- **plugin-tool-session**：跨会话委派工具 `delegate_to_session` 用 `resolvePlatformBySession(ctx, targetSessionId)` 定位目标平台并调用其 `checkAndRecordProactiveSend` 限速闸门（`src/index.ts:749-758`）。
- **plugin-user-relation**：用 `sendPlatformMessage(ctx, sessionId, text)` 主动外发（`src/commands.ts:257`）；用 `getPlatformNames(ctx)` 做「真实平台白名单」过滤伪造 person（`src/extractor.ts:311`、`src/service.ts:2360`）。
- **plugin-authority**：`getPlatformNames(ctx)` 进可选作用域候选（`src/index.ts:217`）。
- **plugin-webui-server**：`aggregatePlatformDetails(ctx)` 喂平台面板（`src/index.ts:668`）；`getPlatformNames(ctx)` 回 `/api/models/platform`（`:826`）；`getPlatformAdapters(ctx)` + 各 adapter 的 `sessionTypes` 生成 `gateway-scopes` 笛卡尔积（`:833-847`）。
- **plugin-session-manager**：`ctx.getAllServices<{platform:string}>('platform')` 汇总已注册平台名（`src/index.ts:278-283`）。
- **plugin-tool-onebot**：`getPlatformAdapters(ctx).find(a => a.platform==='onebot' && typeof a.callAction==='function')` 拿到 onebot adapter 调原生 action（`src/index.ts:130`、`:1904`）。

## 4. 写一个 provider

### 最小必须 vs 可选

**必须实现**：`adapterName`、`platform`、`getConnections()`、`sendMessage()`。
**强烈建议**：当本平台的 `sessionId` **不形如 `<platform>:<...>`** 时（如 CLI 自定义 id），**必须**实现 `canHandle()`，否则 `resolvePlatformBySession` 的前缀兜底会漏掉你，路由发消息/委派都找不到你的 adapter。
**按能力实现**：`getSelfIdentity`（要让 agent/persona 认知自身身份就实现）、`callAction`（暴露平台原生 API）、`checkAndRecordProactiveSend`（接入主动发送限速）、`isReady`、`sessionTypes`（让 UI 能列出你的真实会话类型）。

### 入站消息：发服务之外还要 emit

`PlatformAdapter` 只覆盖**出站**与查询。**入站**不在接口里——adapter 收到平台消息后须 `ctx.emit('inbound:message', msg)`（msg 为 `IncomingMessage`，`packages/plugin-message-api/src/index.ts:161`），由 `plugin-gateway`（`src/index.ts:108` 监听）接管路由到 agent。OneBot 见 `src/index.ts:1746` 一带的 `ctx.emit('inbound:message', …)`；CLI 见 `src/index.ts:574`。出站文本回显则可订阅 `ctx.on('outbound:message', …)`（CLI `src/index.ts:107`）。详见 [message-llm-pipeline](../concepts/message-llm-pipeline.md)。

### 注册（`ctx.provide`）

```ts
// package.json —— 安装前披露源（B 源）必须与运行时一致
// {
//   "aalis": { "service": { "provides": ["platform"], "optional": ["flow-control"] } },
//   "keywords": ["aalis", "aalis-plugin"]
// }

import type { Context } from '@aalis/core';
import type { PlatformAdapter, PlatformConnection } from '@aalis/plugin-platform-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

// 运行时 DI 源（A 源）—— 与 package.json aalis.service 双源同步
export const name = '@your-scope/plugin-adapter-foo';
export const subsystem = 'platform';
export const provides = ['platform'];
export const inject = { optional: ['flow-control'] };

export function apply(ctx: Context, config: Record<string, unknown>): void {
  let online = false;

  const adapter: PlatformAdapter = {
    adapterName: 'Foo',
    platform: 'foo',
    sessionTypes: ['private', 'group'],

    getConnections(): PlatformConnection[] {
      return [{ id: 'foo:bot', platform: 'foo', status: online ? 'online' : 'offline' }];
    },
    // sessionId 形如 'foo:<chatId>'，前缀兜底已够；若不是这种形态则必须实现 canHandle
    canHandle(sid) { return sid.startsWith('foo:'); },
    getSelfIdentity() { return { platform: 'foo', selfId: 'bot-123', nickname: 'FooBot' }; },
    async sendMessage(sessionId, content) {
      // …调用平台 SDK 把 content 发到 sessionId…
    },
  };

  ctx.provide('platform', adapter);
  // 缺省 priority=0（ServicePriority.Backend），多 adapter 并存——不要为「抢胜者」抬 priority，
  // 因为 platform 是按名/按 sessionId 路由的多实例服务，胜者语义在这里基本无意义。

  // 入站：收到平台消息 → 归一为 IncomingMessage → emit
  // ctx.emit('inbound:message', { content, sessionId: 'foo:<chatId>', platform: 'foo', ... } as IncomingMessage);
}
```

注册选项（`ctx.provide(name, instance, { priority?, label?, entryId? })`，`packages/core/src/context.ts:185-189`）：

- **priority**：`ServicePriority`（`packages/core/src/types/service.ts:27-31`）`Backend=0` / `Override=50` / `System=200`。platform 通常用默认 `0`。
- **entryId**：单插件多连接想拆成多 entry 时用 `'${ctx.id}/${sub}'`（per-entry provide，见 [service-model](../concepts/service-model.md)）；单 adapter 内自管多连接（如 OneBot 的 `states[]`）则不需要。
- **label**：展示用，会进 `getAllServices` 的 `label` 字段。
- **双源同步**：`export const provides = ['platform']` 与 `package.json` 的 `aalis.service.provides` 必须一致；激活后 core 会校验「声明了 `provides` 却没真 `ctx.provide`」直接打成 error，dev-mode 还会反向 warn「provide 了但没声明」。见 [manifest-metadata](../concepts/manifest-metadata.md)。

## 5. 标准消费姿势

- **优先用 helper，而非裸 `getService('platform')`**：要发消息用 `sendPlatformMessage(ctx, sessionId, text)`；要按名取身份用 `getPlatformSelfIdentity(ctx, platform, sessionId)`；要列平台用 `getPlatformNames(ctx)`；要调原生 API 用 `callPlatformAction(ctx, sessionId, action, params)`。这些 helper 内部都走 `getAllServices` 聚合，天然处理多 adapter。
- **lazy 访问、勿缓存**：每次用时现取（helper 每次传 `ctx` 即满足）。adapter 是会随 provider bounce 失效的服务，缓存住 instance 会指向僵尸。见 [lazy-service-access](../concepts/lazy-service-access.md)。
- **platform 是可选依赖**：上面所有消费者都把它放在 `inject.optional`。没有任何 adapter 时，`getPlatformNames` 返回 `[]`、`getPlatformSelfIdentity` 返回 `undefined`、`sendPlatformMessage`/`callPlatformAction` 抛错（无 adapter 接管 / 不支持 callAction）。消费方必须容忍这些：persona/agent 在 `identity?.selfId` 处用可选链优雅降级（`plugin-agent/src/index.ts:1500-1501`），session-manager 用 try/catch 包住（`src/index.ts:277-286`）。
- **错误边界**：`resolvePlatformBySession` 内部对每个 adapter 的 `canHandle` 抛错只 `logger.warn` 不中断（`src/index.ts:171-173`）——你的 `canHandle` 抛错不会拖垮全局路由，但也意味着会被静默跳过，实现要稳。

## 6. 能力 / 风险 → 影响

- **主动发送限速（反 prompt-injection 骚扰）**：跨会话委派（`delegate_to_session`）在向外部平台 sessionId 派发合成消息前调 `checkAndRecordProactiveSend`，返回 `{ allowed:false, reason }` 即拒发（`plugin-tool-session/src/index.ts:752-758`）。**面向外部用户的平台 adapter 应实现此闸门**（OneBot 委托 `flow-control` 的 `isRateLimited`/`recordReply`，`adapter-onebot/src/index.ts:1246-1257`），否则该平台不做主动发送限速、任由委派外发。
- **跨会话身份隔离**：`getSelfIdentity(sessionId?)` 必须按 `sessionId` 定位到**正确的连接**再返回身份（OneBot 用 `parseSessionId` → `findStateBySelfId`，`:1128-1132`）。多账号/多连接平台若忽略 `sessionId` 永远返回同一身份，会把 A 会话的机器人身份泄漏进 B 会话的 LLM prompt（persona 把它装进 `AsyncLocalStorage` 正是为防跨会话泄漏，`plugin-persona/src/index.ts:617-618`）。
- **`callAction` 是平台原生权能的逃逸口**：它能调任意平台 Action（封禁、踢人等）。本服务**不在 adapter 层做 authority 校验**——风险/等级控制由调用工具侧（如 `plugin-tool-onebot` 的工具定义 + 其 `risk` 标注）经 authority 把关。provider 实现 `callAction` 时应假设调用方已鉴权，但要对 `sessionId` 解析失败/连接不可用做硬校验（OneBot 在不可用时 throw，`:1203-1205`）。authority 模型见 [security-model](../concepts/security-model.md) 与 `docs/core/authority.md`。
- **`platform` 不是沙盒**：它只是出口抽象；`sendMessage`/`callAction` 直达真实平台，没有任何隔离层。SSRF 安全出口请走 `safeFetch`（`util-network-guard`），不要在 adapter 里裸 `fetch` 外部 URL。

## 7. 边界与坑

- **路由全靠 `canHandle` / 前缀约定**：`resolvePlatformBySession` 对未实现 `canHandle` 的 adapter 用 `sessionId.startsWith(platform + ':')` 兜底（`src/index.ts:168-169`）。若你的 sessionId 既不带前缀又不实现 `canHandle`，它将永远无法被路由——`sendPlatformMessage` 抛「没有 platform adapter 能处理」。CLI 正是反例教科书（`plugin-cli/src/index.ts:90-93`）。
- **`getPlatformNames` 用 `adapter.platform` 字段去重，不是用服务名**：同一 `platform` 字符串值的多个 adapter 会被并成一个名。确保 `platform` 字段在你的生态里唯一且稳定（它会进 authority 作用域、user-relation 白名单、归档 metadata）。
- **非标准扩展方法不在契约里**：OneBot 的 `getSelfMutes` / `getSentMessages` / `handleFriendRequest` 等是 `PlatformAdapter & {…}` 交叉类型私货（`adapter-onebot/src/index.ts:1327-1333`），只对知情消费者（`plugin-tool-onebot`，用 `typeof a.callAction === 'function'` + 平台名探测）可见。第三方 adapter **不要**依赖这些；要扩展平台专属能力，沿用「`callAction(sessionId, action, params)` 走平台原生 API」这条标准通道，或自己另起一个独立服务名而非污染 `platform` 契约。
- **多 entry 的 `getService('platform')` 胜者基本无意义**：因为 platform 是按名/按 sessionId 路由的多实例服务。误用 `getService('platform')` 当「主平台」会在多 adapter 时拿到不确定的那一个（按 priority>注册顺序）。一律用 helper。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名、多 entry、per-entry provide）、[lazy-service-access](../concepts/lazy-service-access.md)（勿缓存、bounce 失效）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides`/`inject` 双源 + `subsystem`）、[message-llm-pipeline](../concepts/message-llm-pipeline.md)（`inbound:message`/`outbound:message` 与 agent 路由）、[security-model](../concepts/security-model.md)、[storage-uri-grammar](../concepts/storage-uri-grammar.md)。
- 核心：`docs/core/service.md`、`docs/core/authority.md`、`docs/core/context.md`、`docs/core/events.md`。
- 相关契约包：`@aalis/plugin-message-api`（`IncomingMessage`/`OutgoingMessage`）、`plugin-gateway`（入站路由）、`plugin-flow-control`（限速闸门后端）。
