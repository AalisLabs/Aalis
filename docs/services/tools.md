# tools 服务

## 1. 定位

**工具注册表（Tool Registry）**：管理「AI 可调用工具」的注册、查询、执行与统一权限闸。LLM function-calling 的工具池就是这个服务里的一张 `Map<name, RegisteredTool>`。

- 服务注册名：`'tools'`，消费方 `ctx.getService<ToolService>('tools')`。
- 契约包：`@aalis/plugin-tools-api`（`packages/plugin-tools-api/src/index.ts`）。
- 参考实现：`@aalis/plugin-tools`（`packages/plugin-tools/src/tools.ts` 的 `ToolRegistry`）。

工具是「能力（capability）」在 LLM 侧的一种 surface（另一种是指令 command，见 [`docs/core/commands.md`](../core/commands.md)）。两者共用同一套 authority 执行守卫，详见 [`docs/concepts/security-model.md`](../concepts/security-model.md)、[`docs/core/authority.md`](../core/authority.md)。

> 既有 [`docs/core/tools.md`](../core/tools.md) 还把源码标成 `packages/core/src/tools.ts`，那是迁移前的旧路径；以本文与上述 file:line 为准。

## 2. 契约（`@aalis/plugin-tools-api`）

### 2.1 LLM 函数声明协议

`packages/plugin-tools-api/src/index.ts:28-43`：

```ts
export interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}
```

形状即 OpenAI function-calling 的 `tools[].function` wire format（`type` 恒为 `'function'`）。`parameters` 是 JSON Schema 子集；`strict`/`additionalProperties` 影响参数校验（见 §7）。

### 2.2 已注册工具与上下文

`RegisteredTool`（`index.ts:72-84`）—— 注册项的完整形状：

```ts
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  visibility?: CapabilityVisibility;  // 轴 A，缺省 public；restricted 须被 owner/委托授予
  confirm?: CapabilityConfirm;         // 轴 B，'session' | 'always'；缺省=不确认
  risk?: CapabilityRisk;               // 声明糖，展开为 (visibility, confirm) 默认
  groups?: string[];                   // 分组；未设置=始终可用
}
```

注意 `handler` **必须返回 `Promise<string>`**（不是对象）。约定俗成的返回是 JSON 字符串（`ToolRegistry` 自身的错误也以 `JSON.stringify({ error })` 返回，见 `packages/plugin-tools/src/tools.ts:161,168,202`），但契约只要求 string。

`ToolCallContext`（`index.ts:47-53`）—— handler 第二参，携平台/会话语义：

```ts
export interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  enabledGroups?: string[];  // 当前平台启用的分组，供 search_tools 等过滤
}
```

`risk`/`visibility`/`confirm` 三者关系（`@aalis/plugin-authority-api`，`packages/plugin-authority-api/src/index.ts:42-86`）：`risk` 是糖，`safe→{public}`、`sensitive→{restricted}`、`dangerous→{restricted, confirm:'session'}`；显式 `visibility`/`confirm` 覆盖 `risk` 推导；三者全缺省 → `public`。`resolveCapabilityPolicy()` 做这步展开（纯函数）。

### 2.3 服务接口 `ToolService`

`index.ts:111-147`，关键方法：

```ts
register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void;  // 返回 disposer
getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];   // 喂给 LLM 的工具列表
getSummaries(filter?: { groups?: string[] }): ToolSummary[];        // 不含 handler，供搜索展示
getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups? }>;  // 给 authority/WebUI
execute(toolName, args, callCtx: ToolCallContext): Promise<string>; // 过守卫 + 校验 + 调 handler
setExecutionGuard(guard: ExecutionGuard): void;                     // 由 plugin-authority 注入
registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
getGroups(): ToolGroupInfo[];
unregisterByPlugin(pluginName: string): void;
```

`getDefinitions`/`getSummaries` 的过滤语义（`tools.ts:61-89`）：**不传 `groups` 时只返回「无分组」的通用工具**；带分组的工具必须显式列在 `filter.groups` 里才出现。这是 plugin-agent 按平台启用分组的依据。

### 2.4 导出的便捷封装与类型

- `useToolService(ctx): ScopedToolService`（`index.ts:181-208`）—— 推荐入口，自动填 `pluginName=ctx.id`、`register`/`registerGroup` 走 `whenService` 延迟到服务就绪。
- `toolsWithGroups(tools, groups)`（`index.ts:216-225`）—— 给一组工具批量挂同一分组（合并而非覆盖）。
- 类型：`ToolFunction` `ToolDefinition` `ToolCallContext` `ToolExecuteMessage` `RegisteredTool` `ToolSummary` `ToolGroupInfo` `ToolService` `ScopedToolService`。
- 事件：通过 declaration merging 注入 `AalisEvents['tool:execute']: [ToolExecuteMessage]`（`index.ts:229-233`），WebUI 等前端订阅展示工具调用 start/end。
- 本包**纯契约**：不再 re-export 任何 runtime helper。SSRF/私网判定（`isPrivateAddress`/`isPrivateHost`）在 `@aalis/util-network-guard`；路径规范化/解析（`toStorageUri`/`resolveAgainstCwd`/`parseStorageUri`）在 `@aalis/plugin-storage-api`（`src/index.ts:301`）。`index.ts:235-237` 有迁出说明。

## 3. 谁提供 / 谁消费

**提供者（唯一）**：`@aalis/plugin-tools` —— `ctx.provide('tools', new ToolRegistry(ctx.logger))`（`packages/plugin-tools/src/index.ts:11-12`，`provides = ['tools']` 在 `:8`）。本服务是**单实例中心 Registry**，不是 router facade（没有「多 provider 枚举」概念，`tools.ts:28-31` 注释明确）。

**工具提供者（注册工具的插件，非服务 provider）**：大量插件通过 `useToolService(ctx).register(...)` 往里塞工具，例如：
- `plugin-tool-system`（shell/file/system/http 工具，`packages/plugin-tool-system/src/index.ts`）
- `plugin-tool-math`（纯净参考，`packages/plugin-tool-math/src/index.ts:114-182`）
- `plugin-tool-browser` `plugin-tool-search` `plugin-tool-onebot` `plugin-tool-code-runner` `plugin-skills` `plugin-todo-list` `plugin-memory-*` 等。

**核心消费者**：
- `plugin-agent` —— LLM 主循环：`getService<ToolService>('tools')?.getDefinitions(...)` 取工具喂模型（`packages/plugin-agent/src/index.ts:477-478, 1851`），收到 tool_call 后 `?.execute(name, args, toolCtx)`（`:630-631`）。
- `plugin-authority` —— 通过 `whenService('tools', svc => svc.setExecutionGuard(guard))` 注入权限守卫（`packages/plugin-authority/src/index.ts:113-118`）。
- `plugin-mcp-server` —— 把工具暴露成 MCP（`inject.required = ['tools']`，`packages/plugin-mcp-server/src/index.ts:38`）。
- WebUI 经 `getAll()` 列工具+可见性。

## 4. 写一个工具提供者

提供者通常**不**重新实现 `ToolService`（它是单例，几乎没人需要自建），而是消费 `tools` 服务往里注册工具。

### 4.1 最小骨架（推荐姿势）

```ts
import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tools-api'; // 触发 ServiceTypeMap / AalisEvents 的 declaration merging

export const name = '@aalis/plugin-tool-hello';

export function apply(ctx: Context): void {
  const tools = useToolService(ctx);

  // 可选：注册分组（带分组的工具需平台显式启用才进 LLM）
  tools.registerGroup({ name: 'hello', label: '示例工具' });

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'hello_echo',
        description: '原样回显一段文本。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要回显的文本' } },
          required: ['text'],
          additionalProperties: false, // 开启「未知参数」校验，见 §7
        },
      },
    },
    // 不声明 visibility/confirm/risk → public、不确认。涉敏感/写操作时必须显式声明，见 §6。
    handler: async (args) => {
      return JSON.stringify({ echo: String(args.text ?? '') });
    },
  });
}
```

最小必须：`definition.function.{name, description, parameters}` + `handler`。可选：`visibility`/`confirm`/`risk`/`groups`。`pluginName` 由 `useToolService` 自动填 `ctx.id`，**不要**自己传。

### 4.2 manifest 双源

`useToolService` 的 `register/registerGroup` 内部走 `ctx.whenService('tools', ...)`（`index.ts:196-197`），服务未就绪会延迟，因此**不显式声明 inject 也能注册**（`plugin-tool-math` 的 `package.json` 就是空 `aalis: {}`）。但若你**还要读** `getDefinitions/getAll/execute`（走 `need()`，服务缺失即抛错，`index.ts:185-193`），或希望加载顺序/诊断清晰，应在 `package.json` 声明并与 export 同步：

```jsonc
// package.json
{ "aalis": { "service": { "required": ["tools"] } } }   // 或 optional
```
```ts
// index.ts
export const inject = { required: ['tools'] };  // 双源必须一致，见 docs/concepts/manifest-metadata.md
```

参考 `plugin-mcp-server`（两处都写 `required: ['tools']`）。

### 4.3 真要自建 `ToolService` provider

仅当你要替换整个注册表实现时才需要。实现 §2.3 全部方法，用 `ctx.provide('tools', impl, { priority })` 注册；同名竞争走 `preference > priority > 注册序`（ServicePriority Backend0/Override50/System200），见 [`docs/concepts/service-model.md`](../concepts/service-model.md)。**务必实现 `setExecutionGuard`**，否则 authority 无法挂权限闸（守卫缺失=放行，见 §6/§7）。

## 5. 标准消费姿势

每次用都 `getService`，**不要缓存服务引用**——provider 重启/反弹会让旧引用失效（见 [`docs/concepts/lazy-service-access.md`](../concepts/lazy-service-access.md)）。

```ts
// 读：可选依赖，缺失就跳过（plugin-agent 的真实写法）
const defs = ctx.getService<ToolService>('tools')
  ?.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) ?? [];

// 执行：execute 永不 throw —— 失败/被拦截都以 JSON 字符串 { error } 返回（tools.ts:154-204）
const result = await ctx.getService<ToolService>('tools')
  ?.execute(call.name, call.args, { sessionId, userId, platform, enabledGroups })
  ?? JSON.stringify({ error: 'tools 服务不可用' });
```

错误边界：`execute` 把工具未命中、参数校验失败、守卫拦截、handler 抛错统统转成 `{ error }` 字符串回灌给 LLM（让模型本轮自我纠正），**不会**冒泡异常。消费方只需把这个字符串作为 tool 结果消息回写。

## 6. 能力 / 风险 → 影响

工具是受 authority 管的「能力」，`tool:<name>` 即其 capability id。两条正交轴（`packages/plugin-authority-api/src/index.ts:21-54`）：
- **轴 A 可见性** `visibility: 'public' | 'restricted'`。`restricted` 须 owner 或被委托授予才可执行；`public` 默认放行。
- **轴 B 确认** `confirm: 'session' | 'always'`。即便有权限（含 owner），命中 confirm 会触发交互确认（HITL）；`always` 不接受会话记忆，每次都问。
- `risk` 是糖：`safe→公开`、`sensitive→受限`、`dangerous→受限+每次确认`。`getAll()` **原样透传 `risk`**（`tools.ts:108`）让 authority 派生操作最低等级 minLevel（`riskToLevel`：safe→0 / sensitive→1 / dangerous→2，`packages/plugin-authority/src/authority-model.ts:23-27`）。

**提供者必须遵守**：
- 任何**写/删/越权读/外发**类工具都要声明 `risk` 或显式 `visibility/confirm`。例：`http_download` 是写操作，声明 `visibility:'restricted' + confirm:'session'`（`packages/plugin-tool-system/src/tools/http.ts:180-183`），防被注入的 LLM 静默写穿 storage。**不声明 = public 不确认**，等于把能力裸露给任何会话。
- **外发网络**走 SSRF 守卫：用 `safeFetch`（`@aalis/util-network-guard`），别裸 `fetch`。见 [`docs/concepts/security-model.md`](../concepts/security-model.md)。
- **碰文件系统**只走 storage `<root>:/path` 语法，storage 不是沙箱（仅做根权限位 + 路径规范），见 [`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md)。能读到什么取决于工具自己限定的可读根，而非 storage 本身。

**执行守卫链路**：`execute` 先展开 `(visibility, confirm)`，若已注入 `_guard` 则调它（`tools.ts:171-188`）；守卫返回非空字符串=拦截（转 `{ error }`）。守卫由 `plugin-authority` 注入，内部按 `resolveMinLevel`（risk 派生 minLevel，无 risk 时 visibility 兜底 restricted→2 / public→0，`authority-model.ts:48-60`）裁决调用者等级是否达标、对 `confirm` 走 `requestAccess`（`packages/plugin-authority/src/index.ts:90-104`）。`skipConfirm`（如 scheduler）只跳交互确认、**不**绕过 authorize（防提权）。owner 视为等级 ∞。

## 7. 边界与坑

- **守卫缺失 = fail-open（放行）**：`execute` 是 `if (this._guard) { ... }`（`tools.ts:172`）。若 `plugin-authority` 未加载/未注入守卫，所有 `restricted`/`confirm` 工具**直接执行不拦截**。这是「权限是叠加层，不是工具自带护栏」的体现——提供者不能假设守卫一定在，敏感工具应在 handler 内对真正危险的副作用再做一层自检。
- **`http_download` 历史问题**：审计曾指出它是 public 无确认；现已修为 `restricted + confirm:'session'`（http.ts:180-183）。新写下载/上传类工具照此挂闸。
- **`file_read` 的 `allowedRoots`**：现默认 `['workspace', 'tmp']`（`packages/plugin-tool-system/src/index.ts:51,91`），不含 `data` 等系统根，避免裸读 `data:/users.json`。但配置允许设为 `["*"]` 放开全部可读根（`src/tools/file.ts:38-43,83`）——一旦用户改成 `*`，`file_read` 就能读凭证类文件。提供「按根放行」的工具时，默认应收紧、把放开权交给 owner 显式配置。
- **重名即覆盖**：`name` 全局唯一，重复 `register` 同名工具会 warn 并覆盖（`tools.ts:46-48`）。挑独特、带前缀的工具名（如 `math_eval`），别用 `read`/`run` 这种通用词。
- **参数校验是「轻量」级**：`execute` 只查 `required` 缺失 + （仅当 `additionalProperties:false` 时）未知键（`tools.ts:228-260`），**不**做类型/嵌套校验。想要严格未知键拦截就显式写 `additionalProperties: false`；handler 内仍要对 `args` 做类型断言与防御。
- **契约污染（已解决）**：曾经 `packages/plugin-tools-api/src/utils.ts` 把 `toStorageUri` + 一组 SSRF/私网判定塞进 tools 契约包并 re-export，属契约污染。现已修复：`utils.ts` 删除、helper 迁出——SSRF/私网判定 → `@aalis/util-network-guard`（`isPrivateAddress`/`isPrivateHost`、`safeFetch`），路径规范化/解析 → `@aalis/plugin-storage-api`（`toStorageUri`/`resolveAgainstCwd`/`parseStorageUri`，`src/index.ts:301`）。本包现为纯契约/类型，不再 re-export 任何 runtime 函数（迁出说明见 `index.ts:235-237`）。

## 8. 交叉链接

- 概念：[`service-model`](../concepts/service-model.md) · [`lazy-service-access`](../concepts/lazy-service-access.md) · [`manifest-metadata`](../concepts/manifest-metadata.md) · [`security-model`](../concepts/security-model.md) · [`storage-uri-grammar`](../concepts/storage-uri-grammar.md) · [`message-llm-pipeline`](../concepts/message-llm-pipeline.md)
- 核心：[`core/tools`](../core/tools.md) · [`core/authority`](../core/authority.md) · [`core/commands`](../core/commands.md) · [`core/service`](../core/service.md) · [`core/context`](../core/context.md)
