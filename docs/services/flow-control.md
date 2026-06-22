# flow-control 服务

## 1. 定位

`flow-control` 管理**每会话的「流控状态」**——决定缓冲中的入站消息何时（以及是否）有资格点燃一次 agent 回合：计数器/活跃指数（间隔触发依据）、回复后冷却、限速窗口（防 DDoS/刷屏）、自禁言时段、闲置主动触发调度。它**不做触发判定本身**（那是 `trigger-policy` 的活），只维护被判定方读写的状态 + 在入站管线里把禁言/冷却/限速的消息直接「吞掉」。

- 服务注册名：`getService('flow-control')`（字符串键）
- 契约包：`@aalis/plugin-flow-control-api`
- 参考实现：`@aalis/plugin-flow-control`
- 紧密协作的兄弟服务：`@aalis/plugin-trigger-policy`（`trigger-policy`），二者占据入站管线相邻两个相位。

两者职责切分（`packages/plugin-trigger-policy/src/types.ts:1-4`）：**决策只读由 `trigger-policy` 做，状态变更由 `flow-control` 做**。这是写 provider/consumer 时最该先记住的边界。

## 2. 契约

完整接口（`packages/plugin-flow-control-api/src/index.ts:40-73`）：

```ts
export interface FlowControlService {
  /** 获取或创建 session 状态（首次访问会初始化）。sessionType/targetId 用于 per-scope 覆盖匹配 */
  ensureState(sessionId: string, platform: string, sessionType?: string, targetId?: string): void;
  /** 只读快照（trigger-policy 用） */
  getStateSnapshot(sessionId: string): FlowSessionStateSnapshot | undefined;

  /** 入站累加（messageCount, activityScore, lastMessageTime, userInteractions, 应用衰减） */
  recordIncoming(sessionId: string, platform: string, userId?: string, sessionType?: string, targetId?: string): void;

  /** 触发后重置（messageCount=0, activityScore=0, lastReplyTime=now, idleBackoff=1） */
  recordTriggered(sessionId: string): void;
  /** 出站后处理：设置冷却 + 限速窗口记录 + 重置退避 + 重排 idle 调度 */
  recordReply(sessionId: string, platform: string): void;

  isCoolingDown(sessionId: string): boolean;
  isMuted(sessionId: string): boolean;
  /** true 表示已超限 */
  isRateLimited(sessionId: string): boolean;

  /** 自禁言：durationSec>0 设禁言至 now+durationSec*1000；<=0 解除。未初始化但给 platform 会自动建 */
  setMuted(sessionId: string, durationSec: number, platform?: string): void;
  /** 当前阈值（动态衰减） */
  getThreshold(sessionId: string): number;

  /** 重排本会话 idle trigger（每次入站后调用） */
  rescheduleIdle(sessionId: string, platform: string): void;
}
```

只读快照类型（`packages/plugin-flow-control-api/src/index.ts:22-38`）——这是 `trigger-policy` 唯一拿来算「是否到点」的视图：

```ts
export interface FlowSessionStateSnapshot {
  messageCount: number;        // 自上次触发以来累计入站条数
  activityScore: number;       // 活跃指数（受用户交互权重影响）
  lastReplyTime: number;
  lastMessageTime: number;
  cooldownUntil: number;
  mutedUntil: number;
  idleBackoff: number;
  rateLimitUsed: number;       // 当前窗口已用回复槽
  rateLimitMax: number;        // 0=未启用限速
  fixedInterval: number;       // 间隔触发阈值（trigger-policy 复用同一参数）
  userInteractions: ReadonlyMap<string, { count: number; lastTime: number }>;
}
```

类型绑定经 declaration merging 随 -api 包提供（`packages/plugin-flow-control-api/src/index.ts:79-83`），下游只 `import '@aalis/plugin-flow-control-api'` 即可让 `ctx.getService('flow-control')` 拿到类型，**不必硬依赖实现包**。

要点：
- `getStateSnapshot` / `getThreshold` 是**纯读**；其余方法是状态变更副作用。
- `getThreshold` 随距上次回复的时间线性衰减（刚回完阈值高、久未回阈值低，`packages/plugin-flow-control/src/state.ts:45-51`），消费者比较时应**每次重取**而非缓存。
- `activityScore` 增量按 `fixedInterval` 归一并叠加用户交互权重（`state.ts:64-78`）；可选按 `scoreDecayMinutes` 线性衰减（`state.ts:54-61`，默认 0 = 不衰减）。

## 3. 谁提供 / 谁消费

**提供方（唯一参考实现）**：`@aalis/plugin-flow-control`，`ctx.provide('flow-control', service)`（`packages/plugin-flow-control/src/index.ts:347`）。它同时占据入站管线 `inbound:flow` 相位做前置闸门（`:360-391`），并监听 `outbound:message` 自动记冷却（`:394-400`）。

**典型消费点**：

- `@aalis/plugin-trigger-policy`（核心消费者）：`inbound:trigger` 相位里 `getService('flow-control')` 读快照算 `fixedOk/dynamicOk`、命中 mute 关键词后 `setMuted` + `rescheduleIdle`、触发后 `recordTriggered`（`packages/plugin-trigger-policy/src/index.ts:132-138`、`:179-230`）。
- `@aalis/plugin-adapter-onebot`：
  - 平台群禁言/解禁 notice → `flow.setMuted(sessionId, durationSec, platform)` 桥接（`packages/plugin-adapter-onebot/src/index.ts:685-693`、`:1942-1953`）。
  - agent 主动发送前限速门：`flow.isRateLimited` + `flow.recordReply`（`:1246-1257`）；flow-control 未加载时默认放行（不限速）。
- 全部消费点都用 `optional` 注入（见下）：`flow-control` 缺失不致命，降级为「不限流、全部放行」。

`recordIncoming` / `recordReply` 在管线内由实现自己调用（中间件 `:367`、`outbound:message` 监听 `:399`），普通业务插件一般不直接调它们——只读 `getStateSnapshot` / 触发 `setMuted` / 查 `isRateLimited` 是更常见的外部用法。

## 4. 写一个 provider

替换默认实现（例如换一套触发算法）时，**最小必须实现整个 `FlowControlService` 接口**——没有可选方法，`trigger-policy` 会同时用到 `getStateSnapshot` / `getThreshold` / `recordTriggered` / `setMuted` / `rescheduleIdle`，adapter 会用到 `isRateLimited` / `recordReply`。若你只想接管「状态存储」而保留管线相位行为，更省事的是直接 fork `plugin-flow-control`；自建 provider 时务必把它占据的 `inbound:flow` 中间件一并搬过来（否则禁言/冷却/限速闸门会失效）。

双源 manifest 必须同步（`package.json` 的 `aalis.service` 与 `index.ts` 的 `provides/inject` 两处都要写，见 [concepts/manifest-metadata](../concepts/manifest-metadata.md)）。参考实现的两源：

`package.json` → `aalis.service`：
```json
{ "aalis": { "service": {
  "required": ["gateway"],
  "optional": ["message-archive"],
  "provides": ["flow-control"]
} } }
```

`index.ts`（`packages/plugin-flow-control/src/index.ts:35-39`）：
```ts
export const provides = ['flow-control'];
export const inject = { required: ['gateway'], optional: ['message-archive'] };
```

最小骨架（可编译，省略算法细节）：

```ts
import type { Context } from '@aalis/core';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import type { FlowControlService } from '@aalis/plugin-flow-control-api';

export const name = '@aalis/plugin-my-flow-control';
export const provides = ['flow-control'];
export const inject = { required: ['gateway'], optional: ['message-archive'] };

export function apply(ctx: Context): void {
  const service: FlowControlService = {
    ensureState(/* ... */) {/* 初始化 per-session 状态 */},
    getStateSnapshot(/* ... */) { return undefined; },
    recordIncoming(/* ... */) {/* 累加计数/评分 */},
    recordTriggered(/* ... */) {/* 重置计数 */},
    recordReply(/* ... */) {/* 设冷却 + 记限速 + 重排 idle */},
    isCoolingDown() { return false; },
    isMuted() { return false; },
    isRateLimited() { return false; },
    setMuted(/* ... */) {/* 自禁言 */},
    getThreshold() { return 0; },
    rescheduleIdle(/* ... */) {/* 重排 idle 定时 */},
  };

  // priority 留默认(0=Backend)即可，无人会跟 flow-control 抢名
  ctx.provide('flow-control', service);

  // 关键：占据入站「前置闸门」相位，禁言/冷却/限速直接 swallow（不调 next）
  ctx.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
    const { message } = data;
    if (message.source === 'idle-trigger') return next(); // 内部注入不再过流控
    service.ensureState(message.sessionId, message.platform, message.sessionType);
    service.recordIncoming(message.sessionId, message.platform, message.userId, message.sessionType);
    if (service.isMuted(message.sessionId) || service.isCoolingDown(message.sessionId) || service.isRateLimited(message.sessionId)) {
      return; // swallow：不调 next() = 不进入 trigger/dispatch
    }
    await next();
  });
}
```

注册选项说明（`ctx.provide(name, instance, { priority, label, entryId })`，`packages/core/src/context.ts:188`）：

- **priority**：`flow-control` 是单实例后端服务，无 per-entry 分裂场景，留默认（`ServicePriority.Backend=0`）即可。同名胜出规则为 `偏好 > priority > 注册顺序`（详见 [concepts/service-model](../concepts/service-model.md)），框架已**移除 0.5.0 的能力匹配选择**——别指望按 capability 选 provider。
- **entryId**：只在「按子作用域分裂多个 entry」时用 `'${ctx.id}/${sub}'`；flow-control 用全局单例 `Map<sessionId, state>` 管多会话，**不**需要 entryId。

## 5. 标准消费姿势

按 [concepts/lazy-service-access](../concepts/lazy-service-access.md) 的铁律：**每次用都 `getService()` 现取，不缓存引用**（provider 反弹会让旧引用失效）。flow-control 是 `optional` 依赖的典范——缺失即降级放行：

```ts
import type { FlowControlService } from '@aalis/plugin-flow-control-api';

// trigger-policy 读快照算是否到点（packages/plugin-trigger-policy/src/index.ts:132-138）
const flow = ctx.getService<FlowControlService>('flow-control');
const snap = flow?.getStateSnapshot(message.sessionId);
if (!snap) {
  // 没有 flow 状态（私聊/CLI/未启用流控的 scope）→ 默认放行
  return { kind: 'interval', reason: 'no flow state, default-pass' };
}
const fixedOk = snap.messageCount >= snap.fixedInterval;
const dynamicOk = snap.activityScore >= (flow?.getThreshold(message.sessionId) ?? 0);
```

```ts
// adapter 主动发送前限速门（packages/plugin-adapter-onebot/src/index.ts:1246-1257）
const flow = ctx.getService<FlowControlService>('flow-control');
if (!flow) return { allowed: true };          // 未加载 → 不限速
if (flow.isRateLimited(sessionId)) return { allowed: false, reason: '已达限速上限' };
flow.recordReply(sessionId, 'onebot');         // 记一次出站
return { allowed: true };
```

错误边界：
- `decide()` 抛错时 `trigger-policy` 默认 `next()` 放行而非 swallow（`packages/plugin-trigger-policy/src/index.ts:200-207`）——「失败放行」优于「失败静默」。
- `getStateSnapshot` 对未知 session 返回 `undefined`；`isCoolingDown/isMuted/isRateLimited` 对未知 session 返回 `false`（`state` 不存在视为不限制，`index.ts:301-315`）。
- `recordTriggered` 对未初始化 session 静默 no-op（`:278-285`），不会抛。

## 6. 能力 / 风险 → 影响

flow-control 不直接接触 authority/SSRF/沙盒，但它是**对外可见行为的总闸**，provider/consumer 必须守住几条隔离不变量：

- **scope 隔离不能泄漏**。`scopes`/`overrides` 用 `platform:sessionType[:targetId]` 三段通配匹配（`packages/plugin-flow-control/src/config.ts:135-152`，默认 `*:group`）。`trigger-policy` 在做 mute 关键词检查**之前**必须先判 scope，否则「QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话」（`packages/plugin-trigger-policy/src/index.ts:182-186` 明文警告）。自写 provider/consumer 时保持这个先 scope 后行为的顺序。
- **idle 主动触发是「AI 替你开口」**。`scheduleSessionIdle` / `PlatformIdleScheduler` 到点会合成一条 `source:'idle-trigger', triggerType:'idle'` 的 `IncomingMessage` 注入 gateway（`packages/plugin-flow-control/src/idle-scheduler.ts:15-32`、`:59-70`）。这类消息**绕过流控前置闸门**（`index.ts:363` `if (message.source === 'idle-trigger') return next()`）并被 agent 当系统提示而非用户消息（`plugin-agent/src/index.ts:1593` 跳过归档）。provider 注入 idle 时务必打上 `source:'idle-trigger'`，否则会被自己的闸门再过一遍或被错误归档成用户发言。
- **禁言态是跨重启的用户意图，要持久化**。参考实现只持久化 `mutedUntil` 一个字段到 `data:/flow-control-mutes.json`（`index.ts:160-204`），其余短期态重启重建无碍。换 provider 时若不持久化，重启会导致「被禁言的群立刻被解除静默」。存储用 `data:` root（`'<root>:/path'` 文法，见 [concepts/storage-uri-grammar](../concepts/storage-uri-grammar.md)），注意 storage 不是沙盒。
- **限速是防刷屏/被平台风控的护栏**。adapter 的「主动发送」路径在发前查 `isRateLimited` 并 `recordReply`（`adapter-onebot/src/index.ts:1246-1257`）。自写主动发送通道的 provider 应接同一闸门，避免绕过限速直发被平台封号。

## 7. 边界与坑

**Shadow archive 顺序竞态（审计标注，现状未收口）**。被流控/策略 swallow 的入站消息会做「影子归档」，下次触发时作为上下文补回：

- `flow-control` 的 `shadowArchive`（`packages/plugin-flow-control/src/index.ts:244-253`）和 `trigger-policy` 的 `shadowArchive`（`packages/plugin-trigger-policy/src/index.ts:104-112`）都**直接** `await archive.archiveIncoming(message)`。
- 而真正触发回合的消息走 agent 的**串行归档车道** `archiveIncomingMessageInOrder`（`packages/plugin-agent/src/index.ts:1573-1589`）——一条 per-lane 的 promise 链，保证同会话入站归档有序入库。
- 两条路径不共享同一把锁/车道，且 `archiveIncoming` 用 `Date.now()` 作 `timestamp`（`packages/plugin-message-archive/src/index.ts:162`）。当 swallow 与触发在毫秒级交错时，影子归档与串行车道里的归档可能**乱序落库或时间戳并列**，导致下次喂给 LLM 的历史里 swallow 的几条与触发那条相对次序不稳定。

现状：功能正确（消息都会进档、都会发 `inbound:message:archived`），但**严格的会话内时序不保证**。规避建议：
- 自写 provider 做影子归档时，复用 agent 暴露的同一串行车道（若可达）或自建 per-sessionId 串行链，别裸 `await archiveIncoming`。
- 依赖严格时序的下游（如按时间排序渲染历史）应以稳定的单调序列号而非 `Date.now()` 排序。

**其它坑**：
- `getThreshold` / `getStateSnapshot.activityScore` 随时间变化，**比较前现取**，缓存会算错触发点。
- `recordReply` 只在 `outbound:message` 且 `source==='agent'` 时由实现触发（`index.ts:394-400`）——命令/系统回复不计冷却。自写出站通道若想计冷却，要么发 `source:'agent'` 的 `outbound:message`，要么显式调 `recordReply`。
- 长寿进程下 `states` 有 30 天 TTL 清理（`index.ts:408-424`）；自写 provider 别让 per-session map 无界增长。

## 8. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md) — 入站相位 `CONFIRM → COMMAND → FLOW → TRIGGER → DISPATCH` 全貌（相位常量见 `packages/plugin-gateway-api/src/index.ts:122-139`）。
- [concepts/service-model](../concepts/service-model.md)、[concepts/lazy-service-access](../concepts/lazy-service-access.md) — DI 选名规则、现取不缓存。
- [concepts/manifest-metadata](../concepts/manifest-metadata.md) — `provides/inject` 双源同步。
- [concepts/storage-uri-grammar](../concepts/storage-uri-grammar.md) — `mutedUntil` 持久化用的 `data:` root 文法。
- [services/gateway](./gateway.md) — 谁驱动入站相位、`ingressMessage`/`outbound:message`。
- [services/message-archive](./message-archive.md) — `archiveIncoming` 烘焙/落库语义与 `inbound:message:archived` 事件（影子归档的目标）。
- 兄弟服务 `trigger-policy`（契约 `@aalis/plugin-trigger-policy`，接口 `packages/plugin-trigger-policy/src/types.ts:16-23`）：`decide()` / `getBotNames()` / `detectMuteKeyword()`，与本服务在 `inbound:flow` / `inbound:trigger` 相邻相位协作。
