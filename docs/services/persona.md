# persona 服务

## 1. 概述

persona 服务负责把「角色卡」渲染成 system prompt，并在回复链路里解析结构化输出（JSON），把结果回填到回复字段与角色状态。角色卡是一份 YAML 定义的人设，包含名字、描述、性格、prompt、结构化输出格式与 skill 白名单。

- 服务注册名：`'persona'`，通过 `ctx.getService<PersonaService>('persona')` 获取。
- 契约包：`@aalis/api-persona`。
- 这个契约带有运行时服务，不是纯类型契约。`-api` 包只导出 interface、类型与 declaration merging，不含实现；参考实现是 `@aalis/plugin-persona`，也是目前唯一的实现。
- 角色卡按名分文件存放在 `personasDir`（一个 storage 路径，见 §6）。进程启动时全量预扫进缓存，并支持通过 `watch` 热重载。

## 2. 契约

本节列出 `@aalis/api-persona` 的全部导出。

### 2.1 服务接口

```ts
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

只有 `getSystemPrompt()` 与 `getPersonaName()` 是必须实现的（接口里非可选），其余方法全部带 `?`。消费者对可选方法都做了存在性判断（见 §3、§5）。各方法语义如下：

- `getSystemPrompt(options?)` — 渲染当前生效角色卡的 system prompt 文本。参考实现在此之外还会拼入时间注入、会话环境（平台、群号、自身与发送者身份）、上一轮状态，以及 outputFormat 的 JSON 指令块。
- `getPersonaName()` — 返回角色卡的 `name`，用于 CLI 标题、触发昵称，以及 user-profile 的分堆 key。
- `getOutputFormat(options?)` — 返回角色卡声明的结构化输出格式。无定义时返回 `undefined`；`options.disableOutputFormat` 为真时也返回 `undefined`。
- `isClientSideJsonRendering(options?)` — 该卡是否声明「JSON 由客户端渲染」。为真时服务端不提取回复字段，整段 JSON 透传给前端。
- `listModels()` — 列出已扫描到的全部角色卡名，供 WebUI 与 session-manager 的下拉框使用。
- `getNickNames()` — 返回角色卡的 `nick_name` 列表，供触发检测匹配。
- `isTimeInjectionEnabled()` — persona 是否已注入当前时间。其它插件据此决定是否还要注册 `system_time` 工具。
- `getPersonaSkills(options?)` — 返回角色卡的 skill 白名单。约定：返回 `undefined` 表示未声明白名单（全部开放），返回 `[]` 表示禁用所有 skill。
- `getSessionState(sessionId)` — 读取目标会话最近一次保存的结构化状态（如 mood、state），供 `delegate_to_session` 等跨会话工具回报目标 agent 的「内心情况」。

### 2.2 重要类型

```ts
export interface OutputFormatField {
  description: string;                       // 写入 system prompt 供 LLM 理解
  type?: 'string' | 'number' | 'boolean';   // 影响占位符渲染 + 输出后类型强制
  reply?: boolean;                           // 是否为发给用户的回复字段（有且仅有一个）
}

export interface OutputFormat {
  fields: Record<string, OutputFormatField>; // key = JSON 字段名
  replyField: string;                        // 自动推断，取 reply:true 的那个 key
  retries: number;                           // 校验失败时额外重试次数，缺省 1，0=不重试
}

export interface PersonaSessionOptions {
  persona?: string;             // 覆盖角色卡名称
  disableOutputFormat?: boolean;// 禁用结构化输出格式
  clientSideJsonRendering?: boolean;
}
```

`PersonaSessionOptions` 的来源约定很关键：persona 服务自身不依赖 session-manager，它只根据传入的选项调整行为。会话级的覆盖由调用方（agent，或 persona 自己的 reply 钩子）从 `session-manager.resolveConfig()` 取出后构造，再传给 persona。

通过 declaration merging，服务名被登记进核心的 `ServiceTypeMap`，使 `getService('persona')` 能拿到强类型：

```ts
declare module '@aalis/core' {
  interface ServiceTypeMap {
    persona: PersonaService;
  }
}
```

## 3. 谁提供 / 谁消费

提供者是 `@aalis/plugin-persona`。其中 `PersonaServiceImpl` 实现接口，`apply()` 里通过 `ctx.provide('persona', service)` 注册。这是当前唯一的参考实现。

典型消费点如下，它们全部走可选依赖 + 存在性判断：

- `@aalis/plugin-agent`（核心消费者）— `buildSystemPrompt()` 取 persona 拼进 system 块：先 `const persona = this.ctx.getService<PersonaService>('persona')`，再 `persona.getSystemPrompt(personaOpts)`；`'persona'` 在其 `inject.optional` 中。注意 JSON 解析与状态持久化并不在 agent 里做，而是由 persona 自己挂 `agent:reply:before` 钩子统一处理（见 §4）。
- `@aalis/plugin-skills` — `getAllowedSkills()` 用 `persona?.getPersonaSkills?.()` 过滤暴露给 LLM 的 skill 列表。
- `@aalis/plugin-trigger-policy` — 用 `getPersonaName()` 与 `getNickNames()` 收集 bot 昵称，做唤起匹配。
- `@aalis/plugin-tool-system` — 通过 `getService<{ isTimeInjectionEnabled?(): boolean }>('persona')` 判断，已注入时间则跳过注册 `system_time` 工具。
- `@aalis/plugin-tool-session` — `delegate_to_session` 用 `getSessionState?.(targetSessionId)` 把目标会话的结构化状态附在委托结果里。
- `@aalis/plugin-session-manager` — `listModels()` 拉取所有卡名给 WebUI 下拉框；`configSchema` 里的 `persona` 字段用 `dynamicOptions: 'persona'`。
- `@aalis/plugin-webui-server` — 用 `getPersonaName()` 作展示名，用 `getService('persona')` 探测上报能力，`listModels()` 走通用的 `/models` 枚举。
- `@aalis/plugin-cli` — 多处用 `getService<PersonaService>('persona')?.getPersonaName() ?? 'Aalis'` 做命令行标题。
- `@aalis/plugin-user-profile` — 用 `getPersonaName()` 按 persona 名给自档案与指令分堆。

关于消费模式，有一点值得说明：多数消费者对类型做了结构化窄化，只声明自己用到的那部分（例如 tool-system 只声明 `{ isTimeInjectionEnabled?(): boolean }`），以避免 import 全量类型造成包循环。`ctx.getService<T>(name)` 的 `T` 按设计就由消费侧窄化。

## 4. 写一个 provider

### 4.1 最小必须 vs 可选

必须实现的是 `getSystemPrompt()` 与 `getPersonaName()`。只实现这两个，agent、cli、trigger 就能运行——trigger 只是少了几个昵称，tool-system 不会跳过 `system_time`。

其余带 `?` 的方法都是可选的。但要注意：如果你想支持 outputFormat 结构化输出，只实现 `getOutputFormat()` 是不够的。真正的 JSON 解析、回填、状态持久化与重试，发生在参考实现自己注册的 `agent:reply:before` 中间件里，而不是 agent 替你完成的。你的 provider 要复刻这套行为，就得自己挂同名钩子。

如果不打算做结构化输出，可以整块省略 `getOutputFormat`、`isClientSideJsonRendering` 与 reply 钩子。这种情况下 agent 会把 LLM 原文当作回复直接发出。

### 4.2 注册（priority / entryId / label）与双源同步

`provide` 的第三、四个参数可以携带优先级与标签。persona 是单例服务，参考实现用最简形式 `ctx.provide('persona', service)`，默认优先级为 `0`。同名竞争的胜者按「偏好（preference）> priority > 注册顺序」决定（见 `docs/concepts/service-model.md`）。如果你想覆盖默认 persona，可以用更高优先级，或让用户经 ServicePreference 选中：

```ts
ctx.provide('persona', myService, { priority: 50, label: '我的人设引擎' });
//                                ^priority                 ^entryId  ^label
```

manifest 的两个来源必须同步：除了运行时的 `export const provides = ['persona']`，还要在 `package.json` 里写静态清单 `aalis.service.provides`（供加载器与市场扫描）：

```json
"aalis": { "service": { "provides": ["persona"], "optional": ["platform"] } }
```

两源不一致会被一致性检查拦下，详见 `docs/concepts/manifest-metadata.md`。

### 4.3 最小可编译骨架

```ts
// src/index.ts
import type { Context } from '@aalis/core';
import type { PersonaService, OutputFormat, PersonaSessionOptions } from '@aalis/api-persona';

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

注意 `package.json` 的 `aalis.service.provides` 需与上面的 `provides` 保持同步。

## 5. 标准消费方式

- 惰性获取，不缓存句柄。每次使用前都 `ctx.getService<PersonaService>('persona')`，不要把 service 存成字段长期持有——provider bounce（卸载或重载）会让旧句柄失效（见 `docs/concepts/lazy-service-access.md`）。
- persona 是可选依赖。在 `inject.optional` 里声明它（agent、session-manager、tool-system 都如此），使用前用 `if (!persona) ...` 判断并给出降级值。agent 的降级是只用 base prompt，cli 的降级是 `?? 'Aalis'`。
- 可选方法先判存在再调。接口里除两个核心方法外全带 `?`，统一写成 `persona?.getNickNames?.()`、`persona?.getPersonaSkills?.()`，因为第三方 provider 可能没有实现。
- 用类型窄化避免包循环。如果只用一两个方法，按消费侧的需要声明窄类型（`ctx.getService<{ isTimeInjectionEnabled?(): boolean }>('persona')`），不必 import 全量的 `PersonaService`。
- 注意错误边界。跨会话与可选读取统一用 `try/catch` 后静默忽略（tool-session、persona 自身读 session-manager 都这么处理），不要让 persona 不可用拖垮主链路。
- 区分 `getPersonaSkills` 的三态语义：`undefined` 表示全开，`[]` 表示全禁，`['a','b']` 表示白名单。消费者必须区分 `undefined` 与 `[]`——skills 插件的判断是 `if (whitelist === undefined) return all`。

## 6. 能力 / 风险 → 影响

**`personasDir` 是 storage 路径，经 `toStorageUri` 归一。** 参考实现取 `searchUris[0] = toStorageUri(personasDirRaw)`。`toStorageUri` 的文法是：已经是 URI（含 `:/`）的原样返回；`foo/bar` 归一为 `foo:/bar`（首段当作根名）；单段裸名 `name` 归一为 `data:/name`（默认归入 `data` 根）。读卡时走 `createStorageGateway(ctx)` 网关，按 URI 路由。需要注意 storage 不是沙箱：路径授权由 storage 的 root 权限位决定，persona 能读到哪些卡取决于你授予的 root。详见 `docs/concepts/storage-uri-grammar.md` 与 `docs/services/storage.md`。

**跨会话身份隔离（防止会话间串档）。** 参考实现把当前消息的会话身份（platform、sessionId、群号、自身与发送者的角色头衔）放进 `AsyncLocalStorage`，并在 `agent:input:before` 用 `runWithIdentity()` 包住后续的异步链。这样身份能穿透 `await` 而不串，并发会话各自隔离，从而杜绝把 A 会话的发送者信息泄漏进 B 会话的 LLM 提示。

::: warning 安全要点
这是一处安全约束。第三方 provider 若也注入会话上下文，必须保证同等的隔离——不要用裸实例字段存储「当前会话」。
:::

**状态持久化。** `statePersistence` 开启时，reply 钩子会把 outputFormat 的非回复字段（如 mood、state）按类型强制后存进 `sessionStates`，并在下一轮注入「你上一轮的状态」。这些状态参与 `memory:clear` 中间件：当 scope 为 session 或 all、且 type 含 `context` 或 `persona` 时会被清除。`getSessionState()` 只读内存、按 sessionId 隔离，provider 不应跨会话泄漏。

**outputFormat 严格校验与重试。** 声明的所有字段必须出现且类型正确，否则抛错触发重试。重试次数来自 `OutputFormat.retries`（缺省 1），写入 `data.maxRetries` 透传给 agent 的重试循环。重试用尽后，回复会被静默丢弃，并通过 `archiveContent` 写一条系统提醒，以避免把原始 JSON 当作回复发出。

## 7. 边界与常见错误

**「单例 PersonaService 跨平台」是真实约束。** trigger-policy 的注释明确指出：mute 关键词不再从 persona 读，以避免单例 PersonaService 跨平台泄漏。persona 是进程级单例，会话差异全部依靠 `PersonaSessionOptions` 与 `AsyncLocalStorage` 身份来承载；任何「当前会话状态」都不能写进裸字段。

**结构化输出的逻辑不在 service 方法里，而在 reply 钩子里。** `getOutputFormat()` 只返回声明本身；真正的解析、对 `data.content` 的回填、状态持久化与重试，全在 `agent:reply:before` 中间件里完成。仅调用 `getOutputFormat()` 并不能得到结构化结果。

**reply 字段回退是尽力而为。** 当模型用错字段名时，会按别名表 `['response','reply','content','answer','text','msg']` 回退；或者在只有单个字符串字段时直接取它。没有 outputFormat 时，如果内容以 `{` 开头，也会尝试解包同类字段。这是容错行为，不是契约保证。

**角色卡加载是 cache-only + 启动预扫 + watch。** `loadCard` 只查缓存，缓存由 `ready` 事件里的 `scanAll` 预填，并由 storage 的 `watch` 做热更新。新增的卡文件在扫描或 watch 触发前不可见；当 `storage.watch` 不可用时（`watch?.` 为空），只有重启才会刷新。

**YAML 解析失败会被静默吞掉。** `tryLoadCardFromUri` 整体用 `try/catch`，失败时返回 `undefined`。坏卡不会报错，只会表现为「没有加载到」。排障时可以看 `ctx.logger.info('已加载角色卡…')` 是否出现。

**找不到主角色卡时回退到内置 default。** 此时 name 为 `Aalis`，不会报错。另外，`getPersonaName()` 在 `name` 为空时返回 `"<fileName>，未设置名字"`。

**`reply: true` 必须有且仅有一个。** `parseRawOutputFormat` 取最后一个 `reply:true` 的 key 作为 `replyField`。如果没有任何 reply 字段，整段 outputFormat 作废并返回 `undefined`。存在多个 reply 字段时不会报错，但只有最后一个生效。

## 8. 交叉链接

- 概念：`docs/concepts/service-model.md`（按名 DI、优先级胜者）、`docs/concepts/lazy-service-access.md`（每次 getService、不缓存）、`docs/concepts/manifest-metadata.md`（provides/inject 双源）、`docs/concepts/storage-uri-grammar.md`（`<root>:/path` 与 `personasDir`）、`docs/concepts/message-llm-pipeline.md`（`agent:input:before` 与 `agent:reply:before` 钩子的时序，以及 persona 在其中的位置）。
- 服务：`docs/services/agent.md`（主消费者，system prompt 组装与重试循环）、`docs/services/storage.md`（角色卡的读取后端与 root 权限）、`docs/services/tools.md` 与 `docs/services/tool-session.md`（`system_time` 跳过、`delegate_to_session` 读 `getSessionState`）、`docs/services/commands.md`（session 与 persona 配置）。
- 核心：`docs/core/service.md`、`docs/core/context.md`、`docs/core/plugin.md`。
