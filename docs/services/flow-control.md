# flow-control 服务

## 1. 定位

`flow-control` 是会话级的**节流硬闸**：禁言、回复后冷却、限速窗口。它只回答"现在能不能说"，不参与"要不要开口"——后者由 `@aalis/plugin-trigger-policy` 在前一相位判定（@ / 名字 / 计数与评分 / 闲置主动开口）。

- 服务注册名：`'flow-control'`（描述符 `flowControl`，读 `flowControl.current`）
- 契约包：`@aalis/api-flow-control`
- 参考实现：`@aalis/plugin-flow-control`
- 相邻相位：`inbound:trigger`（trigger-policy）→ `inbound:flow`（本服务的参考实现）→ `inbound:dispatch`。

## 2. 契约

完整接口（`packages/api-flow-control/src/index.ts`）：

```ts
export interface FlowControlService {
  /** 当前是否在禁言期 */
  isMuted(sessionId: string): boolean;
  /** 当前是否在回复后冷却期 */
  isCoolingDown(sessionId: string): boolean;
  /** 限速窗口内的回复数是否已达上限（true 表示已超限） */
  isRateLimited(sessionId: string): boolean;
  /**
   * 设置或解除禁言（禁言关键词命中或平台禁言事件时调用）。
   * - durationSec > 0：禁言到 now + durationSec 秒
   * - durationSec <= 0：解除禁言
   * 会话尚无流控状态时，只有同时给出 platform 才会建立状态并禁言。
   */
  setMuted(sessionId: string, durationSec: number, platform?: string): void;
}
```

要点：

- 三个查询方法对未知会话返回 `false`（无状态即不限制）。
- 冷却与限速按 agent 的真实回复（`outbound:message` 且 `source === 'agent'`）计，由实现自己监听，契约不暴露记账方法。
- 类型随描述符走：下游 `import { flowControl } from '@aalis/api-flow-control'` 写进 `uses` 即可，不必依赖实现包。

## 3. 谁提供 / 谁消费

**提供方（参考实现）**：`@aalis/plugin-flow-control`，`provide(flowControl, service)`（`packages/plugin-flow-control/src/index.ts`）。它同时占据 `inbound:flow` 相位做硬闸，并监听 `outbound:message` 记冷却与限速。

**消费点**（全部 `optional`，缺席即不设闸）：

- `@aalis/plugin-trigger-policy`：`isMuted` 决定禁言期不计数、不识别关键词；命中禁言关键词时 `setMuted`；session 档闲置到点前查 `isMuted`，platform 档挑候选时排除 `isMuted` / `isCoolingDown` / `isRateLimited` 为真的会话（`packages/plugin-trigger-policy/src/index.ts`、`packages/plugin-trigger-policy/src/idle-scheduler.ts`）。
- `@aalis/plugin-adapter-onebot`：bot 自身被禁言/解禁的 notice、重连后按 `shut_up_timestamp` 恢复时调 `setMuted`（`packages/plugin-adapter-onebot/src/index.ts`）。
- `@aalis/plugin-tool-session`：`delegate_to_session` 派发前查目标会话，`isMuted` 或 `isRateLimited` 为真即拒绝（`packages/plugin-tool-session/src/index.ts`）。只检不记：限速按目标会话的真实回复计，派发到回复落地之间对同一目标的突发委派不占槽，可能越过限速。

## 4. 写一个 provider

替换默认实现时须实现整个 `FlowControlService`，并把 `inbound:flow` 中间件与 `outbound:message` 记账一并搬过来，否则禁言、冷却、限速闸门会失效。双源 manifest 必须同步（`package.json` 的 `aalis.service` 与源码 `provides` / `uses`，见 [concepts/manifest-metadata](../concepts/manifest-metadata.md)）。

参考实现的 `package.json` → `aalis.service`：

```json
{ "aalis": { "service": {
  "required": ["config", "events", "hooks", "lifecycle", "logger", "provide"],
  "optional": ["storage", "message-archive"],
  "provides": ["flow-control"]
} } }
```

最小骨架（省略禁言持久化与分作用域覆盖）：

```ts
import { type FlowControlService, flowControl } from '@aalis/api-flow-control';
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { definePlugin, events, provide } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-my-flow-control',
  provides: [flowControl],
  uses: { provide, hooks, events },
  apply({ provide, hooks, events }) {
    const mutedUntil = new Map<string, number>();
    const cooldownUntil = new Map<string, number>();

    const service: FlowControlService = {
      isMuted: sid => Date.now() < (mutedUntil.get(sid) ?? 0),
      isCoolingDown: sid => Date.now() < (cooldownUntil.get(sid) ?? 0),
      isRateLimited: () => false,
      setMuted(sid, sec) {
        if (sec > 0) mutedUntil.set(sid, Date.now() + sec * 1000);
        else mutedUntil.delete(sid);
      },
    };
    provide(flowControl, service);

    hooks.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
      const { message } = data;
      if (service.isMuted(message.sessionId)) return; // 禁言期一律不说话
      // immediate 穿透冷却；带 source 的内部注入不过冷却（限速仍挡，示例从略）
      if (message.triggerType !== 'immediate' && !message.source && service.isCoolingDown(message.sessionId)) return;
      await next();
    });

    events.on('outbound:message', msg => {
      if (msg.source === 'agent' && msg.sessionId) cooldownUntil.set(msg.sessionId, Date.now() + 10_000);
    });
  },
});
```

`flow-control` 是单实例服务，用全局 `Map<sessionId, state>` 管多会话，不需要 `entryId`；`priority` 留默认即可。同名胜出规则见 [concepts/service-model](../concepts/service-model.md)。

## 5. 标准消费方式

按 [concepts/lazy-service-access](../concepts/lazy-service-access.md)：**每次用都 `current` 现取，不缓存引用**。缺席时按"不设闸"处理：

```ts
// 委派派发前（packages/plugin-tool-session/src/index.ts）
const flow = flowControl.current;
if (flow?.isMuted(targetSessionId)) return JSON.stringify({ error: '委派被拒：目标会话处于禁言期' });
if (flow?.isRateLimited(targetSessionId)) return JSON.stringify({ error: '委派被拒：目标会话已达流控限速上限' });
```

## 6. 行为不变量

- **禁言不看作用域、不看来源**。`inbound:flow` 先查禁言：闲置触发、跨会话委派、定时任务注入的消息在禁言期同样被吞。禁言状态只由关键词或平台禁言针对具体会话写入，所以不会误伤作用域外的会话。
- **immediate 穿透冷却与限速**。被 @、戳一戳、叫名字时即使处于冷却或限速窗口也放行；禁言期除外。带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）不受冷却约束，但仍受禁言与限速约束（限速只在作用域内时）。内部注入不带会话类型，判作用域与回复记账同一口径：先用会话已记下的类型，没有再按会话 ID 约定推断，所以默认 `*:group` 下 bot 在某个群的限速窗口已满时，发往该群的内部注入同样被挡下。
- **作用域先于关键词**。`scopes` / `overrides` 用 `platform:sessionType[:targetId]` 三段通配匹配（匹配函数在 `packages/api-gateway/src/index.ts`，默认 `*:group`）。trigger-policy 在识别禁言关键词之前先判作用域，否则群聊的禁言关键词会作用到 WebUI、私聊等不在作用域内的会话。
- **禁言态要持久化**。禁言可能是小时级的用户意图，参考实现把 `mutedUntil` 落盘到 `data:/flow-control-mutes.json`，冷却与限速不落盘。该文件读不懂（不存在以外的读取错误、解析失败、顶层不是对象）时，本次运行不再整表回写，禁言改动只在内存生效，storage 换人重读时重新判定。换 provider 时若不持久化，重启会让被禁言的群立即恢复发言。
- **限速是防刷屏与平台风控的护栏**。冷却与限速记在 agent 真实回复上，只对作用域内会话记账：按会话已记下的类型判；没有流控状态或状态缺类型的会话（如重启后没人说话的群、只有禁言记录的群）按会话 ID 的 `<platform>:<self>:<type>:<target>` 约定推断类型与目标（`inferSessionScope`，在 `packages/api-gateway/src/index.ts`），推断结果只写进流控自己的状态、不回写消息，入站带 `source` 的内部注入判作用域也用这一口径；会话 ID 不符合约定的（如 WebUI）类型未知，只有会话类型段为通配的作用域（`onebot:*`、`*`）命中。委派闸门读的就是这份记账，作用域外的会话不设限。自建主动发送通道应发 `source: 'agent'` 的 `outbound:message`，才能被计入。

## 7. 注意事项与边界情形

**影子归档顺序竞态（现状未收口）**。被吞掉的入站消息会做影子归档，下次触发时作为上下文：

- `flow-control` 与 `trigger-policy` 的 `shadowArchive`（`packages/plugin-flow-control/src/index.ts`、`packages/plugin-trigger-policy/src/index.ts`）都直接 `await archive.archiveIncoming(message)`。
- 真正触发回合的消息走 agent 的串行归档车道 `archiveIncomingMessageInOrder`（`packages/plugin-agent/src/index.ts`）。
- 两条路径不共享车道，`archiveIncoming` 以 `Date.now()` 作时间戳（`packages/plugin-message-archive/src/index.ts`）。吞掉与触发在毫秒级交错时，归档可能乱序或时间戳并列。

消息都会进档、都会发 `inbound:message:archived`，但会话内严格时序不保证。依赖严格时序的下游应以单调序列号而非 `Date.now()` 排序。闲置触发的合成提示不做影子归档（与 agent 的归档规则一致）。

**其它**：

- 命令回复与系统回复（`source` 不是 `agent`）不计冷却与限速。
- 会话状态每天扫描一次，无挂起禁言/冷却且 30 天未见的会话被删除。

## 8. 交叉链接

- [plugins/plugin-flow-control](../plugins/plugin-flow-control.md)、[plugins/plugin-trigger-policy](../plugins/plugin-trigger-policy.md) — 两个相位的处理顺序与配置。
- [services/gateway](./gateway.md) — 入站相位 `CONFIRM → COMMAND → TRIGGER → FLOW → DISPATCH`（相位常量见 `packages/api-gateway/src/index.ts`）。
- [concepts/service-model](../concepts/service-model.md)、[concepts/lazy-service-access](../concepts/lazy-service-access.md) — 服务选名规则、现取不缓存。
- [concepts/manifest-metadata](../concepts/manifest-metadata.md) — `provides` / `uses` 双源同步。
- [concepts/storage-uri-grammar](../concepts/storage-uri-grammar.md) — 禁言持久化用的 `data:` root 文法。
- [services/message-archive](./message-archive.md) — `archiveIncoming` 语义与 `inbound:message:archived` 事件。
