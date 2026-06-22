# 会话级工具状态服务（tool-session）

> 受众：编写或消费「按会话隔离的工具状态」的第三方插件作者。
> 先读 [服务模型](../concepts/service-model.md) 与 [惰性服务访问](../concepts/lazy-service-access.md)；本文是它们在「会话历史读取 / 上传文件登记」两个具体服务上的落点。

## 0. 命名澄清（务必先看）

本文件名 `tool-session` 是 **文档分组名**，不是任何一个 `getService()` 的注册名。Aalis 里**没有**名为 `'tool-session'` 的服务。这一类「按会话隔离的工具状态」实际由两个独立服务承担，作者按需取用：

| 关注点 | 服务注册名 | 契约包 / 实现 | 性质 |
| --- | --- | --- | --- |
| 跨会话历史读取 + 平台访问规则 | `session-history` | 契约 `@aalis/plugin-tool-session-api`；实现 `@aalis/plugin-tool-session` | 有 `-api` 契约 + 运行时服务 |
| 上传文件登记（per-session 文件态） | `file-reader` | 实现 `@aalis/plugin-file-reader`（**无 `-api` 包**，接口内联在 provide 处） | 仅运行时服务，无独立契约 |

下面分两节讲。两者都遵循「`sessionId` 是会话隔离边界」这一共同约束，见 [§6 会话隔离](#6-会话隔离--访问控制provider--consumer-必守)。

---

# Part A — `session-history` 服务

## A.1 定位

一句话：**按 Aalis `sessionId` 读取某会话的消息历史，并提供平台插件注入「跨会话读取访问规则」的钩子。** 取用名 `getService<SessionHistoryService>('session-history')`，契约包 `@aalis/plugin-tool-session-api`。

它不是存储后端——历史数据来自 `memory` 服务；本服务是「读取入口 + 访问控制链 + 给 LLM 的工具壳（`session_get_history`）」。设计上保证**通用工具与平台专属工具都走同一条 access-checker 链，不存在绕过路径**（`packages/plugin-tool-session-api/src/index.ts:6-8`）。

## A.2 契约（`@aalis/plugin-tool-session-api/src/index.ts`）

核心接口（`index.ts:73-91`）：

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

返回类型 `SessionHistoryReadResult`（`index.ts:54-67`）是判别联合：成功为 `{ ok: true; sessionId; count; limit; includeArchived; range?; truncated?; messages }`，失败为 `{ error: string }`——**没有 `ok: false` 形态，错误分支只有 `error` 字段**，消费方用 `'error' in result` 判别。

访问规则三件套：
- `AccessChecker`（`index.ts:33-44`）：`{ platform: string; check(args): AccessDecision | undefined }`。`check` 是**同步**的；只对 `targetSessionId.startsWith(platform + ':')` 的目标生效。
- `AccessCheckArgs`（`index.ts:24-31`）：`{ currentSessionId; targetSessionId; callCtx }`。
- `AccessDecision`（`index.ts:22`）：`{ decision: 'allow' | 'deny'; reason? }`；返回 `undefined` 表示「不表态，交给后续 checker / 默认放行」。
- `AccessCheckerDisposer`（`index.ts:49`）：`() => void`，插件 dispose 时调用解绑。

判定语义：**any-deny 短路** —— 同一 platform 多个 checker，任一返回 `deny` 即拒绝（`index.ts:12`，实现见 `plugin-tool-session/src/index.ts:344-349`）。

契约里还通过 declaration merging 把名字登记进 `ServiceTypeMap`（`index.ts:93-97`），所以 `ctx.getService('session-history')` 无需手写泛型即有类型。消费方源码顶部要 `import '@aalis/plugin-tool-session-api'` 触发该 merge。

## A.3 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-tool-session`（`packages/plugin-tool-session/src/index.ts:915-916`）

```ts
const historyService = createSessionHistoryService(ctx, cfg);
ctx.provide('session-history', historyService, { label: '会话历史读取' });
```

它还顺带注册了 LLM 工具 `session_get_history`（`index.ts:460-524`，handler 转调 `historyService.getHistory`）以及跨会话委派工具组 `session-delegate`（`delegate_to_session` / `list_known_sessions`，`index.ts:529-907`，这部分不经本服务接口，是直接的工具实现）。

**消费点**：
- `@aalis/plugin-tool-onebot`：注入访问规则（`packages/plugin-tool-onebot/src/index.ts:1715-1761`）+ 平台专属工具 `onebot_get_session_history` 转调本服务（`index.ts:1860-1874`）。这是**最权威的「写 provider 之外的消费」范例**。
- `@aalis/plugin-memory-history`：把它的跨会话查询工具挂进 `'session-history'` 工具分组（`packages/plugin-memory-history/src/index.ts:297-299`），属于 UI 分组复用，不调用服务接口本身。

注意：`session-history` 这个名字**在工具分组层面被多个插件共享贡献**（`plugin-webui-server/src/index.ts:679` 有相关注释），但**服务实例**目前只有 `plugin-tool-session` 一个 provider。

## A.4 写一个 provider

通常你不需要重写 `session-history`——更常见的是**给已有 provider 注入平台访问规则**（见 A.5）。若确要替换实现（例如对接非 memory 的历史后端），最小骨架：

```ts
import type { Context } from '@aalis/core';
import type { SessionHistoryService } from '@aalis/plugin-tool-session-api';
import '@aalis/plugin-tool-session-api'; // 触发 ServiceTypeMap declaration merge

export const name = '@you/plugin-my-history';
export const provides = ['session-history'];

export function apply(ctx: Context): void {
  const checkers: import('@aalis/plugin-tool-session-api').AccessChecker[] = [];
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
      // 1. 必须自己跑 access-checker 链（any-deny 短路）——这是契约承诺的「无绕过」
      const platform = target.split(':')[0] ?? '';
      for (const c of checkers.filter(c => c.platform === platform)) {
        const v = c.check({ currentSessionId: callCtx.sessionId, targetSessionId: target, callCtx });
        if (v?.decision === 'deny') return { error: v.reason ?? '访问被拒绝' };
      }
      // 2. 读取你的后端，整形成 messages: Array<Record<string, unknown>>
      return { ok: true, sessionId: target, count: 0, limit: options.limit ?? 20, includeArchived: false, messages: [] };
    },
  };
  ctx.provide('session-history', svc, { label: '我的历史读取' });
}
```

要点：
- **必须** `provides` / `inject` 双源与 `package.json` 的 `aalis.service.provides` 同步（[清单元数据](../concepts/manifest-metadata.md)）。
- `getHistory` **必须自己执行 access-checker 链**——否则注入规则的平台插件被静默架空，破坏「无绕过」契约。
- 失败返回 `{ error }`，**不要** throw 到工具壳外。

## A.5 标准消费姿势

**注入平台访问规则**（OneBot 的范式，`plugin-tool-onebot/src/index.ts:1716-1760`）：

```ts
ctx.on('ready', () => {
  const history = ctx.getService<SessionHistoryService>('session-history');
  if (!history?.registerAccessChecker) {
    ctx.logger.debug('session-history 不可用，跳过规则注册');
    return; // 可选依赖：缺失就跳过，别报错
  }
  const dispose = history.registerAccessChecker({
    platform: 'onebot',
    check({ currentSessionId, targetSessionId }) {
      // 只对 onebot:* 目标表态；其它返回 undefined
      // deny → 立即拒；allow/undefined → 交给后续 checker / 默认放行
      return /* ...你的细粒度规则... */ undefined;
    },
  });
  ctx.onDispose(dispose); // ← 见 A.7 坑①
});
```

**直接读取历史**（平台专属工具的范式，`plugin-tool-onebot/src/index.ts:1860-1874`）：每次现取，不要缓存实例（provider bounce 会失效，见 [惰性服务访问](../concepts/lazy-service-access.md)）：

```ts
const history = ctx.getService<SessionHistoryService>('session-history');
if (!history) return JSON.stringify({ error: 'session-history 服务不可用，请启用 @aalis/plugin-tool-session' });
const result = await history.getHistory({ sessionId, limit }, callCtx);
```

`inject` 里把它列为 `optional`（`plugin-tool-onebot/src/index.ts:17`：`optional: ['platform', 'session-history']`）——它不是硬依赖，缺失时优雅降级。

## A.6 能力 / 风险

- **访问控制是跨会话读取的唯一闸门**，分两段（实现 `plugin-tool-session/src/index.ts:316-351`）：①service 自带的 `scope` 配置粗筛（`current` / `platform` / `all`，默认 `platform`，`index.ts:144-153`）；②匹配 `targetPlatform` 的 checker 链 any-deny 精筛。`scope=all` 时只剩 checker 链兜底——**平台插件若没注册 checker，`all` 模式下等于裸奔**。
- 这与 [鉴权系统](../core/authority.md) 的 level/risk 是两套机制：`session_get_history` 工具本身的 minLevel 由工具的 risk 决定（见 [工具](../core/tools.md)），而**跨会话边界**则由本服务的 scope+checker 决定。二者叠加，缺一不可。
- 本服务**不做** SSRF / 沙箱：它只读已落库的会话消息，无外部 egress。

## A.7 边界与坑

- **坑①（已在 OneBot 修复，新接入者照抄）**：总线上**不存在 `'dispose'` 事件**。早期写法 `ctx.on('dispose', disposeChecker)` 永远不触发，导致插件 bounce 后 access-checker 泄漏。正确写法是 `ctx.onDispose(dispose)`（`plugin-tool-onebot/src/index.ts:1757-1759` 有明确注释）。
- **时间区间模式**：给 `sinceTs`/`untilTs` 任一即进入区间检索；此模式恒含归档记录，结果 `includeArchived` 字段会回显实际生效值（`plugin-tool-session/src/index.ts:386-440`）。后端无原生区间查询（`memory.getMessagesBySessionRange` 缺失）时退回扫描 `RANGE_FALLBACK_SCAN=5000` 条客户端过滤，极早窗口可能不全；窗口内超 `limit` 时置 `truncated: true` 而非静默丢弃。
- `getHistory` 强依赖 `memory` 服务：缺失直接返回 `{ error: 'memory 服务不可用' }`（`index.ts:366-367`）。所以参考实现把 `memory` 列为 `optional`（运行期检测）而非 `required`。

---

# Part B — `file-reader` 服务（per-session 上传文件登记）

## B.1 定位

一句话：**登记并按会话隔离地访问「用户上传的文件」的元信息与本地路径。** 取用名 `getService('file-reader')`，实现包 `@aalis/plugin-file-reader`。

**没有 `@aalis/plugin-file-reader-api`**——服务接口是内联在 `ctx.provide` 处的匿名对象（`packages/plugin-file-reader/src/index.ts:875-898`），消费方按 duck-typing 取用。这是它与 `session-history` 的关键差异：没有可 import 的 `interface`，作者只能照下面的形状自己声明泛型。

## B.2 「契约」（内联 provide 形状）

provide 处（`plugin-file-reader/src/index.ts:875-898`）暴露的对象等价于：

```ts
interface FileReaderService {
  available: true;
  listFiles(sessionId?: string): FileMeta[];          // 省略 sessionId 列全部（webui 用）
  resolveLocalPath(fileId: string): Promise<string | null>; // 下载端取本地路径
  getMeta(fileId: string): FileMeta | null;
  deleteFile(fileId: string): Promise<boolean>;
}
```

`FileMeta`（`plugin-file-reader/src/index.ts:155-164`，注意 provide 出去的版本剥掉了 `dataUri`/`metaUri`）：

```ts
interface FileMeta {
  id: string;        // sha256(content) 前 16 hex —— 内容寻址，可预测
  name: string;
  mimeType: string;
  size: number;
  sessionId: string; // ← 会话隔离边界
  uploadedAt: number;
  textCache?: string;
}
```

存储布局：所有文件落在 `pluginData:/file-reader/<sessionId>/<id><ext>`（`index.ts:152, 216-220`），元信息走同名 `.meta.json` sidecar。这是 [storage URI 文法](../concepts/storage-uri-grammar.md) 的 `pluginData:` 根；**storage 不是沙箱**——隔离靠的是路径里的 `sessionId` 段 + 服务层校验，不是文件系统强隔离。

LLM 侧工具（不在服务接口里，是插件内注册的）：`read_uploaded_file` / `list_uploaded_files` / `delete_uploaded_file`（`index.ts:175-177`）。

## B.3 谁提供 / 谁消费

**提供**：`@aalis/plugin-file-reader`（`index.ts:21` `provides = ['file-reader']`；`package.json` `aalis.service.provides: ['file-reader']`，required `storage`，optional `agent`/`memory`/`media`）。

**消费**：`@aalis/plugin-webui-server`
- 能力探测：`ctx.hasService('file-reader')` 决定前端是否显示文件上传按钮（`packages/plugin-webui-server/src/index.ts:481, 497-498`）。
- 删除同步：删文件后通知服务清内存索引（`packages/plugin-webui-server/src/routes/uploaded-files.ts:170-176`）——注意这里**故意只用 duck-typed 子集** `{ deleteFile?: ... }` 取用，避免 webui-server 反向依赖 file-reader 插件包（`uploaded-files.ts:8-9` 有注释，连 `FileMeta` 都是各自定义而非 import）。

## B.4 标准消费姿势

因为无 `-api`，消费方自带最小形状声明，且每次现取：

```ts
const reader = ctx.getService<{ deleteFile?: (id: string) => Promise<boolean> }>('file-reader');
if (reader?.deleteFile) await reader.deleteFile(fileId);
```

或先 `ctx.hasService('file-reader')` 做能力位探测。**不要缓存实例**（[惰性服务访问](../concepts/lazy-service-access.md)）。

## B.5 会话隔离 —— LLM 工具层（重点：审计 caveat 已修复）

> **审计历史 caveat 与当前状态**：曾有审计指出 `read_uploaded_file` / `delete_uploaded_file` 不校验 `entry.sessionId === callCtx.sessionId`，导致 `fileId`（内容寻址、可预测）可被跨会话读取/删除。**该问题在当前代码已修复**，新接入者应以现状为准：

- `read_uploaded_file`：`if (!entry || entry.sessionId !== callCtx.sessionId)` → 走 memory 兜底或当作不存在，**不泄漏他人会话文件的存在性与内容**（`plugin-file-reader/src/index.ts:591-604`）。
- `delete_uploaded_file`：`if (!entry || entry.sessionId !== callCtx.sessionId) return '文件不存在或已被删除'`（`index.ts:670-671`），且标了 `visibility: 'restricted'`（`index.ts:675`）。
- `list_uploaded_files`：移除了 `'*'` 跨会话枚举，只列 `f.sessionId === callCtx.sessionId`（`index.ts:632-634`）。

**给 provider 作者的强约束**：`fileId` 是 `sha256(content)` 前 16 hex（`index.ts:417` `hashId`），**内容相同则 id 相同、完全可预测**。任何按 `fileId` 取数据的工具/接口路径**必须**校验 `entry.sessionId === callCtx.sessionId`，否则知道（或猜到）文件内容的攻击者可越权访问。这是会话隔离的硬要求，见 [安全模型](../concepts/security-model.md)。

注意：**服务接口本身**（`getMeta`/`resolveLocalPath`/`deleteFile`）**不带 `sessionId` 校验**——它们设计给同进程内可信消费方（webui-server）用，调用方自己负责鉴权。隔离闸门在 LLM 工具层，不在服务层。

## B.6 会话生命周期

文件态随会话清理：监听 `session:deleted` 事件 → `deleteSessionFiles(sessionId)` 删该会话全部文件（`index.ts:464-470, 544-547`）。另有 retention（按天）+ LRU（按总量 MB）后台清理（`index.ts:474-501`，每小时跑一次）。provider 替换实现时要保留这层生命周期联动，否则文件会泄漏堆积。

---

## 6. 会话隔离 / 访问控制（provider + consumer 必守）

两服务共同的不变量：**`sessionId` 是会话隔离边界**。
- `session-history`：跨 `sessionId` 读取必须过 scope 粗筛 + platform checker 链；provider 重写时**必须**自己跑 checker 链。
- `file-reader`：凡按 `fileId`（可预测）取数据的 LLM 工具路径**必须**校验 `entry.sessionId === callCtx.sessionId`。
- 两者都从 `callCtx.sessionId`（`ToolCallContext`）拿「当前会话」，从不信任入参里的会话身份。

## 7. 交叉链接

- 概念：[服务模型](../concepts/service-model.md)、[惰性服务访问](../concepts/lazy-service-access.md)、[清单元数据](../concepts/manifest-metadata.md)、[storage URI 文法](../concepts/storage-uri-grammar.md)、[安全模型](../concepts/security-model.md)、[消息→LLM 管线](../concepts/message-llm-pipeline.md)
- 核心：[服务](../core/service.md)、[鉴权](../core/authority.md)、[工具](../core/tools.md)、[上下文](../core/context.md)
