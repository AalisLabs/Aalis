# gateway 服务

## 1. 定位

`gateway` 是 Aalis 的**消息流编排中枢**：把平台适配器（OneBot / WebUI / CLI 等）和 agent 之间的入站 / 出站消息路由统一收口到一条带相位的管道里。

- 服务注册名：`gateway` —— 即 `ctx.getService<GatewayService>('gateway')` 里的字符串。
- 契约包：`@aalis/plugin-gateway-api`（`packages/plugin-gateway-api/src/index.ts`）。
- 默认实现包：`@aalis/plugin-gateway`（`packages/plugin-gateway/src/index.ts`，`provides = ['gateway']`）。

它做两件事：

- **入站**：监听 `inbound:message` 事件，按 `INBOUND_PHASE_ORDER` 顺序串行运行 `inbound:confirm → inbound:command → inbound:flow → inbound:trigger → inbound:dispatch` 五个命名相位；终相 `dispatch` 的默认动作是调用 `agent.handleMessage`。前四相位任一被 swallow（handler 未调用 `next()`）即停止后续调度，消息不触达 agent（`packages/plugin-gateway/src/index.ts:51-92`）。
- **出站**：提供 `dispatchOutbound()`，运行 `outbound:dispatch` 钩子链，默认动作是向 `outbound:message` 事件总线广播，由平台适配器接收并发送（`packages/plugin-gateway/src/index.ts:95-104`）。

> core 自身不再绑定任何路由实现。`packages/core/src/app.ts:342` 的注释明确：「消息路由由 `@aalis/plugin-gateway` 承担」。最小应用若不加载 gateway，则**没有人**监听 `inbound:message`，消息不会被处理 —— gateway 是路由的必要部件，不存在 core 兜底。

## 2. 契约

来自 `packages/plugin-gateway-api/src/index.ts`。

### 2.1 服务接口

```ts
// packages/plugin-gateway-api/src/index.ts:80-95
export interface GatewayService {
  /** 主动注入一条入站消息（idle-trigger / webui 直发 / 内部自检等）。等价于 emit('inbound:message')，都走入站相位链。 */
  ingressMessage(message: IncomingMessage): Promise<void>;

  /** 派发一条出站消息，经过 outbound:dispatch 钩子链（脱敏 / 限速 / 审计），默认动作 emit('outbound:message')。 */
  dispatchOutbound(message: OutgoingMessage): Promise<void>;
}
```

服务类型经 declaration merging 注册到 core：`ServiceTypeMap.gateway = GatewayService`（`packages/plugin-gateway-api/src/index.ts:142-146`）。

### 2.2 入站相位常量与相位数据

```ts
// packages/plugin-gateway-api/src/index.ts:122-139
export const INBOUND_PHASE = {
  CONFIRM:  'inbound:confirm',  // 会话内待确认回复拦截（plugin-session-confirm）
  COMMAND:  'inbound:command',  // 指令解析与执行（plugin-commands）
  FLOW:     'inbound:flow',     // 流控前置闸门：禁言/冷却/限速（plugin-flow-control）
  TRIGGER:  'inbound:trigger',  // 触发策略判定：mute/@/计数评分（plugin-trigger-policy）
  DISPATCH: 'inbound:dispatch', // 默认派发到 agent.handleMessage（plugin-gateway 提供默认动作）
} as const;

export const INBOUND_PHASE_ORDER = [
  INBOUND_PHASE.CONFIRM, INBOUND_PHASE.COMMAND, INBOUND_PHASE.FLOW,
  INBOUND_PHASE.TRIGGER, INBOUND_PHASE.DISPATCH,
] as const;
export type InboundPhase = (typeof INBOUND_PHASE_ORDER)[number];
```

每个相位对应一个命名 hook 键，相位间数据由同一对象引用传递：

```ts
// packages/plugin-gateway-api/src/index.ts:24-29
export interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  /** 当前可用的 agent 服务；plugin-gateway 在调度前已注入（可能为 undefined）。 */
  agent: AgentService | undefined;
}
```

相位 hook 与出站 hook 经 declaration merging 注入 `HookContextMap`（`packages/plugin-gateway-api/src/index.ts:33-48`）：五个 `inbound:*` 相位载荷均为 `InboundPhaseData`；`outbound:dispatch` 载荷为 `{ message: OutgoingMessage; metadata: Record<string, unknown> }`。

### 2.3 遥测事件

```ts
// packages/plugin-gateway-api/src/index.ts:60-69 —— 注入 AalisEvents
'gateway:phase:done': [data: {
  phase: string;
  reachedEnd: boolean;   // true=链走到底（未被 swallow）；false=某 handler 未调用 next() 终止了链
  durationMs: number;
  sessionId: string;
  platform: string;
}];
```

对主流程零侵入：observer 异常不影响入站处理；遥测插件可订阅它统计各相位耗时 / swallow 率 / 消息流转路径。

### 2.4 消息载体类型（来自 `@aalis/plugin-message-api`）

gateway 不持有消息类型，只搬运。`IncomingMessage` / `OutgoingMessage` 定义在 `packages/plugin-message-api/src/index.ts:161-241` 与 `:245-269`，事件签名（`inbound:message` / `outbound:message` 等）在 `:296-310`。适配器作者真正要填的就是这两个结构 —— 详见下文「写一个适配器」与 `concepts/message-llm-pipeline.md`。

## 3. 谁提供 / 谁消费

**提供方（唯一）**：`@aalis/plugin-gateway`（`packages/plugin-gateway/src/index.ts:122`，`ctx.provide('gateway', service)`）。`inject.optional = ['agent']`（`:15-17`）—— 没有 agent 时仍可处理出站、运行钩子链，dispatch 兜底给一条系统提示（`:26-38`）。

**消费方分两类：**

- **直接调服务（`getService('gateway')`）** —— 主要是 agent 自己回话，外加主动注入消息的系统侧触发器：
  - `packages/plugin-agent/src/index.ts:1619`：**主出站流** —— agent 生成回复后 `gateway.dispatchOutbound(message)` 把出站消息交给 gateway 跑出站洋葱（缺失时回退 `ctx.emit('outbound:message', message)`，中间件链被跳过）。
  - `packages/plugin-flow-control/src/idle-scheduler.ts:26-31`：idle 触发，`gateway.ingressMessage(msg)`，缺失时回退 `ctx.emit('inbound:message', msg)`。
  - `packages/plugin-session-confirm/src/index.ts:141`：取 gateway 走出站总线投递确认提示。
- **注册到相位 hook（不直接持有服务，靠 `inject.required: ['gateway']` 声明顺序依赖）** —— 各中间件占据一个语义相位：
  - `plugin-session-confirm` → `INBOUND_PHASE.CONFIRM`（`packages/plugin-session-confirm/src/index.ts:159`）
  - `plugin-commands` → `INBOUND_PHASE.COMMAND`（`packages/plugin-commands/src/index.ts:170`）
  - `plugin-flow-control` → `INBOUND_PHASE.FLOW`
  - `plugin-trigger-policy` → `INBOUND_PHASE.TRIGGER`

**平台适配器既不直接调服务、也不注册相位**：它只往事件总线发 `inbound:message`、监听 `outbound:message`。例如 `@aalis/plugin-adapter-onebot`（`provides = ['platform']`，`packages/plugin-adapter-onebot/src/index.ts:73`）在 `:1746` 等多处 `ctx.emit('inbound:message', {...})`，在 `:2208` `ctx.on('outbound:message', ...)` 发送。这种「适配器只碰事件总线，gateway 接管编排」是有意的解耦：适配器**不需要** `inject` gateway，加载顺序也无所谓（事件是后期绑定的）。

## 4. 写一个 provider（替换 gateway 实现 —— 少见）

通常你不需要重写 gateway；默认实现已覆盖五相位 + 出站洋葱。仅当你要替换整套编排策略时才自己 provide `gateway`。

**最小必须实现**：`ingressMessage` 与 `dispatchOutbound` 两个方法 + 监听 `inbound:message` 把消息喂进 `ingressMessage`。**可选但强烈建议**：保留相位调度与 `gateway:phase:done` 遥测，否则现有 `plugin-commands` / `plugin-flow-control` 等相位插件会失效。

`package.json` 的 `aalis.service` 与源码 `provides` / `inject` **双源必须同步**（参考默认实现 `packages/plugin-gateway/package.json` 的 `aalis.service.provides: ['gateway']` + `optional: ['agent']`）：

```jsonc
// package.json
{
  "keywords": ["aalis", "aalis-plugin"],
  "aalis": {
    "service": {
      "provides": ["gateway"],
      "optional": ["agent"]
    }
  }
}
```

可编译最小骨架（与默认实现同构，仅留主干）：

```ts
import type { Context } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { GatewayService, InboundPhaseData } from '@aalis/plugin-gateway-api';
import { INBOUND_PHASE, INBOUND_PHASE_ORDER } from '@aalis/plugin-gateway-api';
import type { IncomingMessage, OutgoingMessage } from '@aalis/plugin-message-api';

export const name = '@aalis/plugin-gateway';
export const provides = ['gateway'];
export const inject = { optional: ['agent'] };

export function apply(ctx: Context): void {
  async function dispatchOutbound(message: OutgoingMessage): Promise<void> {
    const data = { message, metadata: {} as Record<string, unknown> };
    await ctx.hooks.run('outbound:dispatch', data, async () => {
      await ctx.emit('outbound:message', data.message);
    });
  }

  async function processInbound(message: IncomingMessage): Promise<void> {
    // 每次入站重新取 agent —— provider bounce 后旧引用会失效，禁止缓存。
    const agent = ctx.getService<AgentService>('agent');
    const data: InboundPhaseData = { message, metadata: {}, agent };

    // 前置相位 = 顺序里除终相 DISPATCH 外全部；新增相位只改 gateway-api，这里零改动。
    for (const phase of INBOUND_PHASE_ORDER.filter(p => p !== INBOUND_PHASE.DISPATCH)) {
      const reachedEnd = await ctx.hooks.run(phase, data);
      if (!reachedEnd) return; // 被 swallow，停止后续调度，不触达 agent
    }

    // 终相 dispatch：默认动作调用 agent
    await ctx.hooks.run(INBOUND_PHASE.DISPATCH, data, async () => {
      if (data.agent) await data.agent.handleMessage(data.message);
    });
  }

  ctx.on('inbound:message', msg => { void processInbound(msg); });

  const service: GatewayService = {
    ingressMessage: msg => processInbound(msg),   // 直接走内部路径，避免事件递归歧义
    dispatchOutbound,
  };
  ctx.provide('gateway', service);
}
```

> `ctx.provide` 无需传 priority —— gateway 一般是单提供方。同名竞争时的胜者规则是 `preference > priority(ServicePriority) > 注册顺序`（无能力匹配，0.5.0 已移除）；细节见 `concepts/service-model.md`。

## 5. 写一个平台适配器（最常见 —— 这是「适配器如何插入」的答案）

适配器不实现 `gateway`，也不 `inject` 它。它 `provides = ['platform']`，只与事件总线交互：

- **入站**：把平台原始消息映射成 `IncomingMessage`，`ctx.emit('inbound:message', msg)`。gateway 会自动接管相位链；适配器**不要**自己做命令/流控/触发判定（这些是相位插件的职责，参考 `packages/plugin-adapter-onebot/src/index.ts:1719` 注释「适配器不再做流控/触发判定」）。
- **出站**：`ctx.on('outbound:message', msg)`，按 `msg.sessionId` 前缀（如 `'onebot:'`）认领属于自己平台的消息再发送（`packages/plugin-adapter-onebot/src/index.ts:2208-2209`）。

```ts
export const provides = ['platform'];
// 注意：不 inject 'gateway' —— 事件是后期绑定，与加载顺序无关。

export function apply(ctx: Context): void {
  // 入站：原始消息 → IncomingMessage → 事件总线（gateway 接管编排）
  platformClient.onMessage(raw => {
    ctx.emit('inbound:message', {
      content: raw.text,
      sessionId: `myplat:${raw.chatId}`, // 用平台前缀，便于出站时按前缀认领
      platform: 'myplat',
      userId: raw.senderId,
      sessionType: raw.isGroup ? 'group' : 'private',
      // triggerType / actor / senderRole / replyTo … 按需填，见 message-api:161-241
    });
  });

  // 出站：只认领自己平台的消息
  ctx.on('outbound:message', async msg => {
    if (!msg.sessionId.startsWith('myplat:')) return;
    await platformClient.send(msg.sessionId.slice('myplat:'.length), msg.content);
  });
}
```

> 想从系统侧（非用户消息）主动喂入一条消息（idle / 定时 / 自检），优先 `getService<GatewayService>('gateway')?.ingressMessage(msg)`，缺失时回退 `ctx.emit('inbound:message', msg)`（参考 idle-scheduler 的写法）。两者都会走完整入站相位链。

## 6. 标准消费姿势

- **lazy getService，每次用时重新取，不缓存**：`const gw = ctx.getService<GatewayService>('gateway')`。provider bounce（卸载/重载）会让旧引用失效；缓存到模块/闭包变量是 bug。详见 `concepts/lazy-service-access.md`。
- **gateway 视为可选依赖时给出回退**：idle-scheduler 的范式是 `gateway ? gateway.ingressMessage(msg) : ctx.emit('inbound:message', msg)`（`packages/plugin-flow-control/src/idle-scheduler.ts:26-31`）。若你的相位插件**必须**有 gateway 才有意义，则在 manifest 写 `inject.required: ['gateway']`（如 session-confirm，`packages/plugin-session-confirm/src/index.ts:28-31`），让 core 保证加载顺序。
- **注册相位 = 用 `ctx.middleware(INBOUND_PHASE.X, (data, next) => ...)`**：洋葱模型，`await next()` 放行进入后续相位；**不调用 `next()`** 即「我已处理」，整条入站管道立即停止、不触达 agent（`packages/plugin-commands/src/index.ts:170-220`）。相位内多个 handler 按注册顺序执行，无需优先级数字。`ctx.middleware` 签名见 `packages/core/src/context.ts:460`。
- **错误边界**：默认实现把 `processInbound` / `dispatchOutbound` 整体 try/catch 并降级为 `logger.warn`（`packages/plugin-gateway/src/index.ts:89-91`、`:101-103`）—— 单条消息出错不拖垮总线。你的相位 handler 也应自行兜底，别让异常冒泡出相位链。

## 7. 能力 / 风险 → 影响

- **出站统一收口**：业务层**不应**再直接 `ctx.emit('outbound:message', msg)`，而应 `dispatchOutbound()`，以便所有出站消息都经过 `outbound:dispatch` 钩子链做脱敏 / 限速 / 审计（`packages/plugin-gateway-api/src/index.ts:76-94`）。直接 emit 会绕过这些守卫。适配器**监听** `outbound:message` 仍是合法的（它是链尾的最终发送指令）。
- **CONFIRM 相位与在途生成的 abort**：`inbound:confirm` 刻意排在最前。会话内待确认回复（Y/YS/否）命中即被吞掉、不进入后续相位，从而**不触发** `agent.handleMessage` 对在途生成的 abort —— 确认回送得以成立（`packages/plugin-gateway-api/src/index.ts:107-108`、`packages/plugin-session-confirm/src/index.ts:158-159`）。若你新增相位插在 CONFIRM 之前并 swallow 消息，会破坏这一语义。人在回路确认机制本身见 `concepts/security-model.md` 与 `core/authority.md`。
- **授权身份用 `actor` 而非 `userId`**：系统侧触发器（scheduler / idle / proactive 委派）投递的 `IncomingMessage` 应填 `actor: { platform, userId }`，表示「AI 代谁执行」；agent 构造工具调用上下文时优先用 `actor` 查权限等级，避免提权（`packages/plugin-message-api/src/index.ts:225-240`）。`actor` 不能由 LLM 在工具入参里自由指定。
- **跨会话 / 并发隔离**：`IncomingMessage.source` 用于并发隔离 —— 同一 `sessionId` 不同 `source` 互不打断（`packages/plugin-message-api/src/index.ts:186-187`）。适配器 / 触发器填对 `source` 才能让 agent 正确做打断决策。
- gateway 自身不碰 storage / 网络出口；附件落盘、SSRF 守卫（`safeFetch`）等是适配器与 media 层的事，见 `concepts/storage-uri-grammar.md` / `concepts/security-model.md`。

## 8. 边界与坑

- **没有 core 兜底路由**：`gateway-api` 头部注释提到「最小应用可不加载 gateway，由 core fallback 入站路由直接派发给 agent」（`packages/plugin-gateway-api/src/index.ts:12-13`），但**当前 core 已无此 fallback** —— `packages/core/src/app.ts:342` 仅留注释「路由由 plugin-gateway 承担」，`start()` 不再注册任何 `inbound:message` 监听。结论：不加载 gateway，`inbound:message` 无人消费、消息静默丢弃。该注释是历史遗留，按「gateway 是必需件」对待。
- **`outbound:message` 直发仍被容忍但属旧路径**：契约注释说 emit 出站「将逐步迁移」（`packages/plugin-gateway-api/src/index.ts:88-92`）。现状是两条路并存，新代码一律走 `dispatchOutbound()`。
- **相位顺序是单一真相，只在 gateway-api 改**：默认实现用 `INBOUND_PHASE_ORDER.filter(p => p !== DISPATCH)` 推导前置相位（`packages/plugin-gateway/src/index.ts:56-58`）。新增相位**只**改 `gateway-api` 的常量数组，调度方零改动；不要在自己插件里硬编码相位顺序。
- **`ingressMessage` 走内部路径而非再 emit**：默认实现里 `ingressMessage` 直接调 `processInbound`，刻意避免「emit → 自己监听 → 再处理」的事件总线递归歧义（`packages/plugin-gateway/src/index.ts:113-116`）。你若重写 gateway 应保持这一点。

## 9. 交叉链接

- 服务模型 / 同名竞争 / DI 选择规则：`concepts/service-model.md`、`core/service.md`
- 懒取服务、provider bounce：`concepts/lazy-service-access.md`
- 双源 manifest（`package.json aalis.service` vs `provides`/`inject`）：`concepts/manifest-metadata.md`
- 消息载体类型与端到端流水线：`concepts/message-llm-pipeline.md`（`IncomingMessage` / `OutgoingMessage` 在 `@aalis/plugin-message-api`）
- 确认 / 人在回路 / 授权：`concepts/security-model.md`、`core/authority.md`
- 相位 hook / 洋葱中间件机制：`core/events.md`、`packages/core/src/hooks.ts`、`packages/core/src/context.ts:460`
- 存储 URI 文法（适配器附件落盘相关）：`concepts/storage-uri-grammar.md`
