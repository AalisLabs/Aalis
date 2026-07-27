# commands 服务

斜杠指令（`/command`）的注册与分发。第三方插件用它把斜杠命令挂进所有平台共享的入站管道。

- **服务注册名**：`getService<CommandService>('commands')`；接口类型经声明合并注入服务类型表。
- **契约包**：`@aalis/plugin-commands-api`（纯类型 + `useCommandService` helper，无运行时实现）。
- **参考实现**：`@aalis/plugin-commands`，核心类是 `CommandRegistry`。
- **内核视角文档**：`docs/core/commands.md`。

> 绝大多数插件作者只需要写 provider 的消费者，也就是注册命令，不会自己实现 `CommandService`。注册一律走 `useCommandService(ctx)`，详见第 4 节。第 3 节的"写 provider"只为想替换整个指令引擎的高级作者准备。

---

## 1. 契约：CommandService 接口

`CommandService` 的关键方法如下。

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

Builder 链式追加 `alias / option / action / usage / example`，全部返回 `CommandBuilder` 自身。

重要类型：

- **命令名 = 完整点路径**（`'memory.clear.all'`）。点分段在注册时自动建立分组节点（无 handler，`isGroup: true`）。名字段必须匹配 `^[a-z][a-z0-9-]*$`。
- **inline DSL**：名字里可带位置参数 `<name:type>`（必填）或 `[name:type]`（可选），`type ∈ string|number|boolean|text`（对应类型 `PositionalArgType`）。`text` 会吞掉剩余的全部 token 拼成一句。
- **CommandHandler**：`(argv: CommandArgv, ...positionals: unknown[]) => Promise<string|undefined>|string|undefined`。位置参数按 DSL 顺序作为形参传入，不在 `argv` 里。返回字符串即回复内容，返回 `undefined` 则静默。
- **CommandArgv**：`argv.session.{sessionId, platform, userId?, sessionType?, raw}` 加上 `argv.options: Record<string, unknown>`。`sessionType ∈ 'group'|'private'|'channel'`，由适配器标注，私聊敏感指令据此设防。
- **CommandMeta**：注册时声明 `visibility`（轴 A 可见性 `public`/`restricted`）、`confirm`（轴 B 确认 `session`/`always`）、`risk`（声明糖 `safe`/`sensitive`/`dangerous`）、`usage`、`examples`。三者关系见第 5 节。
- **OptionSpec / OptionRegisterOptions**：`option(name, syntax, opts?)` 的 syntax 描述别名与取值占位符，详见第 4 节示例。
- **ExecutionInput**：`execute()` 的入参，含 `skipConfirm`——供 scheduler 等无人可点确认弹窗的受信源跳过交互确认。它不绕过授权，见第 5 节。

---

## 2. 谁提供 / 谁消费

**唯一参考实现**：`@aalis/plugin-commands`。

- 注册服务：`ctx.provide('commands', commands)`，其中 `commands = new CommandRegistry(ctx.logger)`。
- 声明 `provides = ['commands']`、`inject.required = ['gateway']`；同一份声明也写在 `package.json` 的 `aalis.service` 里（`provides: ['commands'] / required: ['gateway']`），两处双源同步。
- 入站分发发生在 `INBOUND_PHASE.COMMAND`（相位名 `'inbound:command'`，排在 flow / trigger / dispatch 之前）的中间件里，顺序是 `parseCommand` → `hasMatch` → `execute`。命中后不调用 `next()`，整个入站管道立即停止。
- 参考实现运行时依赖 `@aalis/plugin-authority-api`：`CommandRegistry` 从中 `import { riskDefaults }`，把 `risk` 声明展开为 `(visibility, confirm)` 默认值。这是真实的运行时依赖，写在 `plugin-commands` 的 `dependencies` 里，不是 devDependency。

**典型消费点**（都通过 `useCommandService(ctx)` 注册命令）：

- `@aalis/plugin-authority`：注册 `/authority`、`/level`、`/auto` 等，并通过 `whenService` 注入权限守卫。
- `@aalis/plugin-agent`：`/model`、`/model.info/.set/.reset`。
- `@aalis/plugin-doctor`：`/doctor`。
- `@aalis/plugin-tool-system`、`@aalis/plugin-user-profile`、`@aalis/plugin-user-relation`、`@aalis/plugin-maimai` 等。
- `commands` 几乎总是 optional 依赖，例如 `plugin-adapter-onebot`（`optional: ['…', 'commands', …]`）、`plugin-cli`、`plugin-doctor`。无指令系统时，这些插件的其它能力仍可用。

---

## 3. 写一个 provider（替换指令引擎，高级）

> 仅当你要替换整套指令引擎时才需要这节。注册命令请直接看第 4 节。

**最小必须实现**：`CommandService` 接口的全部方法。核心语义不能少：

- `command()` 返回的 builder 必须支持热转发与重放。`useCommandService` 内部用 `ctx.whenService` 在 provider 每次上线时重新创建 builder 并重放积压调用，所以你的 `command()` 必须能被多次调用，且对同名节点做幂等覆盖。
- `execute()` 在调用 handler 之前，必须先执行已注入的 `ExecutionGuard`（若存在）。守卫返回非 `null` 字符串即拦截，并把该串当作结果回给用户。这是安全契约的关键，不能跳过。
- `parseCommand` / `hasMatch` 要能区分两种情况：带前缀但无人注册（让入站管道放行到普通消息），以及已命中。

**可选项**：`prefix` 可配，默认 `/`，空串表示纯关键词触发。`setExecutionGuard` 若不实现，authority 注入时有 `if (svc.setExecutionGuard)` 兜底跳过，但那样所有命令都不会有权限闸，不推荐省略。

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
  // 自行在 INBOUND_PHASE.COMMAND 中间件里跑 parseCommand→hasMatch→execute
}
```

**双源同步**：除了 `export const provides / inject`，`package.json` 的 `aalis.service` 也要写，与参考实现一致：

```json
{ "aalis": { "service": { "provides": ["commands"], "required": ["gateway"] } } }
```

DI 按名取胜：同名 provider 的胜者 = preference > priority（`ServicePriority` 的 Backend 0 / Override 50 / System 200）> 注册顺序；不存在能力匹配选择（0.5.0 已移除）。详见 `docs/concepts/service-model.md`。

---

## 4. 标准消费方式：注册命令

用 `useCommandService(ctx)`。它会自动带上 `pluginName = ctx.id`，并在 `commands` provider 尚未上线时缓存调用、上线后重放。这就是懒注册，你不需要手动等待服务就绪。

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

option syntax 速查：

| syntax | 含义 |
| --- | --- |
| `'-v'` | boolean flag，别名 `v`。 |
| `'-p <page:number>'` | number 选项，别名 `p`，必带值。 |
| `'-p [page:number]'` | 值可选（flag 在但无值时给 `true`）。 |
| `'<page:number>'` | 仅长名 `--page`，必带值。 |
| `'-t <type:string[]>'` | `string[]`，可重复或逗号分隔累积（如 `/clear -t a -t b,c`）。 |
| `''`（空） | 纯 boolean flag。 |

**懒访问与缺失处理**：

- 注册侧不用判断 `commands` 是否存在。`useCommandService` 已用 `whenService` 处理懒上线与 provider bounce 重放。
- 若要调用 `getService<CommandService>('commands')`（例如自查 `getAll()`），遵守懒访问原则：每次用时现取，不要缓存，因为 provider bounce 会让旧引用失效。`useCommandService(ctx).raw` 等价于 `ctx.getService('commands')`，同样不要长期持有。见 `docs/concepts/lazy-service-access.md`。
- **错误边界**：handler 抛错会被 `execute` 捕获，转成 `指令执行失败: <msg>` 回给用户；选项或参数解析错误（数字非法、choices 越界、缺必填）返回可读错误串而非抛出。因此 handler 内不必兜住所有异常，但应对可预期的用户输入错误返回友好提示。

---

## 5. 能力 / 风险 → 影响（provider 与 consumer 必须遵守）

指令权限走两轴正交闸，与工具共用同一套 `ExecutionGuard`，详见 `docs/core/authority.md` 与 `docs/concepts/security-model.md`。

- **轴 A · 可见性 / 授权**：`visibility: 'public'`（默认）任何人可见可调；`'restricted'` 须 owner，或被委托授予。
- **轴 B · 确认**：`confirm: 'session'`（可本会话记住）或 `'always'`（每次必确认，owner 也不例外）。它与可见性正交。
- **risk 声明糖**（类型 `CapabilityRisk`）展开为默认值：`safe → (public, 无确认)`、`sensitive → (restricted, 无确认)`、`dangerous → (restricted, 'session')`。显式的 `visibility` / `confirm` 覆盖 risk 推导出的值。
- **沿点路径继承**：子命令未声明时，取最近声明的祖先分组的 `visibility / confirm / risk`，子节点可覆盖。所以把高危子命令归到一个 `restricted` 分组下，即可整组设防。例如内置 `/clear all` 显式声明 `visibility: 'restricted'`。
- **risk 透传供 minLevel 派生**：`execute` 把 `cmd.risk` 原样传给守卫，authority 据此派生最低等级（`riskToLevel`：safe → 0 / sensitive → 1 / dangerous → 2）；无 risk 时回退到 `visibility`（restricted → 2 / public → 0），对应 `ExecutionGuardContext`。

**consumer 责任**：诚实声明 `visibility / confirm / risk`。写删、改系统、shell 类命令应至少 `risk: 'dangerous'`，或显式 `visibility: 'restricted', confirm: 'session'`。`confirm: 'always'` 即便 owner 在会话内被提示注入，也能挡住静默提权。

**provider 责任**：`execute` 调 handler 前必须跑守卫，并尊重其返回，拦截即不执行。受信系统源（scheduler / workflow / system）经 `skipConfirm: true` 只跳过确认弹窗，授权仍照常评估，绝不绕过 `authorize`，以防提权。参考实现的入站中间件会根据 `message.source ∈ {scheduler, workflow, system}` 设置 `skipConfirm`。

**SSRF / 沙盒不归 commands 管**：命令系统本身不做网络出口或文件沙盒。handler 内对外抓取须走 `safeFetch`（来自 `@aalis/util-network-guard`，见 `docs/concepts/security-model.md`）；文件读写走 `storage` 的 `<root>:/path` 文法。注意 storage 不是沙盒，见 `docs/concepts/storage-uri-grammar.md`。

---

## 6. 边界与注意事项

1. **ExecutionGuard 是 fail-open（最关键）**：`execute` 只在 `if (this._guard)` 成立时才跑守卫。守卫由 `@aalis/plugin-authority` 通过 `setExecutionGuard` 注入。如果 `plugin-authority` 未加载，就没有任何守卫被注入，此时全部 `restricted` 命令对所有人无闸放行。这是部署侧的安全约束：依赖命令权限的部署，必须确保 authority 在线。consumer 不能假设守卫一定存在，但安全声明（`visibility / risk / confirm`）仍要照写，authority 一旦在线即生效。

2. **whenService 重放期间存在窗口**：authority 用 `whenService` 注入守卫，provider 上线与重启各会调一次。`plugin-commands` 与 `plugin-authority` 各自独立加载；若命令在守卫注入之前被执行，会按"无守卫"放行。正常启动顺序由 DI 依赖解析保证，但在 provider bounce（重载）的瞬间，理论上存在这个窗口。

3. **同名命令静默覆盖**：重复 `.command('foo')` 时后者覆盖前者，只打一条 `warn` 日志。别名冲突同理。第三方插件应给命令名加领域前缀（如 `myplugin.sync`），避免撞上内置的 `help / status / clear` 等。

4. **位置参数都是 `unknown`**：handler 形参类型是 `unknown`，框架按 DSL 的 type 解析（number 解析失败会返回错误串），但在 TS 层面你需要自行断言——`argv, city, day` 都是 `unknown`。可选位置参数缺省时传入 `undefined`。

5. **`text` 类型贪婪**：`text` 位置参数会吞掉光标之后的全部 token，因此必须放在位置参数列表的最后，否则其后的参数永远拿不到值。

6. **纯关键词模式（prefix=''）需命中首段**：`prefix` 设为空串时，只有输入的首词命中已注册命令的首段才认作命令，否则放行为普通消息，避免把每句聊天都当命令解析。

7. **命令命中即终止入站管道**：参考实现命中后不调 `next()`，flow / trigger / agent / 归档等下游相位全部不执行。但"带前缀却无人注册"（`hasMatch` 为 false）会放行到下游，而不是回显"未知指令"，以避免把错字噪音误判为命令。

---

## 7. 交叉链接

- 概念：`docs/concepts/service-model.md`（DI 按名取胜、优先级）、`docs/concepts/lazy-service-access.md`（每次现取、provider bounce）、`docs/concepts/manifest-metadata.md`（provides/inject 双源）、`docs/concepts/security-model.md`（两轴闸、safeFetch、确认）、`docs/concepts/message-llm-pipeline.md`（入站相位顺序）、`docs/concepts/storage-uri-grammar.md`。
- 内核文档：`docs/core/commands.md`（CommandRegistry 细节）、`docs/core/authority.md`、`docs/core/tools.md`（同源 `ExecutionGuard`）、`docs/core/service.md`、`docs/core/context.md`。
- 设计：见内核文档 `docs/core/commands.md`。
- 同源契约：`@aalis/plugin-authority-api`（`ExecutionGuard`、`CapabilityRisk/Visibility/Confirm`、`riskDefaults`）。
