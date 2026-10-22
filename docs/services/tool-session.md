# 会话级工具状态服务（tool-session）

> 受众：编写或消费「按会话隔离的工具状态」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话历史读取」这个具体服务上的落点。

文件名 `tool-session` 是历史上的分组名，Aalis 里没有名为 `'tool-session'` 的服务：本文讲的是 `session-history` 服务（按会话 id 读历史），契约 `@aalis/api-session-history`，实现 `@aalis/plugin-tool-session`。它遵循「`sessionId` 是会话隔离边界」这一约束，见 [§8 会话隔离](#session-isolation)。用户上传的文件不经服务取用，只经 [plugin-file-reader](../plugins/plugin-file-reader.md) 自己的工具与会话面板给出。

## 1. 定位

**按 Aalis `sessionId` 读取某会话的消息历史。** 消费方经 `sessionHistory.use` 调用，契约包 `@aalis/api-session-history`。

它不是存储后端——历史数据来自 `memory` 服务；本服务是「读取入口 + 给 LLM 的工具壳（`session_get_history`）」。能不能读目标会话不由它定：每次读都调会话管理的取别的会话的规则（`@aalis/api-session-manager` 的 `takeFrom`），通用工具与平台专属工具都经 `getHistory`，同一条规则，没有绕过路径。

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
}
```

`callCtx` 的会话是取的一方，授权身份取 `callCtx.actor`（没有时取 `platform` 与 `userId`）；规则不放行时回 `{ error: 原因 }`。

返回类型 `SessionHistoryReadResult`（`index.ts`）是判别联合：成功为 `{ ok: true; sessionId; count; limit; includeArchived; range?; truncated?; omittedNonConversation?; messages }`（`omittedNonConversation`：条数模式返回不满 `limit` 条时，读到的记录里略去的事件标记条数），失败为 `{ error: string }`——**没有 `ok: false` 形态，错误分支只有 `error` 字段**，消费方用 `'error' in result` 判别。

契约导出描述符 `sessionHistory = defineService<SessionHistoryService>('session-history')`（`index.ts`），消费方把描述符写进 `uses` 即得类型，`sessionHistory.use` 无需手写泛型。

## 3. 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-tool-session`（`packages/plugin-tool-session/src/index.ts`）

```ts
const historyService = createSessionHistoryService(caps, cfg);
caps.provide.use(sessionHistory, historyService, { label: '会话历史读取' });
```

它还注册了 LLM 工具 `session_get_history`（`index.ts`，handler 转调 `historyService.getHistory`）。

**消费点**：
- `@aalis/plugin-tool-onebot`：平台专属工具 `onebot_get_session_history` 把群号或 QQ 号拼成会话 id，转调本服务（`packages/plugin-tool-onebot/src/index.ts`）。这是**最完整的「写 provider 之外的消费」范例**。
- `@aalis/plugin-memory-history`：把它的跨会话查询工具挂进 `'session-history'` 工具分组（`packages/plugin-memory-history/src/index.ts`），属于 UI 分组复用，不调用服务接口本身。

注意：`session-history` 这个名字**在工具分组层面被多个插件共享贡献**，但**服务实例**目前只有 `plugin-tool-session` 一个 provider。

## 4. 写一个 provider

通常你不需要重写 `session-history`。若确要替换实现（例如对接非 memory 的历史后端），最小骨架：

```ts
import { sessionHistory } from '@aalis/api-session-history';
import type { SessionHistoryService } from '@aalis/api-session-history';
import { sessionManager, takeFrom } from '@aalis/api-session-manager';
import { definePlugin, optional, provide } from '@aalis/core';
import { toSource } from '@aalis/schema-i18n';

export default definePlugin({
  name: '@you/plugin-my-history',
  provides: [sessionHistory],
  uses: { provide, sessionManager: optional(sessionManager) },
  apply({ provide, sessionManager }) {
    const svc: SessionHistoryService = {
      async getHistory(options, callCtx) {
        const target = String(options.sessionId ?? '').trim();
        if (!target) return { error: 'sessionId 不能为空' };
        // 能不能读按会话管理的规则判，带这次调用的授权身份；会话管理不在时只放行当前会话
        const { userId } = callCtx;
        const principal = callCtx.actor ?? (userId ? { platform: callCtx.platform ?? '', userId } : undefined);
        const verdict = takeFrom(sessionManager, callCtx.sessionId, target, principal);
        if (!verdict.ok) return { error: toSource(verdict.reason) };
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
- `getHistory` **必须调 `takeFrom`**，不自己判范围、不各写会话管理不在时的退路——否则读历史的工具绕过了取别的会话的规则。
- 失败返回 `{ error }`，**不要** throw 到工具壳外。

## 5. 标准用法

**直接读取历史**（平台专属工具的范式，`plugin-tool-onebot/src/index.ts`）：可选依赖先看 `present`，再经业务句柄 `sessionHistory.use` 调用（句柄的规则见 [选择层与业务层](../core/context.md#选择层与业务层)），把这次调用的 `callCtx` 原样交过去，规则按它判：

```ts
if (!sessionHistory.present) return JSON.stringify({ error: 'session-history 服务不可用，请启用 @aalis/plugin-tool-session' });
const history = sessionHistory.use;
const result = await history.getHistory({ sessionId, limit }, callCtx);
```

`uses` 里把它列为 `optional`（`plugin-tool-onebot/src/index.ts`：`sessionHistory: optional(sessionHistory)`）——它不是硬依赖，缺失时优雅降级。

## 6. 能力 / 风险

- **能读哪些会话按会话管理的取别的会话的规则**（[会话管理服务](./session-manager.md) 的 `canTake`）：取别的会话的范围（本会话、同平台、全部，默认同平台）与读别的群、读别人的私聊、跨机器人账号三个开关是会话管理的按会话字段，对所有人一样；授权身份自己与她的私聊不用开关。本服务不再有自己的范围，也没有平台插件注入的检查器。
- 这与 [鉴权系统](../plugins/plugin-authority.md) 的 level/risk 是两套机制：`session_get_history` 工具本身的 minLevel 由工具的 risk 决定（见 [工具](../plugins/plugin-tools.md)），而**跨会话边界**由会话管理的规则决定。二者叠加，缺一不可。
- 本服务**不做** SSRF / 沙箱：它只读已落库的会话消息，无外部 egress。

## 7. 注意事项与边界情形

- **时间区间模式**：给 `sinceTs`/`untilTs` 任一即进入区间检索；此模式恒含归档记录，结果 `includeArchived` 字段会回显实际生效值（`plugin-tool-session/src/index.ts`）。后端无原生区间查询（`memory.getMessagesBySessionRange` 缺失）时退回扫描 `RANGE_FALLBACK_SCAN=5000` 条客户端过滤，极早窗口可能不全；窗口内超 `limit` 时置 `truncated: true` 而非静默丢弃。
- `getHistory` 强依赖 `memory` 服务：缺失直接返回 `{ error: 'memory 服务不可用' }`（`index.ts`）。所以参考实现把 `memory` 列为 `optional`（运行期检测）而非 `required`。
- 会话管理不在、目标不在会话表里或判不出窗口时，只读得到当前会话（规则回「判不出」）。

---

<a id="session-isolation"></a>

## 8. 会话隔离 / 访问控制（provider + consumer 必守）

不变量：**`sessionId` 是会话隔离边界**。
- 跨 `sessionId` 读取必须过会话管理的规则（`takeFrom`）；provider 重写时**必须**调它。
- 从 `callCtx.sessionId`（`ToolCallContext`）拿「当前会话」，从不信任入参里的会话身份。

## 9. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)、[惰性服务访问](../concepts/lazy-service-access.md)、[清单元数据](../concepts/manifest-metadata.md)、[storage URI 文法](../concepts/storage-uri-grammar.md)、[安全模型](../concepts/security-model.md)、[消息→LLM 管线](../concepts/message-llm-pipeline.md)
- 核心：[服务](../core/service.md)、[鉴权](../plugins/plugin-authority.md)、[工具](../plugins/plugin-tools.md)、[上下文](../core/context.md)
