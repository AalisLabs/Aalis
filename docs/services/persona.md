# persona 服务

## 1. 一句话定位

把「角色卡」（YAML 定义的人设：名字 / 描述 / 性格 / prompt / 结构化输出格式 / skill 白名单）渲染成 system prompt，并在回复链路里解析结构化输出（JSON）回填回复字段与角色状态的提供者。

- 服务注册名：`'persona'`（`ctx.getService<PersonaService>('persona')`）。
- 契约包：`@aalis/plugin-persona-api`。
- 该契约**有运行时服务**（非纯类型契约）；`-api` 包只导出 interface + 类型 + declaration merging，不含实现。参考实现是 `@aalis/plugin-persona`（`packages/plugin-persona/src/index.ts`）。
- 角色卡按名分文件存放在 `personasDir`（一个 storage 路径，见 §6），启动时全量预扫进缓存，支持 `watch` 热重载。

## 2. 契约

`@aalis/plugin-persona-api` 的全部导出（`packages/plugin-persona-api/src/index.ts`）。

### 2.1 服务接口

```ts
// packages/plugin-persona-api/src/index.ts:43-66
export interface PersonaService {
  getSystemPrompt(options?: PersonaSessionOptions): string;
  getPersonaName(): string;
  getOutputFormat?(options?: PersonaSessionOptions): OutputFormat | undefined;
  isClientSideJsonRendering?(options?: PersonaSessionOptions): boolean;
  listModels?(): Promise<string[]>;
  getNickNames?(): string[];
  isTimeInjectionEnabled?(): boolean;
  getPersonaSkills?(options?: PersonaSessionOptions): string[] | undefined;
  getSessionState?(sessionId: string): Record<string, unknown> | undefined;
}
```

**唯一两个必须实现的方法**是 `getSystemPrompt()` 与 `getPersonaName()`（接口里非可选）；其余全部带 `?`，消费者均做了存在性判断（见 §3、§5）。各方法语义：

- `getSystemPrompt(options?)` — 渲染当前生效角色卡的 system prompt 文本。参考实现还会拼入时间注入、会话环境（平台 / 群号 / 自身与发送者身份）、上一轮状态、以及 outputFormat 的 JSON 指令块（`packages/plugin-persona/src/index.ts:266-410`）。
- `getPersonaName()` — 角色卡的 `name`（用于 CLI 标题、触发昵称、user-profile 分堆 key）。
- `getOutputFormat(options?)` — 返回角色卡声明的结构化输出格式，无定义时返回 `undefined`；`options.disableOutputFormat` 为真时也返回 `undefined`（`packages/plugin-persona/src/index.ts:425-429`）。
- `isClientSideJsonRendering(options?)` — 该卡是否「JSON 由客户端渲染」（服务端不提取回复字段，整段 JSON 透传给前端）。
- `listModels()` — 列出已扫描到的全部角色卡名（用于 WebUI / session-manager 下拉框）。
- `getNickNames()` — 角色卡的 `nick_name` 列表，供触发检测匹配。
- `isTimeInjectionEnabled()` — 是否已由 persona 注入当前时间（其它插件据此决定是否还要注册 `system_time` 工具）。
- `getPersonaSkills(options?)` — 角色卡的 skill 白名单。**约定：返回 `undefined` 表示未声明白名单（全开）；返回 `[]` 表示禁用所有 skill**（`packages/plugin-persona-api/src/index.ts:56-60`）。
- `getSessionState(sessionId)` — 读取目标会话最近一次保存的结构化状态（如 mood / state），供 `delegate_to_session` 等跨会话工具回报目标 agent「内心情况」。

### 2.2 重要类型

```ts
// packages/plugin-persona-api/src/index.ts:8-15
export interface OutputFormatField {
  description: string;                       // 写入 system prompt 供 LLM 理解
  type?: 'string' | 'number' | 'boolean';   // 影响占位符渲染 + 输出后类型强制
  reply?: boolean;                           // 是否为发给用户的回复字段（有且仅有一个）
}

// packages/plugin-persona-api/src/index.ts:18-28
export interface OutputFormat {
  fields: Record<string, OutputFormatField>; // key = JSON 字段名
  replyField: string;                        // 自动推断，取 reply:true 的那个 key
  retries: number;                           // 校验失败时额外重试次数，缺省 1，0=不重试
}

// packages/plugin-persona-api/src/index.ts:34-41
export interface PersonaSessionOptions {
  persona?: string;             // 覆盖角色卡名称
  disableOutputFormat?: boolean;// 禁用结构化输出格式
  clientSideJsonRendering?: boolean;
}
```

**`PersonaSessionOptions` 的来源约定很关键**：persona 服务**自身不依赖 session-manager**，它只「根据传入的选项调整行为」。会话级覆盖由调用方（agent / persona 自己的 reply 钩子）从 `session-manager.resolveConfig()` 取出后构造再传入（`packages/plugin-persona-api/src/index.ts:30-33`、`packages/plugin-persona/src/index.ts:650-662`、`packages/plugin-agent/src/index.ts:457-466`）。

通过 declaration merging 把服务名登记进核心 `ServiceTypeMap`，使 `getService('persona')` 拿到强类型：

```ts
// packages/plugin-persona-api/src/index.ts:69-73
declare module '@aalis/core' {
  interface ServiceTypeMap {
    persona: PersonaService;
  }
}
```

## 3. 谁提供 / 谁消费

**提供者**：`@aalis/plugin-persona`（`packages/plugin-persona/src/index.ts`）。`PersonaServiceImpl` 实现接口，`apply()` 里 `ctx.provide('persona', service)`（`packages/plugin-persona/src/index.ts:547`）。这是当前唯一参考实现。

**典型消费点**（全部走可选依赖 + 存在性判断）：

- `@aalis/plugin-agent`（**核心消费者**）— `buildSystemPrompt()` 取 persona 拼进 system 块：`const persona = this.ctx.getService<PersonaService>('persona')`，`persona.getSystemPrompt(personaOpts)`（`packages/plugin-agent/src/index.ts:1106-1110`）；`inject.optional` 含 `'persona'`（`packages/plugin-agent/src/index.ts:1638`）。注意 JSON 解析/状态持久化**不在 agent 里做**，而是 persona 自己挂 `agent:reply:before` 钩子统一处理（`packages/plugin-agent/src/index.ts:762`，见 §4）。
- `@aalis/plugin-skills` — `getAllowedSkills()` 用 `persona?.getPersonaSkills?.()` 过滤暴露给 LLM 的 skill 列表（`packages/plugin-skills/src/index.ts:497-501`）。
- `@aalis/plugin-trigger-policy` — `detector.ts` 用 `getPersonaName()` + `getNickNames()` 收集 bot 昵称做唤起匹配（`packages/plugin-trigger-policy/src/detector.ts:17-21`）。
- `@aalis/plugin-tool-system` — `getService<{ isTimeInjectionEnabled?(): boolean }>('persona')`，已注入时间则跳过注册 `system_time` 工具（`packages/plugin-tool-system/src/index.ts:158-162`）。
- `@aalis/plugin-tool-session` — `delegate_to_session` 用 `getSessionState?.(targetSessionId)` 把目标会话的结构化状态附在委托结果里（`packages/plugin-tool-session/src/index.ts:870-877`）。
- `@aalis/plugin-session-manager` — `listModels()` 拉所有卡名给 WebUI 下拉；`configSchema` 里 `persona` 字段用 `dynamicOptions: 'persona'`（`packages/plugin-session-manager/src/index.ts:249-250, 46-49`）。
- `@aalis/plugin-webui-server` — `getPersonaName()` 作展示名，`hasService('persona')` 上报能力，`listModels()` 走通用 `/models` 枚举（`packages/plugin-webui-server/src/index.ts:477-491`）。
- `@aalis/plugin-cli` — 多处 `getService<PersonaService>('persona')?.getPersonaName() ?? 'Aalis'` 做命令行标题（`packages/plugin-cli/src/index.ts:243-244, 327, 672, 772`）。
- `@aalis/plugin-user-profile` — 用 `getPersonaName()` 按 persona 名给自档案 / 指令分堆（`packages/plugin-user-profile/src/index.ts:565-566`）。

**消费模式注意**：多数消费者**结构化窄化**了类型（只声明自己用到的那部分，如 tool-system 只声明 `{ isTimeInjectionEnabled?(): boolean }`），避免 import 全量类型造成包循环（`ctx.getService<T>(name)` 的 T 按设计由消费侧窄化）。

## 4. 写一个 provider

### 4.1 最小必须 vs 可选

- **必须实现**：`getSystemPrompt()`、`getPersonaName()`。只实现这两个，agent / cli / trigger 就能跑（trigger 只是少几个昵称，tool-system 不会跳过 `system_time`）。
- **可选**：其余全部带 `?` 的方法。但如果你想支持 **outputFormat 结构化输出**，光实现 `getOutputFormat()` 是不够的 —— 真正的 JSON 解析 / 回填 / 状态持久化 / 重试发生在参考实现自己注册的 `agent:reply:before` 中间件里（`packages/plugin-persona/src/index.ts:647-855`），不是 agent 替你做的。你的 provider 要复刻这套行为得自己挂同名钩子。
- 若不打算做结构化输出，可整块省略 `getOutputFormat` / `isClientSideJsonRendering` 与 reply 钩子，agent 会把 LLM 原文当回复直接发出。

### 4.2 注册（priority / entryId / label）+ 双源同步

`provide` 第三/四参可携带优先级与标签；persona 是单例服务，参考实现用最简形式 `ctx.provide('persona', service)`（默认 `ServicePriority.Backend=0`）。同名竞争胜者 = 偏好(preference) > priority > 注册顺序（见 `docs/concepts/service-model.md`）。若你想覆盖默认 persona，用更高优先级或让用户经 ServicePreference 选中：

```ts
import { ServicePriority } from '@aalis/core';
ctx.provide('persona', myService, ServicePriority.Override /* 50 */, 'persona', '我的人设引擎');
//                                ^priority                 ^entryId  ^label
```

**manifest 双源必须同步**：除 `export const provides = ['persona']`（运行时），还要在 `package.json` 写 `aalis.service.provides`（静态清单，供加载器 / 市场扫描）。参考 `packages/plugin-persona/package.json:38-47`：

```json
"aalis": { "service": { "provides": ["persona"], "optional": ["platform"] } }
```

两源不一致会被一致性检查拦下，详见 `docs/concepts/manifest-metadata.md`。

### 4.3 最小可编译骨架

```ts
// src/index.ts
import type { Context } from '@aalis/core';
import type { PersonaService, OutputFormat, PersonaSessionOptions } from '@aalis/plugin-persona-api';

export const name = '@aalis/plugin-my-persona';
export const provides = ['persona'];          // 运行时源
export const inject = { optional: ['platform'] };

class MyPersona implements PersonaService {
  constructor(private prompt: string, private nameStr: string) {}
  getSystemPrompt(_options?: PersonaSessionOptions): string {
    return this.prompt;                        // 这里可拼时间 / 会话环境 / outputFormat 指令
  }
  getPersonaName(): string {
    return this.nameStr;
  }
  // 想做结构化输出再实现，并自行挂 agent:reply:before 解析 —— 见 §4.1
  getOutputFormat(_options?: PersonaSessionOptions): OutputFormat | undefined {
    return undefined;
  }
}

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const svc = new MyPersona((config.prompt as string) ?? '请友好地交流。', (config.name as string) ?? 'Aalis');
  ctx.provide('persona', svc);
}
```

（别忘 `package.json` 的 `aalis.service.provides` 与上面 `provides` 同步。）

## 5. 标准消费姿势

- **lazy 获取，不缓存句柄**：每次用前 `ctx.getService<PersonaService>('persona')`，不要把 service 存成字段长期持有 —— provider bounce（卸载/重载）会让旧句柄失效（见 `docs/concepts/lazy-service-access.md`）。
- **persona 是可选依赖**：在 `inject.optional` 里声明（如 agent / session-manager / tool-system 都如此），用前判 `if (!persona) ...` 并给降级值。agent 的降级是「只用 base prompt」（`packages/plugin-agent/src/index.ts:1107-1111`），cli 的降级是 `?? 'Aalis'`。
- **可选方法判存在再调**：接口里除两个核心方法外全带 `?`，统一写 `persona?.getNickNames?.()`、`persona?.getPersonaSkills?.()`，第三方 provider 可能没实现。
- **类型窄化避免包循环**：若只用一两个方法，按消费侧需要声明窄类型（`ctx.getService<{ isTimeInjectionEnabled?(): boolean }>('persona')`），不必 import 全量 `PersonaService`。
- **错误边界**：跨会话 / 可选读取统一 `try/catch` 后静默忽略（tool-session、persona 自身读 session-manager 都这么做），不要让 persona 不可用拖垮主链路。
- **`getPersonaSkills` 三态语义**：`undefined`=全开，`[]`=全禁，`['a','b']`=白名单。consumer 必须区分 `undefined` 与 `[]`（skills 插件用 `if (whitelist === undefined) return all`，`packages/plugin-skills/src/index.ts:499`）。

## 6. 能力 / 风险 → 影响

- **`personasDir` 是 storage 路径，经 `toStorageUri` 归一**：参考实现 `searchUris[0] = toStorageUri(personasDirRaw)`（`packages/plugin-persona/src/index.ts:461`）。`toStorageUri` 文法（`packages/plugin-storage-api/src/index.ts:301-307`）：已是 URI（含 `:/`）原样返回；`foo/bar` → `foo:/bar`（首段当根名）；单段裸名 `name` → `data:/name`（默认归 `data` 根）。读卡走 `createStorageGateway(ctx)` 网关按 URI 路由（`packages/plugin-persona/src/index.ts:458`）。注意 **storage 不是沙箱**：路径授权由 storage 的 root 权限位决定，persona 读到哪些卡取决于你给的 root。详见 `docs/concepts/storage-uri-grammar.md` 与 `docs/services/storage.md`。
- **跨会话身份隔离（防串档）**：参考实现把当前消息的会话身份（platform / sessionId / 群号 / 自身与发送者角色头衔）放进 `AsyncLocalStorage`，在 `agent:input:before` 用 `runWithIdentity()` 包住后续异步链（`packages/plugin-persona/src/index.ts:619-636, 261-264`）。**这是安全要点**：身份穿透 `await` 不串、并发会话各自隔离，杜绝把 A 会话的发送者信息泄漏进 B 会话的 LLM 提示。第三方 provider 若也注入会话上下文，必须保证同等隔离（不要用裸实例字段存「当前会话」）。
- **状态持久化**：`statePersistence` 开启时，reply 钩子把 outputFormat 的非回复字段（mood/state…）按类型强制后存进 `sessionStates`（`packages/plugin-persona/src/index.ts:691-713`），下一轮注入「你上一轮的状态」。状态参与 `memory:clear` 中间件（scope=session/all、type 含 `context`/`persona` 时清除，`packages/plugin-persona/src/index.ts:584-615`）。`getSessionState()` 只在内存里、按 sessionId 隔离，provider 不应跨会话泄漏。
- **outputFormat 严格校验 + 重试**：声明的所有字段必须出现且类型正确，否则抛错触发重试（`packages/plugin-persona/src/index.ts:750-779`）；重试次数来自 `OutputFormat.retries`（缺省 1），写入 `data.maxRetries` 透给 agent 的重试循环（`packages/plugin-persona/src/index.ts:819-822`，agent 侧 `packages/plugin-agent/src/index.ts:785-787`）。用尽后**静默丢弃**回复并通过 `archiveContent` 写系统提醒，避免把原始 JSON 当回复发出（`packages/plugin-persona/src/index.ts:843-853`）。

## 7. 边界与坑

- **「单例 PersonaService 跨平台」是真实约束**。trigger-policy 注释明确：mute 关键词不再从 persona 读，「避免单例 PersonaService 跨平台泄漏」（`packages/plugin-trigger-policy/src/detector.ts:5-6`）。persona 是进程级单例，会话差异全靠 `PersonaSessionOptions` 与 `AsyncLocalStorage` 身份；任何「当前会话状态」都不能写裸字段。
- **结构化输出的逻辑不在 service 方法里，而在 reply 钩子里**。`getOutputFormat()` 只返回声明；真正解析 / 回填 `data.content` / 状态持久化 / 重试全在 `agent:reply:before` 中间件（`packages/plugin-persona/src/index.ts:647-855`）。看 `getOutputFormat()` 以为就能拿到结构化结果会踩空。
- **reply 字段回退是「尽力而为」**：模型用错字段名时按别名表 `['response','reply','content','answer','text','msg']` 回退，或在只有单个字符串字段时取它（`packages/plugin-persona/src/index.ts:725-743`）。无 outputFormat 时也会在内容以 `{` 开头时尝试解包同类字段（`:671-685`）。这是容错而非契约保证。
- **角色卡加载是 cache-only + 启动预扫 + watch**：`loadCard` 只查缓存（`packages/plugin-persona/src/index.ts:242-247`），缓存由 `ready` 事件里的 `scanAll` 预填并由 storage `watch` 热更（`:550-581`）。新增卡文件在扫描/watch 触发前不可见；`storage.watch` 不可用（`watch?.` 为空）时只有重启才刷新。
- **YAML 解析失败静默吞**：`tryLoadCardFromUri` 整体 `try/catch` 返回 `undefined`（`packages/plugin-persona/src/index.ts:465-484`），坏卡不会报错只会「没加载到」，排障时看 `ctx.logger.info('已加载角色卡…')` 是否出现。
- **找不到主角色卡 → 回退内置 default**（name=`Aalis`，`packages/plugin-persona/src/index.ts:533-540`），不会报错；`getPersonaName()` 在 `name` 为空时返回 `"<fileName>，未设置名字"`（`:412-414`）。
- **`reply: true` 必须有且仅有一个**：`parseRawOutputFormat` 取最后一个 `reply:true` 的 key 作 `replyField`，**没有任何 reply 字段时整段 outputFormat 作废返回 `undefined`**（`packages/plugin-persona/src/index.ts:200-211`）。多个 reply 不会报错但只末个生效。

## 8. 交叉链接

- 概念：`docs/concepts/service-model.md`（DI 按名、优先级胜者）、`docs/concepts/lazy-service-access.md`（每次 getService 不缓存）、`docs/concepts/manifest-metadata.md`（provides/inject 双源）、`docs/concepts/storage-uri-grammar.md`（`<root>:/path` 与 `personasDir`）、`docs/concepts/message-llm-pipeline.md`（`agent:input:before` / `agent:reply:before` 钩子时序与 persona 在其中的位置）。
- 服务：`docs/services/agent.md`（主消费者，system prompt 组装 + 重试循环）、`docs/services/storage.md`（角色卡读取后端 + root 权限）、`docs/services/tools.md` 与 `docs/services/tool-session.md`（`system_time` 跳过、`delegate_to_session` 读 `getSessionState`）、`docs/services/commands.md`（session/persona 配置）。
- 核心：`docs/core/service.md`、`docs/core/context.md`、`docs/core/plugin.md`。
