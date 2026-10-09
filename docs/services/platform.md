# platform 服务（平台适配器）

## 1. 定位

`platform` 是 Aalis 的**平台抽象服务**：每个聊天/终端平台（OneBot、CLI、WebUI、Telegram、Discord……）实现一个 `PlatformAdapter` 并以服务名 `platform` 注册。它统一了「查询连接状态 / 按 sessionId 发消息 / 调平台原生 API / 自报机器人身份」这几件事，使核心与其它插件无须知道具体平台细节。

- 服务注册名（DI key）：`'platform'` —— `platform.current` 取胜者，`platform.all()` 取全部（**多 adapter 并存是常态**）。
- 契约包：`@aalis/api-platform`（`packages/api-platform/src/index.ts`）。
- 该契约包**既是 runtime 服务契约也带聚合/路由 helper 纯函数**：`PlatformAdapter` 接口是要 `provide(platform, …)` 注册的真实服务；而 `getPlatform*` / `resolvePlatformBySession` / `sendPlatformMessage` / `callPlatformAction` 等是消费方应优先使用的纯函数 helper（传描述符绑定的 `ServiceRef` 即可，没有 entry、无自递归隐患，取代了历史上的 `PlatformRouter` facade，见 `src/index.ts`）。

> 关键认知：**`platform` 是天然的多实例服务**。同时跑 CLI + OneBot 时，`'platform'` 名下有两个 entry。消费方几乎从不用 `platform.current` 取「那个胜者」，而是用 helper 按 `platform` 名或按 `sessionId` 路由到正确的 adapter。

## 2. 契约

### 核心接口 `PlatformAdapter`（`src/index.ts`）

```ts
export interface PlatformAdapter {
  adapterName: string;                       // 显示名，如 'OneBot' / 'CLI'
  platform: string;                          // 平台标识，如 'onebot'/'cli'/'webui'
  sessionTypes?: readonly SessionTypeDecl[]; // 平台类型：类型名与一对一还是多方；不声明的平台整个算一个一对一类型 private

  getConnections(): PlatformConnection[];    // 必须：当前所有连接快照
  sendMessage(                               // 必须：向某 sessionId 发纯文本
    sessionId: string,
    content: string,
    options?: { skipSplit?: boolean },
  ): Promise<void>;

  canHandle?(sessionId: string): boolean | Promise<boolean>;        // 路由用，见下
  getSelfIdentity?(sessionId?: string): PlatformSelfIdentity | undefined;  // 自报机器人身份
  callAction?(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown>; // 平台原生 API
}
```

### 重要类型

`PlatformConnection`（`src/index.ts`）——单条连接状态：`id` / `platform` / `selfId?` / `selfNickname?` / `status: 'online'|'offline'|'connecting'` / `detail?: Record<string, unknown>`。

`PlatformSelfIdentity`（`src/index.ts`）——机器人自身身份，用于 prompt 注入与归档：`platform` / `selfId?` / `nickname?`。

`PlatformAdapterEntry`（`src/index.ts`）——helper 返回的条目：`{ instance: PlatformAdapter; contextId: string; label?: string }`。

`SessionTypeDecl`（`src/index.ts`）——平台类型：`name`（类型名，非空、不含 `:`、不是 `*`，与作用域 `平台:类型:目标` 的第二段同一套写法）/ `multiParty`（多方为 true，一对一为 false）。类型名由平台自定，消息在 `IncomingMessage.sessionType` 上带它。

### 聚合 / 路由 helper（纯函数，第一参是 `ServiceRef<PlatformAdapter>`）

| helper | 作用 |
| --- | --- |
| `getPlatformAdapterEntries(source)` | 枚举所有 adapter 条目 |
| `getPlatformAdapters(source)` | 枚举所有 adapter 实例 |
| `getPlatformNames(source)` | 枚举所有平台名（`adapter.platform` 去重） |
| `aggregatePlatformConnections(source)` | 聚合所有连接 |
| `aggregatePlatformDetails(source)` | 聚合展示详情（含 `contextId` + `connections`） |
| `getPlatformSelfIdentity(source, platform, sessionId?)` | 按平台名取自身身份；同平台装了多个实例时，取第一个认得这个会话的实例给出的身份 |
| `sessionTypesOf(adapter)` | 平台的类型：声明的条目；没声明（没写、空列表，或平台没有适配器）时为 `[{ name: 'private', multiParty: false }]` |
| `resolveSessionType(types, name)` | 按平台的类型解析消息带的类型名：不带按 `private`、一对一；声明里有的按声明；声明里没有的按多方并标出 `undeclared` |
| `resolvePlatformBySession(source, sessionId)` | 按 sessionId 找接管它的 adapter 条目（`PlatformAdapterEntry`，带插件实例 id `contextId`；优先 `canHandle`，否则 `startsWith(platform+':')` 兜底） |
| `sendPlatformMessage(source, sessionId, content, options?)` | 按 sessionId 路由发文本（无 adapter 接管则抛错，见下） |
| `callPlatformAction(source, sessionId, action, params)` | 按 sessionId 路由调原生 action（无 adapter 接管、或 adapter 不支持 `callAction` 则抛错） |

没有 adapter 接管时，两个发送 helper 的报错写明 sessionId；sessionId 带平台前缀时，另列出这个平台各实例（`contextId`）的已知账号与连接状态，如 `<实例甲>: 111(online)；<实例乙>: 222(online)、333(offline)`，分得清是账号写错、账号不属于任何实例，还是连接没上来。

类型随描述符提供：`defineService<PlatformAdapter>('platform')`（`src/index.ts`），消费方把描述符写进 `uses` 即得类型，`platform.current` 推断为 `PlatformAdapter | undefined`。

## 3. 谁提供 / 谁消费

### 参考实现（provider）

- **OneBot 适配器** `packages/plugin-adapter-onebot/src/index.ts` —— 协议类平台的完整范例：实现了可选方法 `canHandle`、`getSelfIdentity`、`callAction`，声明 `group`（多方）、`private`（一对一）、`channel`（多方）三个类型，入站消息带类型名与机器人账号（`selfId`），在插件 `apply` 里注册。它可以装多个实例（`reusable`），每个实例可带多个账号：`canHandle` 只认本实例连接里的账号（含配置里写明、连接还没上来的），会话 ID `onebot:<selfId>:…` 因此按账号路由到所属实例。还附带若干**非标准扩展方法**（`getSelfMutes` / `getSentMessages` / `handleFriendRequest` 等），通过交叉类型暴露给特定消费者（`plugin-tool-onebot`），见 §6。
- **CLI 适配器** `packages/plugin-cli/src/index.ts` —— 最小实现的范例：只实现 `adapterName` / `platform` / `getConnections` / `sendMessage` + **显式 `canHandle`**（因为它的 sessionId 是配置直给的 `cli-default`，不带 `cli:` 前缀，必须自报接管）；不声明类型，整个平台算一个一对一类型 `private`。

> 其它带 `provides: [..., 'platform']` 的插件：`plugin-webui-server`（`src/index.ts`）。注意它和 CLI 都同时 provide 别的服务名（`cli` / `webui-server`），一个插件提供多服务是允许的。

### 典型消费点

- **plugin-agent**：`getPlatformSelfIdentity(this.caps.platform, incoming.platform, incoming.sessionId)` 给归档的 assistant 消息打 `userId`/`nickname` 元数据（`src/index.ts`）；`uses` 中声明 `platform: optional(platform)`。
- **plugin-persona**：在 `agent:input:before` 中间件里取 `getPlatformSelfIdentity`，把机器人自身身份装进 `PersonaIdentity` 注入人设 prompt（`src/index.ts`，`uses` 中声明 `platform: optional(platform)`）。
- **plugin-user-relation**：用 `sendPlatformMessage(platform, sessionId, text)` 主动外发（`src/commands.ts`）；用 `getPlatformNames(platform)` 做「真实平台白名单」过滤伪造 person（`src/extractor.ts`、`src/service.ts`）。
- **plugin-authority**：`getPlatformNames(platform)` 进可选作用域候选（`src/index.ts`）。
- **plugin-webui-server**：`aggregatePlatformDetails(platform)` 喂平台面板（`src/index.ts`）；`getPlatformNames(platform)` 回 `/api/models/platform`；`getPlatformAdapters(platform)` + 各 adapter 的 `sessionTypesOf` 生成 `gateway-scopes` 笛卡尔积（没声明类型的平台列 `<平台>:private`）。
- **plugin-session-manager**：房间建档时按入站消息的平台取适配器的类型声明（`sessionTypesOf`），经 api-gateway 的 `chatScopeOf` 记下聊天窗口；用 `resolvePlatformBySession` 解析出接管它的实例，记进 `SessionInfo.originInstance`，供会话列表按实例分组（`src/index.ts`）。
- **plugin-tool-onebot**：平台动作经 `callPlatformAction(platform, 'onebot:<selfId>:internal:0', action, params)` 发出，按账号路由到所属实例；撤回自己发的消息、处理好友申请与群请求按会话（或账号）用 `resolvePlatformBySession` 找到所属实例，自身禁言列表汇总所有 onebot 实例（`src/index.ts`）。

## 4. 写一个 provider

### 最小必须 vs 可选

**必须实现**：`adapterName`、`platform`、`getConnections()`、`sendMessage()`。
**强烈建议**：当本平台的 `sessionId` **不形如 `<platform>:<...>`** 时（如 CLI 自定义 id），**必须**实现 `canHandle()`，否则 `resolvePlatformBySession` 的前缀兜底会漏掉你，`sendPlatformMessage` / `callPlatformAction` 都找不到你的 adapter。插件能装多个实例（`reusable`）时同样**必须**实现 `canHandle()`，只认自己实例的会话：前缀兜底会让第一个实例接下这个平台的全部会话。
**按能力实现**：`getSelfIdentity`（要让 agent/persona 认知自身身份就实现）、`callAction`（暴露平台原生 API）。
**有多方会话就必须声明**：`sessionTypes`（类型名与一对一还是多方），并在入站消息上带类型名。不声明的平台整个算一个一对一类型 `private`：它的群会按一对一记下，群里任何人都会被当成那个唯一的对端。消息带了声明里没有的类型名时按多方记下，session-manager 每个平台与类型名告警一次。

### 会话 ID 约定

会话表里还没有记录的会话收到第一条原生入站（不带 `source`）时，session-manager 按这条消息建档，记下出生平台（消息的平台）与聊天窗口（平台类型名、多方标记、机器人账号、目标），之后不变；这几项是会话字段（`originPlatform`、`originChat`），读方按字段判，不从 ID 里拆。

选平台档与会话列表分区目前仍按 ID 前缀认平台（api-gateway 的 `resolveSessionOrigin`），与会话记下的出生平台不是一回事：多人房间（群、私聊、频道）的会话 ID 必须以本适配器的平台名加冒号开头，即 `<platform>:<...>`；实现了 `canHandle()` 的适配器也要遵守。房间不论从哪个入口驱动（包括 owner 从 WebUI 往群里插话），都按这个前缀的平台档选工具组、人设与模型，并列进会话列表的「IM 房间」区。路由仍优先 `canHandle()`。

- 不带前缀的 ID 只适合单用户会话（如 CLI 的 `cli-default`），且不要含单冒号：带单冒号的 ID 一律按第一个 `:` 之前的一段认作平台前缀。内部会话 ID 要分段时用 `::`（如 workflow 的 `workflow::<runId>::<nodeId>`）。
- ID 前缀与平台名不一致时（平台名为 `<平台甲>`，ID 写成 `<缩写>:...`、靠 `canHandle()` 认领），这个平台的全部房间都按 `<缩写>` 这份多半不存在的平台档选档，落到全局默认。
- 多人房间的 ID 不带冒号时选档认不出出生平台：从 WebUI 驱动时按入口平台选档，登记后列在「我的会话」区。

### 入站消息：出站接口之外还需 emit

`PlatformAdapter` 只覆盖**出站**与查询。**入站**不在接口里——adapter 收到平台消息后须 `events.emit('inbound:message', msg)`（msg 为 `IncomingMessage`，`packages/schema-message/src/index.ts`），由 `plugin-gateway`（`src/index.ts` 监听）接管路由到 agent。OneBot 见 `src/index.ts` 一带的 `events.emit('inbound:message', …)`；CLI 见 `src/index.ts`。出站文本回显则可订阅 `events.on('outbound:message', …)`（CLI `src/index.ts`）。详见 [message-llm-pipeline](../concepts/message-llm-pipeline.md)。

### 注册（`provide`）

```ts
import { platform } from '@aalis/api-platform';
import type { PlatformAdapter, PlatformConnection } from '@aalis/api-platform';
import { definePlugin, events, provide } from '@aalis/core';

export default definePlugin({
  name: '@your-scope/plugin-adapter-foo',
  subsystem: 'platform',
  provides: [platform],
  uses: { provide, events },
  apply({ provide, events }) {
    void events;
    let online = false;

    const adapter: PlatformAdapter = {
      adapterName: 'Foo',
      platform: 'foo',
      sessionTypes: [
        { name: 'private', multiParty: false },
        { name: 'group', multiParty: true },
      ],

      getConnections(): PlatformConnection[] {
        return [{ id: 'foo:bot', platform: 'foo', status: online ? 'online' : 'offline' }];
      },
      canHandle(sid) {
        return sid.startsWith('foo:');
      },
      getSelfIdentity() {
        return { platform: 'foo', selfId: 'bot-123', nickname: 'FooBot' };
      },
      async sendMessage(_sessionId, _content) {},
    };

    provide(platform, adapter);
  },
});
```

注册选项（`provide(descriptor, instance, { priority?, label?, entryId? })`，`packages/core/src/composition/core-services.ts`）：

- **priority**：普通数字，越大越优先。platform 通常用默认 `0`。
- **entryId**：单插件多连接想拆成多 entry 时用 `'${lifecycle.id}/${sub}'`（per-entry provide，见 [service-model](../concepts/service-model.md)）；单 adapter 内自管多连接（如 OneBot 的 `states[]`）则不需要。
- **label**：展示用，会进 `all()` / `services.inspect` 返回条目的 `label`。
- **双源同步**：`provides: [platform]` 与 `package.json` 的 `aalis.service.provides` 必须一致；激活后 core 会校验「声明了 `provides` 却没真 `provide`」直接打成 error，dev-mode 还会反向 warn「provide 了但没声明」。见 [manifest-metadata](../concepts/manifest-metadata.md)。

## 5. 标准消费方式

- **优先用 helper，而非裸 `platform.current`**：要发消息用 `sendPlatformMessage(platform, sessionId, text)`；要按名取身份用 `getPlatformSelfIdentity(platform, name, sessionId)`；要列平台用 `getPlatformNames(platform)`；要调原生 API 用 `callPlatformAction(platform, sessionId, action, params)`。这些 helper 内部都走 `source.all()` 聚合，天然处理多 adapter。
- **lazy 访问、勿缓存**：每次用时现取（helper 每次读 `source.all()` / `source.current`）。adapter 会随 provider bounce 失效，缓存住 instance 会指向僵尸。见 [lazy-service-access](../concepts/lazy-service-access.md)。
- **platform 是可选依赖**：上面所有消费者都在 `uses` 里以 `optional(platform)` 声明它。没有任何 adapter 时，`getPlatformNames` 返回 `[]`、`getPlatformSelfIdentity` 返回 `undefined`、`sendPlatformMessage`/`callPlatformAction` 抛错（无 adapter 接管 / 不支持 callAction）。消费方必须容忍这些：persona/agent 在 `identity?.selfId` 处用可选链优雅降级（`plugin-agent/src/index.ts`）。
- **错误边界**：`resolvePlatformBySession` 内部对每个 adapter 的 `canHandle` 抛错只 `logger.warn` 不中断（`src/index.ts`）——你的 `canHandle` 抛错不会拖垮全局路由，但也意味着会被静默跳过，实现应保证稳健。

## 6. 能力 / 风险 → 影响

- **跨会话身份隔离**：`getSelfIdentity(sessionId?)` 必须按 `sessionId` 定位到**正确的连接**再返回身份（OneBot 用 `parseSessionId` → `findStateBySelfId`）。多账号/多连接平台若忽略 `sessionId` 永远返回同一身份，会把 A 会话的机器人身份泄漏进 B 会话的 LLM prompt（persona 把它装进 `AsyncLocalStorage` 正是为防跨会话泄漏，`plugin-persona/src/index.ts`）。
- **`callAction` 是平台原生权能的逃逸口**：它能调任意平台 Action（封禁、踢人等）。本服务**不在 adapter 层做 authority 校验**——风险/等级控制由调用工具侧（如 `plugin-tool-onebot` 的工具定义 + 其 `risk` 标注）经 authority 把关。provider 实现 `callAction` 时应假设调用方已鉴权，但要对 `sessionId` 解析失败/连接不可用做硬校验（OneBot 在不可用时 throw）。authority 模型见 [security-model](../concepts/security-model.md) 与 `docs/plugins/plugin-authority.md`。
- **`platform` 不是沙盒**：它只是出口抽象；`sendMessage`/`callAction` 直达真实平台，没有任何隔离层。SSRF 安全出口请走 `safeFetch`（`util-network-guard`），不要在 adapter 里裸 `fetch` 外部 URL。

## 7. 边界与注意事项

- **路由依赖 `canHandle` / 前缀约定**：`resolvePlatformBySession` 对未实现 `canHandle` 的 adapter 用 `sessionId.startsWith(platform + ':')` 兜底（`src/index.ts`）。若你的 sessionId 既不带前缀又不实现 `canHandle`，它将永远无法被路由——`sendPlatformMessage` 抛「没有 platform adapter 能处理」。CLI 即是典型反例（`plugin-cli/src/index.ts`）。前缀兜底只认平台名、不认实例，同一插件装多个实例时按注册顺序落到第一个，所以能多实例的适配器要自己实现 `canHandle`（OneBot 即是）。
- **`getPlatformNames` 用 `adapter.platform` 字段去重，不是用服务名**：同一 `platform` 字符串值的多个 adapter 会被并成一个名。确保 `platform` 字段在你的生态里唯一且稳定（它会进 authority 作用域、user-relation 白名单、归档 metadata）。
- **非标准扩展方法不在契约里**：OneBot 的 `getSelfMutes` / `getSentMessages` / `handleFriendRequest` 等是 `PlatformAdapter & {…}` 交叉类型上附加的扩展（`adapter-onebot/src/index.ts`），只对知情消费者（`plugin-tool-onebot`，按会话路由到所属实例后用 `typeof` 探测方法）可见。第三方 adapter **不要**依赖这些；要扩展平台专属能力，沿用「`callAction(sessionId, action, params)` 走平台原生 API」这条标准通道，或自己另起一个独立服务名而非污染 `platform` 契约。
- **多 entry 的 `platform.current` 胜者基本无意义**：因为 platform 是按名/按 sessionId 路由的多实例服务。误用 `platform.current` 当「主平台」会在多 adapter 时拿到不确定的那一个（按 priority>注册顺序）。一律用 helper。

## 8. 交叉链接

- 概念：[service-model](../concepts/service-model.md)（DI 按名、多 entry、per-entry provide）、[lazy-service-access](../concepts/lazy-service-access.md)（勿缓存、bounce 失效）、[manifest-metadata](../concepts/manifest-metadata.md)（`provides`/`uses` 双源 + `subsystem`）、[message-llm-pipeline](../concepts/message-llm-pipeline.md)（`inbound:message`/`outbound:message` 与 agent 路由）、[security-model](../concepts/security-model.md)、[storage-uri-grammar](../concepts/storage-uri-grammar.md)。
- 核心：`docs/core/service.md`、`docs/plugins/plugin-authority.md`、`docs/core/context.md`、`docs/core/events.md`。
- 相关契约包：`@aalis/schema-message`（`IncomingMessage`/`OutgoingMessage`）、`plugin-gateway`（入站路由）、`plugin-flow-control`（限速闸门后端）。
