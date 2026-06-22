# session-confirm 服务

## 1. 定位

`session-confirm` 是 Aalis 的**人在环（human-in-the-loop）确认协调器**：当 authority 判定某个能力命中 confirm 轴（轴 B「意图确认」），需要在用户所在会话里发出一条「回复 Y 确认 / 其他取消」的提示并等待应答时，由本服务统一承担「待确认登记 / 串行排队 / 超时 / 解析 Y-YS / 文案组合」这套**平台无关**的协调逻辑。

它刻意**不**自己投递提示、也**不**自己拦截回复——这两件事因平台而异（OneBot/CLI 走 gateway 总线，WebUI 走 WS）。本服务把协调器做成一个工厂 `createChannel(deliver)`：调用方注入「怎么把文案发给用户」的 `deliver`，拿回一条 `{ handler, feed, dispose }` 通道；把 `handler` 注册到 `authority.setConfirmHandler(platform, ...)`，在自己的拦截点调 `feed`。各平台经 DI 复用同一份协调器实现，零重复、零 plugin→plugin 依赖。

- 服务注册名：`session-confirm` —— 即 `ctx.getService<SessionConfirmService>('session-confirm')` 里的字符串。
- 契约包：`@aalis/plugin-session-confirm-api`（`packages/plugin-session-confirm-api/src/index.ts`）。
- 默认实现包：`@aalis/plugin-session-confirm`（`packages/plugin-session-confirm/src/index.ts`，`provides = ['session-confirm']`，`packages/plugin-session-confirm/src/index.ts:27`）。

> 这是「轴 B」的传输/协调层。**裁决**仍在 authority：哪条能力需要确认、确认成功后授不授临时委托，都是 authority 的事（见 §6 与 docs/concepts/security-model.md）。本服务只负责把 authority 抛来的 `AccessRequest` 变成一次会话内的一问一答。

## 2. 契约

来自 `packages/plugin-session-confirm-api/src/index.ts`。该 -api 既有**运行时服务**（`SessionConfirmService`），也复用 authority-api 的几个类型，无独立运行时实现（协调器实现在功能插件里）。

### 2.1 服务接口

```ts
// packages/plugin-session-confirm-api/src/index.ts:30-36
export interface SessionConfirmService {
  /**
   * 创建一条确认通道：用 deliver 投递提示文案到 request 所在会话；返回 { handler, feed }。
   * 调用方把 handler 注册到 authority.setConfirmHandler(platform, ...)，并在自己的拦截点调 feed。
   */
  createChannel(deliver: (request: AccessRequest, text: string) => void): ConfirmChannel;
}
```

### 2.2 ConfirmChannel —— 一条确认通道

```ts
// packages/plugin-session-confirm-api/src/index.ts:17-28
export interface ConfirmChannel {
  /** authority 确认回调（注册到 setConfirmHandler(platform, ...)）。 */
  handler: AccessConfirmHandler;
  /**
   * 在平台自己的拦截点喂一条回复给该 session 的未决确认。
   * 仅当 replyUserId === 发起确认的触发者 userId 时才消费（防群里第三方抢答）；私聊/webui 天然同人。
   * @returns 命中并消费 → true（调用方据此「吞掉」该输入）；无未决 / 非本人 → false（放行）。
   */
  feed(sessionId: string, replyText: string, replyUserId?: string): boolean;
  /** 卸载/热重载时清理：清所有未决确认的超时定时器并把挂起 Promise 安全拒掉（resolve false）。 */
  dispose(): void;
}
```

服务类型经 declaration merging 注册到 core：`ServiceTypeMap['session-confirm'] = SessionConfirmService`（`packages/plugin-session-confirm-api/src/index.ts:38-42`）。

### 2.3 复用 authority-api 的类型

`deliver`、`handler`、决策的形状都来自 `@aalis/plugin-authority-api`，写 provider/consumer 时需要懂这几个：

```ts
// packages/plugin-authority-api/src/index.ts:149-167
export interface AccessRequest {
  name: string;                       // 操作名（命令名 / 工具名）
  type: 'command' | 'tool';
  capability: CapabilityId;           // 触达的（受限）能力
  args?: Record<string, unknown>;
  sessionId: string;                  // 会话标识（群=群 id；私聊=用户）；feed 用它定位未决项
  platform: string;                   // 用于挑 setConfirmHandler(platform) 的 handler
  userId?: string;                    // 发起者；feed 用它防第三方抢答
  confirm?: CapabilityConfirm;        // 'session' | 'always'；'always' 不接受会话记忆
}

// packages/plugin-authority-api/src/index.ts:178-181
export interface AccessDecision {
  allowed: boolean;
  grant?: TemporaryGrantSpec;         // 批准后附带的临时委托范围（once / session）
}

// packages/plugin-authority-api/src/index.ts:199
export type AccessConfirmHandler = (request: AccessRequest) => Promise<boolean | AccessDecision>;

// packages/plugin-authority-api/src/index.ts:32
export type CapabilityConfirm = 'session' | 'always';
```

`AccessConfirmHandler` 返回 `boolean | AccessDecision`：`true`/`false` 是最简允许/拒绝；返回对象可附带 `grant`（如「本会话 10 分钟内放行」）。authority 侧 `normalizeDecision` 把 boolean 归一为 `{ allowed }`，并在 `grant.scope === 'session'` 时建立临时委托（`packages/plugin-authority/src/authority-manager.ts:154-156,178-180`）。

## 3. 谁提供 / 谁消费

### 提供方（参考实现）

- `@aalis/plugin-session-confirm`（`packages/plugin-session-confirm/src/index.ts`）：
  - `apply` 里 `ctx.provide('session-confirm', { createChannel })`（`packages/plugin-session-confirm/src/index.ts:136-137`）。
  - 同时它**自用**一条 bus 通道（`createChannel` 传入「投递走 gateway 总线」），并把这条通道的 `handler` 注册成 authority 的 `'*'` fallback、把 `feed` 挂到 `inbound:confirm` 相位——从而覆盖 OneBot/CLI 等「仅靠消息总线」的会话型平台（`packages/plugin-session-confirm/src/index.ts:139-164`）。
  - `inject`：`required: ['gateway']`、`optional: ['authority']`（`packages/plugin-session-confirm/src/index.ts:28-31`，与 `package.json` 的 `aalis.service` 双源一致）。注意它**依赖 gateway（投递/拦截通道），不依赖 authority 作为运行前提**——authority 缺席时仍能 provide 服务、只是没人调它的 handler。

### 消费方（典型消费点）

- `@aalis/plugin-webui-server`（`packages/plugin-webui-server/src/index.ts`）：标准「另一种平台复用同一协调器」的范例。
  - `ctx.whenService<SessionConfirmService>('session-confirm', ...)` 里 `createChannel`，注入**WS 投递**（`type: 'confirm'`，兼作前端「确认模式」信号，抑制富客户端的「打字即打断」），并把 `handler` 注册到 `authority.setConfirmHandler('webui', ...)`（`packages/plugin-webui-server/src/index.ts:952-964`）。
  - 在 WS `onmessage` 里调 `confirmChannel.feed(sessionId, trimmed, wsIdentity.userId)`，命中即 `return`（吞掉，不当普通消息处理）（`packages/plugin-webui-server/src/index.ts:1079-1082`）。
- `@aalis/plugin-authority`（`packages/plugin-authority/src/authority-manager.ts`）：不是直接 `getService('session-confirm')`，而是**经 `setConfirmHandler` 反向持有** handler。`requestAccess` 里取 `confirmHandlers.get(request.platform) ?? confirmHandlers.get('*')` 调用确认回调（`packages/plugin-authority/src/authority-manager.ts:98-99,142-161`）。这就是协调器 `handler` 被实际触发的入口。

## 4. 写一个 provider

绝大多数第三方**不需要**重写本服务——默认实现已是平台无关的成熟协调器。你更可能是要**为一个新平台接一条确认通道**（见 §5 的「按消费方姿势」），即复用现成 `createChannel`。

但如果你确实要替换/另写一个 `session-confirm` 实现（例如改文案、改超时、接入外部审批系统），契约只有一个方法：

### 最小必须 vs 可选

- **必须**：`createChannel(deliver)` 返回一个 `ConfirmChannel`，其 `handler` 是合法的 `AccessConfirmHandler`（接 `AccessRequest`、`await` 用户应答、resolve `boolean | AccessDecision`），`feed(sessionId, replyText, replyUserId?)` 在拦截点喂回复并返回是否命中，`dispose()` 在卸载时清定时器、安全拒掉所有挂起 Promise。
- **可选但强烈建议**：超时兜底（无人应答时 resolve `false` —— 默认实现 60s，见 `packages/plugin-session-confirm/src/index.ts:34,75-86`）；同一 session 多个并行确认请求的**串行 FIFO 排队**（同一回合并行工具可触发多个确认，不能抢占式互相 `resolve(false)`，见 `packages/plugin-session-confirm/src/index.ts:67-104`）。
- **必须遵守的语义**：`feed` 必须做触发者校验 `head.userId === replyUserId` 才消费（见 §6）；`confirm === 'always'` 时不接受任何会话记忆（每次都问）。

### 注册（ctx.provide + 双源同步）

```ts
// packages/<your-plugin>/src/index.ts
import type { Context } from '@aalis/core';
import type {
  AccessConfirmHandler,
  AccessDecision,
  AccessRequest,
} from '@aalis/plugin-authority-api';
import type { ConfirmChannel, SessionConfirmService } from '@aalis/plugin-session-confirm-api';

export const name = '@aalis/plugin-my-session-confirm';
export const provides = ['session-confirm'];           // ← 双源之一：导出 provides
export const inject = { required: ['gateway'], optional: ['authority'] };

function createChannel(deliver: (request: AccessRequest, text: string) => void): ConfirmChannel {
  const pending = new Map<string, {
    request: AccessRequest;
    resolve: (v: boolean | AccessDecision) => void;
    timer: ReturnType<typeof setTimeout>;
    userId?: string;
  }>();

  const handler: AccessConfirmHandler = request =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(request.sessionId);
        deliver(request, '⏰ 操作确认已超时，已自动取消。');
        resolve(false);                                  // 超时默认拒（无人在场即安全失败）
      }, 60_000);
      timer.unref?.();                                   // 待确认定时器不阻止进程优雅退出
      pending.set(request.sessionId, { request, resolve, timer, userId: request.userId });
      deliver(request, `⚠️ ${request.name} 是高危操作。回复 Y 允许；其他取消。`);
    });

  const feed = (sessionId: string, replyText: string, replyUserId?: string): boolean => {
    const w = pending.get(sessionId);
    if (!w) return false;
    if (w.userId !== replyUserId) return false;          // ← 仅触发者本人能应答（防第三方抢答）
    clearTimeout(w.timer);
    pending.delete(sessionId);
    const ok = replyText.trim().toLowerCase() === 'y';
    w.resolve(ok ? { allowed: true } : false);
    return true;                                         // 命中并消费 → 调用方吞掉该输入
  };

  const dispose = (): void => {
    for (const w of pending.values()) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    pending.clear();
  };

  return { handler, feed, dispose };
}

export async function apply(ctx: Context): Promise<void> {
  const service: SessionConfirmService = { createChannel };
  ctx.provide('session-confirm', service);
  // …（若也要自用 bus 通道覆盖会话型平台，参照默认实现 §3）
}
```

> 上例是**简化骨架**，省略了 FIFO 排队与 `parseConfirmReply` 的 Y/YS 语义；正式实现请直接对照 `packages/plugin-session-confirm/src/index.ts:57-133`。

`package.json` 的 `aalis.service` 必须与导出的 `provides`/`inject` 保持**双源一致**（manifest 双源约定见 docs/concepts/manifest-metadata.md）：

```jsonc
// package.json
{
  "aalis": {
    "service": {
      "required": ["gateway"],
      "optional": ["authority"],
      "provides": ["session-confirm"]
    }
  }
}
```

### 同名竞争 / 覆盖

DI 按名选胜者，顺序为 偏好 > 优先级（ServicePriority Backend 0 / Override 50 / System 200）> 注册顺序（见 docs/concepts/service-model.md、docs/core/service.md）。默认实现以 `ctx.provide('session-confirm', service)` 注册（未显式抬高优先级），第三方若要**覆盖**它，用更高优先级 provide 或让用户偏好选择即可。`createChannel` 无 `entryId`、非 per-entry，全局一个服务实例。

## 5. 标准消费姿势（接一个新平台的确认通道）

最常见的使用方式是**作为一个新平台**复用协调器，正如 webui-server 所做：

```ts
import type { AuthorityService } from '@aalis/plugin-authority-api';
import type { ConfirmChannel, SessionConfirmService } from '@aalis/plugin-session-confirm-api';

let confirmChannel: ConfirmChannel | undefined;

// session-confirm 可能晚于本插件上线 → 用 whenService 等它就绪
ctx.whenService<SessionConfirmService>('session-confirm', confirmSvc => {
  // 注入「本平台怎么把文案发给用户」
  confirmChannel = confirmSvc.createChannel((request, text) => {
    sendToMyPlatform(request.sessionId, text);
  });
  // 把 handler 挂到 authority，键用本平台名（authorize 时按 request.platform 取）
  // getService 每次现取，别缓存（provider 反弹会失效，见 lazy-service-access）
  ctx.getService<AuthorityService>('authority')?.setConfirmHandler('myplatform', confirmChannel.handler);
});

// 在本平台的入站拦截点喂回复；命中即吞掉，别让它当普通消息进 agent
function onInbound(sessionId: string, text: string, userId?: string): void {
  if (confirmChannel?.feed(sessionId, text, userId)) return;  // 吞掉确认回复
  // …正常处理
}

// 热重载/卸载时清理
ctx.onDispose(() => confirmChannel?.dispose());
```

要点：

- **lazy / whenService**：`session-confirm` 与 `authority` 都可能晚上线或热重载反弹，故用 `whenService` 注册时机、`getService` 每用现取——切勿把服务实例缓存进闭包（见 docs/concepts/lazy-service-access.md）。
- **服务缺失即降级**：`session-confirm` 缺席时 `whenService` 不回调，没人注册 handler；authority 的 `requestAccess` 取不到 handler 时**返回 `false`（拒绝）**（`packages/plugin-authority/src/authority-manager.ts:151-152`）——「无人在场即安全失败」。authority 缺席时 `setConfirmHandler` 那行的 `?.` 直接短路，不报错。
- **吞掉命中的回复**：`feed` 返回 `true` 时务必中止后续处理（默认 bus 通道把 `feed` 放在 `inbound:confirm` 相位最前，命中即不调 `next()`，避免回复触达 agent 触发对在途生成的 abort —— `packages/plugin-session-confirm/src/index.ts:158-162`、`packages/plugin-gateway-api/src/index.ts:106-107`）。
- **错误边界**：handler 抛异常时 authority 侧 catch 并按拒绝处理（`packages/plugin-authority/src/authority-manager.ts:157-160`），但你自己的 `deliver` 失败不应让 Promise 永挂——超时兜底是最后防线。

## 6. 能力 / 风险 → 影响

本服务直接卡在 authority 的 confirm 轴上，provider/consumer 必须遵守以下安全约束：

- **触发者绑定（防群里第三方抢答）**：`feed` 仅在 `head.userId === replyUserId` 时消费（`packages/plugin-session-confirm/src/index.ts:106-118`、契约注释 `packages/plugin-session-confirm-api/src/index.ts:21-25`）。群聊里 `sessionId` 是群，若不绑发起者 `userId`，任意群成员都能替授权方按下「Y」——等于帮别人静默提权。私聊/WebUI 触发者与应答者天然同人；两者皆 `undefined`（系统注入等无 userId 场景）也视为同人。**新平台的 `feed` 调用必须传入真实应答者 `userId`**（webui 传 `wsIdentity.userId`，bus 通道传 `data.message.userId`）。
- **`confirm: 'always'` 不接受会话记忆**：最高危能力每次都问，authority `requestAccess` 在 `always` 时跳过临时委托记忆（`packages/plugin-authority/src/authority-manager.ts:143-148,155`），协调器文案也相应改为「每次都需确认」（`packages/plugin-session-confirm/src/index.ts:42,52-54`）。provider 不得擅自为 `always` 引入「记住本会话」。
- **confirm 与 visibility 正交**：visibility 管「能不能」（授权），confirm 管「是不是你本人此刻要」（意图确认 / 防注入减速带）。即便 owner（`*`），命中 confirm 的能力仍须确认——抵御 owner 会话内提示注入借权静默调高危（`packages/plugin-authority-api/src/index.ts:29-30`）。本服务是这条「减速带」的落地，**不要**为图省事让 owner 跳过确认。
- **超时默认拒**：无人应答 60s 后 resolve `false`（安全失败），不要默认放行。
- **session 授予是临时委托**：确认返回 `{ allowed: true, grant: { scope: 'session', durationSeconds } }` 会让 authority 建立一条限时临时委托（YS 默认 600s，`packages/plugin-session-confirm/src/index.ts:36,43`；委托建立见 `packages/plugin-authority/src/authority-manager.ts:155,193+`）。这条委托按 `(capability, sessionId, userId)` 三元组匹配消费（`packages/plugin-authority/src/authority-manager.ts:182-191`），不跨会话、不跨用户泄漏。

## 7. 边界与坑

- **审计旧账已结清**：旧版审计曾标注「`feed` 仅按 `sessionId` 匹配、不绑 `userId`，群里第三方可抢答」。当前代码**已修复**——`feed` 签名加了 `replyUserId?`，且消费前强制 `head.userId !== replyUserId → return false`（`packages/plugin-session-confirm/src/index.ts:106-112,160`；webui 侧 `packages/plugin-webui-server/src/index.ts:1079`）。**第三方自写 provider 时必须照此实现这道校验**，否则会把这个洞重新引回来。
- **依赖的是 gateway，不是 authority**：本插件 `required: ['gateway']`（投递与 `inbound:confirm` 拦截）、`optional: ['authority']`。这意味着不加载 gateway 它根本起不来；而 authority 缺席时它仍 provide 服务、仅没人来调 handler。别误以为它「依赖权限系统」。
- **handler 注册是「后注册覆盖」语义**：`setConfirmHandler(platform, handler)` 往 `Map` 里 `set`，同 `platform` 后注册者覆盖前者（`packages/plugin-authority/src/authority-manager.ts:98-99`）。多个插件抢同一 `platform` 的 confirm 通道会互相覆盖——按平台分键（`'webui'` / `'*'` / 你的平台名），不要重复占用别人的键。`'*'` 是 fallback，精确平台优先（`packages/plugin-authority/src/authority-manager.ts:151`）。
- **per-session 单队列、无跨实例共享**：协调器状态全在 `createChannel` 闭包的 `Map` 里，进程内、不持久化。进程重启/热重载会丢掉所有未决确认（`dispose` 把它们安全拒掉）——这是有意的「无人在场即取消」，不是 bug。
- **`deliver` 必须可重入且不抛**：协调器在 `present`（发提示）和超时分支都会调 `deliver`，且超时分支在 `setTimeout` 回调里——`deliver` 抛异常无人接，请自行 try/catch（默认 bus 通道用 `void gateway?.dispatchOutbound(...)` 吞掉了 Promise 拒绝，`packages/plugin-session-confirm/src/index.ts:140-148`）。

## 8. 交叉链接

- docs/concepts/security-model.md —— 两轴鉴权（level + confirm）、risk → (visibility, confirm) 推导、owner 仍吃 confirm。
- docs/concepts/service-model.md、docs/core/service.md —— DI 按名选胜者、ServicePriority、provide/inject 双源。
- docs/concepts/lazy-service-access.md —— whenService 注册时机、getService 每用现取、provider 反弹失效。
- docs/concepts/manifest-metadata.md —— `package.json aalis.service` 与导出 `provides`/`inject` 双源一致。
- docs/concepts/message-llm-pipeline.md —— `inbound:confirm` 相位在入站管道里的位置（最前、命中即吞）。
- docs/core/authority.md —— authority 服务、临时能力委托、`requestAccess` / `setConfirmHandler`。
- docs/services/gateway.md —— bus 投递（`dispatchOutbound`）与 `INBOUND_PHASE` 相位常量来源。
