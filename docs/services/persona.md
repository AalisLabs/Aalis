# persona 服务

## 1. 概述

persona 服务负责把「角色卡」渲染成 system prompt，并在回复链路里解析结构化输出（JSON），把结果回填到回复字段与角色状态。角色卡是一份 YAML 定义的人设，包含名字、描述、性格、prompt、结构化输出格式与 skill 白名单。

- 服务注册名：`'persona'`，消费方经 `persona.use` 调用。
- 契约包：`@aalis/api-persona`。
- 这个契约带有运行时服务，不是纯类型契约。`-api` 包只导出 interface、类型与服务描述符 `persona`，不含实现；参考实现是 `@aalis/plugin-persona`，也是目前唯一的实现。
- 角色卡按名分文件存放在 `personasDir`（一个 storage 路径，见 §6）。storage 在场时全量预扫进缓存并挂监听热重载；storage 提供者重启、改配置或晚于启动上线时重挂监听并重扫。

## 2. 契约

本节列出 `@aalis/api-persona` 的全部导出。

### 2.1 服务接口

```ts
export interface PersonaService {
  getSystemPrompt(options?: PersonaSessionOptions): string;
  getVolatilePrompt?(options?: PersonaSessionOptions): string;
  getPersonaName(options?: PersonaSessionOptions): string;
  listModels?(): Promise<string[]>;
  getNickNames?(options?: PersonaSessionOptions): string[];
}
```

只有 `getSystemPrompt()` 与 `getPersonaName()` 是必须实现的（接口里非可选），其余方法全部带 `?`。消费者对可选方法都做了存在性判断（见 §3、§5）。各方法语义如下：

- `getSystemPrompt(options?)` — 渲染这个会话生效角色卡的静态人设：名字、描述、性格、prompt，这个会话的「额外提示」，以及 outputFormat 的 JSON 指令块。同一张卡下逐轮不变，以便命中 LLM provider 的前缀缓存。
- `getVolatilePrompt(options?)` — 返回易变上下文：时间注入（`timeInjection`）、会话环境（平台、群号、自身与发送者身份、群聊身份判定规则）、上一轮状态（`statePersistence`）。无内容时返回空串。调用方应把它放在历史消息之后、当前用户消息之前；逐轮变化的内容不能放进 `getSystemPrompt`，否则前缀缓存整条失效。
- `getPersonaName(options?)` — 返回角色卡的 `name`：按 `options` 这个会话的「人设」取卡（找不到该卡时回落主卡），不给会话时按人设插件的配置。触发插件、终端的标题与署名都按会话传入（终端取它自己会话的生效人设）；没有会话的用途不传。
- `listModels()` — 列出已扫描到的全部角色卡名，供会话设置里「人设」的可选项（webui-server 按服务名合起各提供者的 `listModels()`）。
- `getNickNames(options?)` — 返回角色卡的 `nick_name` 列表，供触发检测匹配；按 `options` 取卡，同 `getPersonaName`。

### 2.2 重要类型

```ts
export interface PersonaSessionOptions {
  sessionId?: string;   // 按这个会话读人设插件自己的会话设置
  platform?: string;    // 入口平台：只对没有出生平台的会话起作用
}
```

调用方只交会话，人设服务按这个会话读自己的四项会话设置（人设、额外提示、两个结构化输出开关，见 [plugin-persona](../plugins/plugin-persona.md)）。不给会话时按人设插件的配置。

服务描述符随契约包导出，类型随描述符走：

```ts
export const persona = defineService<PersonaService>('persona');
```

消费方把描述符写进 `uses`，`persona.use` 即推断为 `PersonaService`。

## 3. 谁提供 / 谁消费

提供者是 `@aalis/plugin-persona`。其中 `PersonaServiceImpl` 实现接口，`apply()` 里通过 `provide.use(persona, service)` 注册。这是当前唯一的参考实现。四项会话设置（`persona`、`systemPromptExtra`、`disableOutputFormat`、`clientSideJsonRendering`）是它的可按会话覆盖的插件配置字段，经会话设置的读取器按 `PersonaSessionOptions` 给的会话读。

典型消费点如下，它们全部走可选依赖 + 存在性判断：

- `@aalis/plugin-agent`（核心消费者）— `buildSystemPrompt()` 取 persona 拼进 system 块：先 `const persona = this.caps.persona.present ? this.caps.persona.use : undefined`，再 `persona.getSystemPrompt(personaOpts)`；易变上下文由 `getVolatilePrompt?.(personaOpts)` 取出，作为 system 消息放在历史之后、当前用户消息之前；`'persona'` 在其 `uses optional` 中。注意 JSON 解析与状态持久化并不在 agent 里做，而是由 persona 自己挂 `agent:reply:before` 钩子统一处理（见 §4）。
- 触发插件（`@aalis/plugin-trigger-policy` 等，经 `@aalis/api-trigger` 的 `createBotNames`）— 按会话取在用的人设（触发插件按自己的服务偏好选出的提供者）的 `getPersonaName(options)` 与 `getNickNames(options)`，收集 bot 名字与昵称，做点名识别。
- `@aalis/plugin-webui-server` — 不声明 persona 依赖；会话设置里人设的可选项（`dynamicOptions: 'persona'`）按服务名合起各提供者的 `listModels()`。
- `@aalis/plugin-cli` — 先看 `persona.present` 再取 `persona.use.getPersonaName({ sessionId, platform: 'cli' })`（终端会话的生效人设），用作对话里的署名与状态栏；缺席时署名回退 `'Aalis'`。

消费者都把描述符 `persona` 写进 `uses`（以 `optional` 声明），类型随描述符走。只有按字符串名动态查询时（如 webui-server 的 `services.use.all('persona')`）不带类型，由消费侧窄化。

## 4. 写一个 provider

### 4.1 最小必须 vs 可选

必须实现的是 `getSystemPrompt()` 与 `getPersonaName()`。只实现这两个，agent、cli、trigger 就能运行——trigger 只是少了几个昵称。

其余带 `?` 的方法都是可选的。契约里没有结构化输出的方法：如果你想支持 outputFormat 结构化输出，JSON 指令块写进 `getSystemPrompt()`，JSON 解析、回填、状态持久化与重试发生在参考实现自己注册的 `agent:reply:before` 中间件里，而不是 agent 替你完成的。你的 provider 要复刻这套行为，就得自己挂同名钩子。

如果不打算做结构化输出，不挂 reply 钩子即可。这种情况下 agent 会把 LLM 原文当作回复直接发出。

### 4.2 注册（priority / entryId / label）与双源同步

`provide.use` 的 options 参数可以携带优先级与标签。persona 是单例服务，参考实现用最简形式 `provide.use(persona, service)`，默认优先级为 `0`。同名竞争时消费方选中哪一家按「本插件偏好 > 全局偏好 > priority > 注册顺序」决定（见 `docs/concepts/service-model.md`）。如果你想覆盖默认 persona，可以用更高优先级，或让用户经 ServicePreference 选中：

```ts
provide.use(persona, myService, { priority: 50, label: '我的人设引擎' });
```

manifest 的两个来源必须同步：除了运行时的 `provides: [persona]`，还要在 `package.json` 里写静态清单 `aalis.service.provides`（供加载器与市场扫描）：

```json
"aalis": { "service": { "provides": ["persona"], "optional": ["platform"] } }
```

两源不一致会被一致性检查拦下，详见 `docs/concepts/manifest-metadata.md`。

### 4.3 最小可编译骨架

```ts
import { persona } from '@aalis/api-persona';
import type { PersonaService, PersonaSessionOptions } from '@aalis/api-persona';
import { platform } from '@aalis/api-platform';
import { config, definePlugin, optional, provide } from '@aalis/core';

class MyPersona implements PersonaService {
  prompt = '请友好地交流。';
  nameStr = 'Aalis';
  getSystemPrompt(_options?: PersonaSessionOptions): string {
    return this.prompt;
  }
  getPersonaName(): string {
    return this.nameStr;
  }
}

export default definePlugin({
  name: '@aalis/plugin-my-persona',
  provides: [persona],
  uses: { provide, config, platform: optional(platform) },
  apply({ provide, config, platform }) {
    void platform;
    const svc = new MyPersona();
    svc.prompt = (config.use.prompt as string) ?? '请友好地交流。';
    svc.nameStr = (config.use.name as string) ?? 'Aalis';
    provide.use(persona, svc);
  },
});
```

注意 `package.json` 的 `aalis.service.provides` 需与上面的 `provides` 保持同步。

## 5. 标准消费方式

- 业务句柄是活的。`persona.use` 的选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。
- persona 是可选依赖。在 `uses optional` 里声明它（agent、cli 与两个触发插件都如此），使用前先看 `persona.present` 并给出降级值。agent 的降级是只用 base prompt，cli 的降级是 `?? 'Aalis'`。
- 可选方法先判存在再调。接口里除两个核心方法外全带 `?`，统一写成 `persona?.getNickNames?.()`，因为第三方 provider 可能没有实现。
- 注意错误边界。跨会话与可选读取统一用 `try/catch` 后静默忽略（persona 自身读 session-manager 就这么处理），不要让 persona 不可用拖垮主链路。

## 6. 能力 / 风险 → 影响

**`personasDir` 是 storage 路径，经 `toStorageUri` 归一。** 参考实现只在 `toStorageUri(personasDirRaw)` 这一个目录下找卡。`toStorageUri` 的文法是：已经是 URI（含 `:/`）的原样返回；`foo/bar` 归一为 `foo:/bar`（首段当作根名）；单段裸名 `name` 归一为 `data:/name`（默认归入 `data` 根）。读卡时经 `caps.storage.use`，按 URI 路由。需要注意 storage 不是沙箱：路径授权由 storage 的 root 权限位决定，persona 能读到哪些卡取决于你授予的 root。详见 `docs/concepts/storage-uri-grammar.md` 与 `docs/services/storage.md`。

**跨会话身份隔离（防止会话间串档）。** 参考实现把当前消息的会话身份（platform、sessionId、群号、自身与发送者的角色头衔）放进 `AsyncLocalStorage`，并在一轮开始的 `agent:turn:before` 用 `runWithIdentity()` 包住后续的异步链。这样身份能穿透 `await` 而不串，并发会话各自隔离，从而杜绝把 A 会话的发送者信息泄漏进 B 会话的 LLM 提示。会话管理在场时，平台取它记下的出生平台（子任务取根会话的）；记下的聊天窗口是多方会话时，群号取窗口的目标；类型名在消息上没有时（定时、编排、空闲这类合成回合不经适配器）取聊天窗口的类型。这些只用于提示词，不写回消息。会话事实取自开轮的输入；说话人事实（发送者 ID、昵称、群身份与头衔）只在这一轮各条输入的说话人相同时写，几个人的话一起开的一轮没有单一的当前发送者，不写。

::: warning 安全要点
这是一处安全约束。第三方 provider 若也注入会话上下文，必须保证同等的隔离——不要用裸实例字段存储「当前会话」。
:::

**状态持久化。** `statePersistence` 开启时，reply 钩子会把 outputFormat 的非回复字段（如 mood、state）按类型强制后存进 `sessionStates`，并在下一轮注入「你上一轮的状态」。这些状态参与 `memory:clear` 中间件：scope 为 all 时清全部会话的，否则清当前会话的；只在未指定 type、或 type 含 `context` 或 `persona` 时参与（`persona` 类型由参考实现登记）。状态只存内存、按 sessionId 隔离，provider 不应跨会话泄漏。

**outputFormat 严格校验与重试。** 声明的所有字段必须出现且类型正确，否则抛错触发重试。重试次数来自角色卡的 `outputFormatRetries`（缺省 1），写入 `data.maxRetries` 透传给 agent 的重试循环。重试用尽后，回复会被静默丢弃，以避免把原始 JSON 当作回复发出。解码成功时，钩子把回复字段写进 `data.visibleContent`：落库内容是整串 JSON，agent 据此在 assistant 消息的 metadata 里另存可见正文（键见 schema-message 的 `WellKnownMetadataKeys.VisibleContent`），agent 交给模型的历史取可见正文。

## 7. 边界与常见错误

**「单例 PersonaService 跨平台」是真实约束。** 触发插件共用的点名识别（`@aalis/api-trigger`）的注释明确指出：mute 关键词不从 persona 读，以避免单例 PersonaService 跨平台泄漏。persona 是进程级单例，会话差异全部依靠 `PersonaSessionOptions` 与 `AsyncLocalStorage` 身份来承载；任何「当前会话状态」都不能写进裸字段。

**结构化输出的逻辑在 reply 钩子里，不在契约方法里。** 角色卡的格式声明与会话的两个结构化输出开关只在参考实现内部读；解析、对 `data.content` 的回填、状态持久化与重试，全在 `agent:reply:before` 中间件里完成。

**角色卡加载是 cache-only + 跟随 storage 预扫 + watch。** `loadCard` 只查缓存。`app:ready` 起插件跟随 storage 提供者（`storage.follow`）：提供者在场即挂监听并用 `scanAll` 全量预填，提供者重启、改配置或晚于启动上线时先关旧监听再重挂、重扫；之后由 storage 的 `watch` 做热更新。新增的卡文件在扫描或 watch 触发前不可见；目录所在根不支持 `watch` 时（调用抛错，记一条 warn），只有 storage 换代或重启才会刷新。目录列不出（不是不存在）时本次扫描失败并记 warn，已载入的卡不剔除。

**YAML 解析失败会点名告警，但不会阻止启动。** `tryLoadCardFromUri` 把「读不到文件」与「读到了但解析不出对象」分开：前者是候选路径探测的正常结果（静默），后者 warn 出 uri 与原因后跳过该卡。顶层不是对象（标量/数组）的卡按解析失败处理，不再被当成全空卡加载。启动时主角色卡解析失败则回退内置 default，日志说的是「存在但解析失败」而非「未找到」。运行中主角色卡被删或写坏时不回退：已载入的那份继续生效，直到它重新解析成功或重启。

**启动时找不到主角色卡则回退到内置 default。** 此时 name 为 `Aalis`，不会报错。另外，`getPersonaName()` 在 `name` 为空时返回 `"<fileName>，未设置名字"`（按会话取的卡没写名字时是那张卡的文件名）。

**`reply: true` 必须有且仅有一个。** `parseRawOutputFormat` 取最后一个 `reply:true` 的 key 作为 `replyField`。如果没有任何 reply 字段，整段 outputFormat 作废并返回 `undefined`。存在多个 reply 字段时不会报错，但只有最后一个生效。

## 8. 交叉链接

- 概念：`docs/concepts/service-model.md`（按名 DI、挑选规则）、`docs/concepts/lazy-service-access.md`（业务句柄是活的）、`docs/concepts/manifest-metadata.md`（aalis.service 与 definePlugin provides/uses 双源）、`docs/concepts/storage-uri-grammar.md`（`<root>:/path` 与 `personasDir`）、`docs/concepts/message-llm-pipeline.md`（`agent:turn:before` 与 `agent:reply:before` 钩子的时序，以及 persona 在其中的位置）。
- 服务：`docs/services/agent.md`（主消费者，system prompt 组装与重试循环）、`docs/services/storage.md`（角色卡的读取后端与 root 权限）、`docs/services/commands.md`（session 与 persona 配置）。
- 核心：`docs/core/service.md`、`docs/core/context.md`、`docs/core/plugin.md`。
