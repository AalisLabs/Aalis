# commands 服务

斜杠指令（`/command`）的注册与分发：第三方插件用它把斜杠命令挂进所有平台共享的入站管道。

- **服务注册名**：`getService<CommandService>('commands')`（声明合并见 `packages/plugin-commands-api/src/index.ts:279-283`）。
- **契约包**：`@aalis/plugin-commands-api`（纯类型 + `useCommandService` helper，无运行时实现）。
- **参考实现**：`@aalis/plugin-commands`（`CommandRegistry`，`packages/plugin-commands/src/commands.ts:68`）。
- **内核视角文档**：`docs/core/commands.md`。

> 绝大多数插件作者**只需要写 provider 的消费者**（注册命令），不会自己实现 `CommandService`。注册一律走 `useCommandService(ctx)`，详见第 4 节。第 3 节的"写 provider"只为想替换整个指令引擎的高级作者准备。

---

## 1. 契约：CommandService 接口

`CommandService`（`packages/plugin-commands-api/src/index.ts:162-191`）的关键方法：

```ts
export interface CommandService {
  prefix: string;

  /** 启动 builder 注册一个命令。name 含 inline DSL：'memory.set <key:string> [value:text]' */
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;

  unregister(name: string): void;
  unregisterByPlugin(pluginName: string): void;

  execute(name: string, ctx: ExecutionInput): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;

  /** head + tokens 能否解析到任何已注册节点（区分"已识别指令"与"碰巧带前缀") */
  hasMatch(head: string, tokens?: string[]): boolean;

  has(name: string): boolean;                       // 顶层段是否存在（含分组节点）
  get(name: string): Command | undefined;
  getNode(name: string | string[]): Command | undefined;
  getAll(): Command[];

  setExecutionGuard(guard: ExecutionGuard): void;   // 由 authority 注入权限闸
}
```

Builder（`index.ts:147-153`）链式追加 `alias / option / action / usage / example`，全部返回 `CommandBuilder` 自身。

重要类型：

- **命令名 = 完整点路径**（`'memory.clear.all'`），点分段在注册时自动建立分组节点（无 handler，`isGroup: true`）。名字段必须匹配 `^[a-z][a-z0-9-]*$`（`commands.ts:36`、`commands.ts:600-604`）。
- **inline DSL**：名字里可带位置参数 `<name:type>`（必填）/ `[name:type]`（可选），`type ∈ string|number|boolean|text`（`PositionalArgType`，`index.ts:49`）。`text` 吞掉剩余全部 token 拼成一句（`commands.ts:500`、`commands.ts:701`）。
- **CommandHandler**（`index.ts:42-45`）：`(argv: CommandArgv, ...positionals: unknown[]) => Promise<string|undefined>|string|undefined`。位置参数按 DSL 顺序作为**形参**传入，不在 `argv` 里。返回字符串即回复内容，返回 `undefined` 则静默。
- **CommandArgv**（`index.ts:24-35`）：`argv.session.{sessionId, platform, userId?, sessionType?, raw}` + `argv.options: Record<string, unknown>`。`sessionType ∈ 'group'|'private'|'channel'`（适配器标注，私聊敏感指令据此设防）。
- **CommandMeta**（`index.ts:81-92`）：注册时声明 `visibility`（轴 A 可见性 `public`/`restricted`）、`confirm`（轴 B 确认 `session`/`always`）、`risk`（声明糖 `safe`/`sensitive`/`dangerous`）、`usage`、`examples`。三者关系见第 5 节。
- **OptionSpec / OptionRegisterOptions**（`index.ts:59-76`、`index.ts:140-145`）：`option(name, syntax, opts?)` 的 syntax 描述别名与取值占位符，详见第 4 节示例。
- **ExecutionInput**（`index.ts:120-136`）：`execute()` 的入参，含 `skipConfirm`——供 scheduler 等无人可点确认弹窗的受信源跳过交互确认（**不绕过授权**，见第 5 节）。

---

## 2. 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-commands`。

- 注册服务：`ctx.provide('commands', commands)`（`packages/plugin-commands/src/index.ts:108`），`commands = new CommandRegistry(ctx.logger)`（`index.ts:99`）。
- `provides = ['commands']`（`index.ts:16`），`inject.required = ['gateway']`（`index.ts:17-19`），双源同步在 `package.json` 的 `aalis.service`（`provides:['commands'] / required:['gateway']`）。
- 入站分发：在 `INBOUND_PHASE.COMMAND`（`'inbound:command'`，`plugin-gateway-api` 把它排在 flow/trigger/dispatch 之前，`packages/plugin-gateway-api/src/index.ts:122-136`）的中间件里 `parseCommand` → `hasMatch` → `execute`，命中后**不调用 `next()`**，整个入站管道立即停止（`plugin-commands/src/index.ts:170-221`）。
- **运行时依赖 `@aalis/plugin-authority-api`**：`CommandRegistry` `import { riskDefaults }`（`commands.ts:8`）把 `risk` 声明展开为 `(visibility, confirm)` 默认值（`commands.ts:114-115`）。这是真实运行时依赖（在 `plugin-commands` 的 `dependencies` 里，不是 devDep）。

**典型消费点**（都通过 `useCommandService(ctx)` 注册命令）：

- `@aalis/plugin-authority`：注册 `/authority`、`/level`、`/auto` 等（`packages/plugin-authority/src/index.ts:43`、`:125`、`:146`、`:164`），并通过 `whenService` 注入权限守卫（`:107-112`）。
- `@aalis/plugin-agent`：`/model`、`/model.info/.set/.reset`（`packages/plugin-agent/src/index.ts:1774-1800`）。
- `@aalis/plugin-doctor`：`/doctor`（`packages/plugin-doctor/src/index.ts:161-166`）。
- `@aalis/plugin-tool-system`、`@aalis/plugin-user-profile`、`@aalis/plugin-user-relation`、`@aalis/plugin-maimai` 等。
- `commands` 几乎总是 **optional 依赖**：`plugin-adapter-onebot`（`optional:['…','commands',…]`，`src/index.ts:71`）、`plugin-cli`（`src/index.ts:36`）、`plugin-doctor`（`src/index.ts:26`）。

---

## 3. 写一个 provider（替换指令引擎，高级）

> 仅当你要替换整套指令引擎时才需要这节。注册命令请直接看第 5 节。

**最小必须实现**：`CommandService` 接口全部方法（`index.ts:162-191`）。核心语义不能少：

- `command()` 返回的 builder 必须支持热转发与重放——`useCommandService` 内部用 `ctx.whenService` 在 provider 每次上线时重新创建 builder 并重放积压调用（`index.ts:233-246`），所以你的 `command()` 必须能被多次调用且幂等覆盖同名节点。
- `execute()` 在调用 handler **之前**必须执行已注入的 `ExecutionGuard`（若有），守卫返回非 `null` 字符串即拦截、把该串当结果回给用户（见 `commands.ts:299-312`）。**这是安全契约的关键，不能跳过。**
- `parseCommand` / `hasMatch` 要能区分"带前缀但无人注册"（让入站管道放行到普通消息）与"已命中"。

**可选**：`prefix` 可配（默认 `/`，空串=纯关键词触发）；`setExecutionGuard` 若不实现，authority 注入时有 `if (svc.setExecutionGuard)` 兜底跳过（`plugin-authority/src/index.ts:108`），但那样**所有命令将无权限闸**，强烈不建议省略。

**ctx.provide 注册**：

```ts
import type { Context } from '@aalis/core';
import type { CommandService } from '@aalis/plugin-commands-api';

export const name = '@aalis/plugin-my-commands';
export const provides = ['commands'];
export const inject = { required: ['gateway'] };

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const svc: CommandService = new MyCommandRegistry(ctx.logger);
  svc.prefix = (config.commandPrefix as string) ?? '/';
  // 默认 ServicePriority.Backend(0)。要顶替内置 plugin-commands，用更高优先级或 preference。
  ctx.provide('commands', svc);
  // 自行在 INBOUND_PHASE.COMMAND 中间件里跑 parseCommand→hasMatch→execute（参考 plugin-commands/src/index.ts:170）
}
```

**双源同步**：除了 `export const provides/inject`，`package.json` 的 `aalis.service` 也要写（与参考实现一致）：

```json
{ "aalis": { "service": { "provides": ["commands"], "required": ["gateway"] } } }
```

DI 按名取胜：同名 provider 的胜者 = preference > priority（`ServicePriority` Backend0/Override50/System200）> 注册顺序；不存在能力匹配选择（0.5.0 已移除）。详见 `docs/concepts/service-model.md`。

---

## 4. 标准消费姿势：注册命令

用 `useCommandService(ctx)`（`index.ts:200-210`）——它自动带上 `pluginName = ctx.id`，并在 `commands` provider 尚未上线时缓存调用、上线后重放（懒注册，无需手动等待服务）：

```ts
import { useCommandService } from '@aalis/plugin-commands-api';

export const name = '@aalis/plugin-weather';
// commands 通常作为 optional 依赖（无指令系统时插件其它能力仍可用）
export const inject = { optional: ['commands'] };

export function apply(ctx: Context): void {
  useCommandService(ctx)
    .command('weather <city:string> [day:number]', '查询天气')
    .option('unit', '-u <unit:string>', { choices: ['c', 'f'], default: 'c' })
    .example('/weather 北京')
    .example('/weather 上海 3 -u f')
    .action(async (argv, city, day) => {
      // 位置参数按 DSL 顺序入形参；选项在 argv.options
      const unit = argv.options.unit as string;
      return `${city} 天气（${day ?? 0} 天后, ${unit}）…`;
    });
}
```

option syntax 速查（`commands.ts:606-665`）：

- `'-v'` → boolean flag，别名 `v`。
- `'-p <page:number>'` → number 选项，别名 `p`，必带值。
- `'-p [page:number]'` → 值可选（flag 在但无值给 `true`）。
- `'<page:number>'` → 仅长名 `--page`，必带值。
- `'-t <type:string[]>'` → `string[]`，可重复或逗号分隔累积（`/clear -t a -t b,c`，见 `plugin-commands/src/index.ts:345`、`commands.ts:683-692`）。
- `''`（空）→ 纯 boolean flag。

**懒访问与缺失处理**：

- 注册侧不用判 `commands` 是否存在——`useCommandService` 已用 `whenService` 处理懒上线/provider bounce 重放。
- 若要**调用** `getService<CommandService>('commands')`（如自查 `getAll()`），遵守懒访问铁律：**每次用都现取，不要缓存**（provider bounce 会让旧引用失效）。`useCommandService(ctx).raw` 即 `ctx.getService('commands')`（`index.ts:206-208`），同样不要长期持有。见 `docs/concepts/lazy-service-access.md`。
- **错误边界**：handler 抛错被 `execute` 捕获并转成 `指令执行失败: <msg>` 回给用户（`commands.ts:327-331`）；选项/参数解析错误（数字非法、choices 越界、缺必填）返回可读错误串而非抛出（`commands.ts:451`、`commands.ts:493`、`commands.ts:511-514`）。所以 handler 内不必兜所有异常，但应对**可预期**的用户输入错误返回友好提示。

---

## 5. 能力 / 风险 → 影响（provider 与 consumer 必须遵守）

指令权限走**两轴正交闸**（与工具同一套 `ExecutionGuard`），见 `docs/core/authority.md` 与 `docs/concepts/security-model.md`：

- **轴 A · 可见性 / 授权**：`visibility: 'public'`（默认）任何人可见可调；`'restricted'` 须 owner 或被委托授予。
- **轴 B · 确认**：`confirm: 'session'`（可本会话记住）/ `'always'`（每次必确认，owner 也吃）。与可见性正交。
- **risk 声明糖**（`CapabilityRisk`，`plugin-authority-api/src/index.ts:34-55`）展开为默认：`safe→(public,无确认)`、`sensitive→(restricted,无确认)`、`dangerous→(restricted,'session')`。显式 `visibility`/`confirm` 覆盖 risk 推导值（`commands.ts:114-115`、`riskDefaults` at `authority-api:61-66`）。
- **沿点路径继承**：子命令未声明则取最近声明的祖先分组的 `visibility/confirm/risk`，子节点可覆盖（`commands.ts:336-355`）。所以把高危子命令分到一个 `restricted` 分组下即可整组设防（如内置 `/clear all` 显式 `visibility:'restricted'`，`plugin-commands/src/index.ts:356-361`）。
- **risk 透传供 minLevel 派生**：`execute` 把 `cmd.risk` 原样传给守卫，authority 据此派生最低等级（`riskToLevel`：safe→0 / sensitive→1 / dangerous→2，`plugin-authority/src/authority-model.ts:23-27`）；无 risk 回退 `visibility`（restricted→2 / public→0）（`ExecutionGuardContext`，`authority-api:98-101`）。

**consumer 责任**：诚实声明 `visibility/confirm/risk`。写删/改系统/shell 类命令应至少 `risk:'dangerous'`（或显式 `visibility:'restricted', confirm:'session'`）。`confirm:'always'` 即便 owner 在会话内被提示注入也挡得住静默提权（`authority-api:29-31`）。

**provider 责任**：`execute` 调 handler 前必须跑守卫并尊重其返回（拦截即不执行）。受信系统源（scheduler/workflow/system）经 `skipConfirm:true` 只跳过**确认弹窗**，授权仍照评估，绝不绕过 `authorize`（防提权，`ExecutionInput` 注释 `index.ts:128-135`、守卫逻辑 `plugin-authority/src/index.ts:81-101`）。参考实现的入站中间件据 `message.source ∈ {scheduler,workflow,system}` 设 `skipConfirm`（`plugin-commands/src/index.ts:168`、`:194`）。

**SSRF / 沙盒不归 commands 管**：命令系统本身不做网络出口或文件沙盒。handler 内对外抓取须走 `safeFetch`（`@aalis/util-network-guard`，见 `docs/concepts/security-model.md`），文件读写走 `storage` 的 `<root>:/path` 文法（storage **不是**沙盒，见 `docs/concepts/storage-uri-grammar.md`）。

---

## 6. 边界与坑

1. **ExecutionGuard 是 fail-open（最关键）**：`execute` 只在 `if (this._guard)` 时跑守卫（`commands.ts:299`）。守卫由 `@aalis/plugin-authority` 通过 `setExecutionGuard` 注入（`plugin-authority/src/index.ts:107-112`）。**若 `plugin-authority` 未加载，没有任何守卫被注入，则全部 `restricted` 命令对所有人无闸放行。** 这是部署侧的安全约束：依赖命令权限的部署必须确保 authority 在线。consumer 不能假设守卫一定存在——但安全声明（`visibility/risk/confirm`）仍要照写，authority 一旦在线即生效。

2. **whenService 重放期间的窗口**：authority 用 `whenService` 注入守卫（provider 上线/重启各调一次）。`plugin-commands` 与 `plugin-authority` 各自独立加载；若命令在守卫注入之前被执行，会按"无守卫"放行。正常启动顺序由 DI 依赖解析，但 provider bounce（重载）瞬间存在理论窗口。

3. **同名命令静默覆盖**：重复 `.command('foo')` 后者覆盖前者，仅打 `warn` 日志（`commands.ts:101-109`）。别名冲突同理（`commands.ts:133-135`）。第三方插件应给命令名加领域前缀（如 `myplugin.sync`）避免撞内置 `help/status/clear/...`。

4. **位置参数全是 `unknown`**：handler 形参类型是 `unknown`，框架按 DSL 的 type 解析（number 解析失败返回错误串），但 TS 层面你需自行断言（`argv, city, day` 都是 `unknown`）。可选位置参数缺省时传 `undefined`（`commands.ts:501-504`）。

5. **`text` 类型贪婪**：`text` 位置参数吞掉光标后剩余全部 token，必须放在位置参数列表**最后**，否则后续参数永远拿不到值（`commands.ts:500`）。

6. **纯关键词模式（prefix=''）需命中首段**：`prefix` 设空串时，只有输入首词命中已注册命令首段才认作命令，否则放行为普通消息（`commands.ts:208-210`），避免把每句聊天都当命令解析。

7. **命令命中即终止入站管道**：参考实现命中后不调 `next()`，flow/trigger/agent/归档等下游相位**全部不执行**（`plugin-commands/src/index.ts:220`）。但"带前缀却无人注册"（`hasMatch` 为 false）会放行到下游而非回显"未知指令"，避免对错字噪音误判（`:178-180`）。

---

## 7. 交叉链接

- 概念：`docs/concepts/service-model.md`（DI 按名取胜、优先级）、`docs/concepts/lazy-service-access.md`（每次现取、provider bounce）、`docs/concepts/manifest-metadata.md`（provides/inject 双源）、`docs/concepts/security-model.md`（两轴闸、safeFetch、确认）、`docs/concepts/message-llm-pipeline.md`（入站相位顺序）、`docs/concepts/storage-uri-grammar.md`。
- 内核文档：`docs/core/commands.md`（CommandRegistry 细节）、`docs/core/authority.md`、`docs/core/tools.md`（同源 `ExecutionGuard`）、`docs/core/service.md`、`docs/core/context.md`。
- 设计：见内核文档 `docs/core/commands.md`。
- 同源契约：`@aalis/plugin-authority-api`（`ExecutionGuard`、`CapabilityRisk/Visibility/Confirm`、`riskDefaults`）。
