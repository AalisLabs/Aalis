# 会话级工具状态服务（tool-session）

> 受众：编写或消费「按会话隔离的工具状态」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话历史读取」这个具体服务上的落点。

文件名 `tool-session` 是历史上的分组名，Aalis 里没有名为 `'tool-session'` 的服务：本文讲的是 `session-history` 服务（跨会话历史读取与平台访问规则），契约 `@aalis/api-session-history`，实现 `@aalis/plugin-tool-session`。它遵循「`sessionId` 是会话隔离边界」这一约束，见 [§8 会话隔离](#session-isolation)。用户上传的文件不经服务取用，只经 [plugin-file-reader](../plugins/plugin-file-reader.md) 自己的工具与会话面板给出。

## 1. 定位

**按 Aalis `sessionId` 读取某会话的消息历史，并给平台插件提供注入「跨会话读取访问规则」的钩子。** 消费方经 `sessionHistory.use` 调用，契约包 `@aalis/api-session-history`。

它不是存储后端——历史数据来自 `memory` 服务；本服务是「读取入口 + 访问控制链 + 给 LLM 的工具壳（`session_get_history`）」。设计上保证**通用工具与平台专属工具都走同一条 access-checker 链，不存在绕过路径**（`packages/api-session-history/src/index.ts`）。

## 2. 契约（`@aalis/api-session-history/src/index.ts`）

核心接口（`index.ts`）：

```ts
export interface SessionHistoryService {
  getHistory(
    options: {
      sessionId: string;
      limit?: number;
      includeArchived?: boolean;
      sinceTs?: number;   // 给 sinceTs/untilTs 任一 → 进入时间区间检索
      untilTs?: number;
    },
    callCtx: ToolCallContext,
  ): Promise<SessionHistoryReadResult>;

  registerAccessChecker(checker: AccessChecker): AccessCheckerDisposer;
}
```

返回类型 `SessionHistoryReadResult`（`index.ts`）是判别联合：成功为 `{ ok: true; sessionId; count; limit; includeArchived; range?; truncated?; messages }`，失败为 `{ error: string }`——**没有 `ok: false` 形态，错误分支只有 `error` 字段**，消费方用 `'error' in result` 判别。

访问规则三件套：
- `AccessChecker`（`index.ts`）：`{ platform: string; check(args): AccessDecision | undefined }`。`check` 是**同步**的；只对 `targetSessionId.startsWith(platform + ':')` 的目标生效。
- `AccessCheckArgs`（`index.ts`）：`{ currentSessionId; targetSessionId; callCtx }`。
- `AccessDecision`（`index.ts`）：`{ decision: 'allow' | 'deny'; reason? }`；返回 `undefined` 表示「不表态，交给后续 checker / 默认放行」。
- `AccessCheckerDisposer`（`index.ts`）：`() => void`，插件 dispose 时调用解绑。

判定语义：**any-deny 短路** —— 同一 platform 多个 checker，任一返回 `deny` 即拒绝（`index.ts`，实现见 `plugin-tool-session/src/index.ts`）。

契约导出描述符 `sessionHistory = defineService<SessionHistoryService>('session-history')`（`index.ts`），消费方把描述符写进 `uses` 即得类型，`sessionHistory.use` 无需手写泛型。

## 3. 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-tool-session`（`packages/plugin-tool-session/src/index.ts`）

```ts
const historyService = createSessionHistoryService(caps, cfg);
caps.provide.use(sessionHistory, historyService, { label: '会话历史读取' });
```

它还注册了 LLM 工具 `session_get_history`（`index.ts`，handler 转调 `historyService.getHistory`）。

**消费点**：
- `@aalis/plugin-tool-onebot`：注入访问规则（`packages/plugin-tool-onebot/src/index.ts`）+ 平台专属工具 `onebot_get_session_history` 转调本服务（`index.ts`）。这是**最完整的「写 provider 之外的消费」范例**。
- `@aalis/plugin-memory-history`：把它的跨会话查询工具挂进 `'session-history'` 工具分组（`packages/plugin-memory-history/src/index.ts`），属于 UI 分组复用，不调用服务接口本身。

注意：`session-history` 这个名字**在工具分组层面被多个插件共享贡献**，但**服务实例**目前只有 `plugin-tool-session` 一个 provider。

## 4. 写一个 provider

通常你不需要重写 `session-history`——更常见的是**给已有 provider 注入平台访问规则**（见第 5 节）。若确要替换实现（例如对接非 memory 的历史后端），最小骨架：

```ts
import { sessionHistory } from '@aalis/api-session-history';
import type { SessionHistoryService } from '@aalis/api-session-history';
import { definePlugin, provide } from '@aalis/core';

export default definePlugin({
  name: '@you/plugin-my-history',
  provides: [sessionHistory],
  uses: { provide },
  apply({ provide }) {
    const checkers: import('@aalis/api-session-history').AccessChecker[] = [];
    const svc: SessionHistoryService = {
      registerAccessChecker(checker) {
        checkers.push(checker);
        return () => {
          const i = checkers.indexOf(checker);
          if (i >= 0) checkers.splice(i, 1);
        };
      },
      async getHistory(options, callCtx) {
        const target = String(options.sessionId ?? '').trim();
        if (!target) return { error: 'sessionId 不能为空' };
        const platform = target.split(':')[0] ?? '';
        for (const c of checkers.filter(ch => ch.platform === platform)) {
          const v = c.check({
            currentSessionId: callCtx.sessionId,
            targetSessionId: target,
            callCtx,
          });
          if (v?.decision === 'deny') return { error: v.reason ?? '访问被拒绝' };
        }
        return {
          ok: true,
          sessionId: target,
          count: 0,
          limit: options.limit ?? 20,
          includeArchived: false,
          messages: [],
        };
      },
    };
    provide.use(sessionHistory, svc, { label: '我的历史读取' });
  },
});
```

要点：
- **必须** `provides` / `uses` 双源与 `package.json` 的 `aalis.service.provides` 同步（[清单元数据](../concepts/manifest-metadata.md)）。
- `getHistory` **必须自己执行 access-checker 链**——否则注入规则的平台插件被静默架空，破坏「无绕过」契约。
- 失败返回 `{ error }`，**不要** throw 到工具壳外。

## 5. 标准用法

**注入平台访问规则**（OneBot 的范式，`plugin-tool-onebot/src/index.ts`）：

```ts
// 规则登记在提供者实例上：跟随提供者挂载，提供者重启、晚到或换人时自动重挂（见第 7 节常见错误①）
sessionHistory.follow(history =>
  history.registerAccessChecker({
    platform: 'onebot',
    check({ currentSessionId, targetSessionId }) {
      // 只对 onebot:* 目标表态；其它返回 undefined
      // deny → 立即拒；allow/undefined → 交给后续 checker / 默认放行
      return /* ...你的细粒度规则... */ undefined;
    },
  }),
);
```

`registerAccessChecker` 返回的注销函数作为跟随的清理：提供者离场或本插件关闭时撤回。`sessionHistory` 缺席时回调不执行，可选依赖无需额外判断。

**直接读取历史**（平台专属工具的范式，`plugin-tool-onebot/src/index.ts`）：可选依赖先看 `present`，再经业务句柄 `sessionHistory.use` 调用（句柄的规则见 [选择层与业务层](../core/context.md#选择层与业务层)）：

```ts
if (!sessionHistory.present) return JSON.stringify({ error: 'session-history 服务不可用，请启用 @aalis/plugin-tool-session' });
const history = sessionHistory.use;
const result = await history.getHistory({ sessionId, limit }, callCtx);
```

`uses` 里把它列为 `optional`（`plugin-tool-onebot/src/index.ts`：`sessionHistory: optional(sessionHistory)`）——它不是硬依赖，缺失时优雅降级。

## 6. 能力 / 风险

- **访问控制是跨会话读取的唯一闸门**，分三段（实现 `plugin-tool-session/src/index.ts`）：⓪当前会话所在房间的召回范围（会话配置 `memoryRecallScope`，经可选的 session-manager 每次现算）：`session` 时目标不是当前会话一律拒绝，`platform` 时跨平台拒绝，未设置或 session-manager 不在场时跳过；①service 自带的 `scope` 配置粗筛（`current` / `platform` / `all`，默认 `platform`，`index.ts`）；②匹配 `targetPlatform` 的 checker 链 any-deny 精筛。平台 checker 只能在前两段放行之后再收窄。`scope=all` 且房间未设召回范围时只剩 checker 链兜底——平台插件若未注册 checker，`all` 模式下跨会话读取便失去精筛防线。
- 这与 [鉴权系统](../plugins/plugin-authority.md) 的 level/risk 是两套机制：`session_get_history` 工具本身的 minLevel 由工具的 risk 决定（见 [工具](../plugins/plugin-tools.md)），而**跨会话边界**则由本服务的 scope+checker 决定。二者叠加，缺一不可。
- 本服务**不做** SSRF / 沙箱：它只读已落库的会话消息，无外部 egress。

## 7. 注意事项与边界情形

- **常见错误①**：只在 `app:ready` 里经 `sessionHistory.use` 调一次 `registerAccessChecker`。规则存在提供者实例的局部状态里，tool-session 重启（改配置、市场更新、依赖重启连带）或晚于本插件上线时，新实例上没有这条规则，细粒度限制静默失效。应按第 5 节用 `follow` 跟随提供者注册（OneBot 曾有此问题，已修复）。
- **时间区间模式**：给 `sinceTs`/`untilTs` 任一即进入区间检索；此模式恒含归档记录，结果 `includeArchived` 字段会回显实际生效值（`plugin-tool-session/src/index.ts`）。后端无原生区间查询（`memory.getMessagesBySessionRange` 缺失）时退回扫描 `RANGE_FALLBACK_SCAN=5000` 条客户端过滤，极早窗口可能不全；窗口内超 `limit` 时置 `truncated: true` 而非静默丢弃。
- `getHistory` 强依赖 `memory` 服务：缺失直接返回 `{ error: 'memory 服务不可用' }`（`index.ts`）。所以参考实现把 `memory` 列为 `optional`（运行期检测）而非 `required`。

---

<a id="session-isolation"></a>

## 8. 会话隔离 / 访问控制（provider + consumer 必守）

不变量：**`sessionId` 是会话隔离边界**。
- 跨 `sessionId` 读取必须过房间召回范围 + scope 粗筛 + platform checker 链；provider 重写时**必须**自己跑这三段。
- 从 `callCtx.sessionId`（`ToolCallContext`）拿「当前会话」，从不信任入参里的会话身份。

## 9. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)、[惰性服务访问](../concepts/lazy-service-access.md)、[清单元数据](../concepts/manifest-metadata.md)、[storage URI 文法](../concepts/storage-uri-grammar.md)、[安全模型](../concepts/security-model.md)、[消息→LLM 管线](../concepts/message-llm-pipeline.md)
- 核心：[服务](../core/service.md)、[鉴权](../plugins/plugin-authority.md)、[工具](../plugins/plugin-tools.md)、[上下文](../core/context.md)
