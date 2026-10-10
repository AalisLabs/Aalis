# api-commands — 斜杠指令系统契约

**包名**: `@aalis/api-commands`  
**源码**: `packages/api-commands/src/index.ts`  
**实现**: `@aalis/plugin-commands`

## 概述

定义斜杠指令系统：链式 builder、点路径子指令、描述符 `commands` 与绑定接口 `BoundCommands`。所有插件登记的指令汇聚到 `CommandService`，由 `plugin-commands` 解析并派发。

## 关键类型

指令层级用 **name 的点路径**表达（`'memory.clear.all'`），位置参数写在 inline DSL 里：`'memory.set <key:string> [value:text]'`。handler 形参是 `(argv, ...positionals)`，不是对象式 `CommandDefinition`。

```ts
interface CommandArgv {
  session: { sessionId: string; platform: string; userId?: string; sessionType?: string; raw: string };
  options: Record<string, unknown>;
}

type CommandHandler = (argv: CommandArgv, ...positionals: unknown[]) => Promise<string | undefined> | string | undefined;

interface CommandBuilder {
  alias(name: string): CommandBuilder;
  option(name: string, syntax: string, options?: OptionRegisterOptions): CommandBuilder;
  argument(name: string, description: string): CommandBuilder;
  action(handler: CommandHandler): CommandBuilder;
  usage(text: string): CommandBuilder;
  example(line: string): CommandBuilder;
}

interface OptionRegisterOptions {
  description?: string;
  default?: unknown;
  required?: boolean;
  choices?: readonly (string | OptionChoice)[];
}

interface OptionChoice {
  value: string;
  description?: string;
}

interface CommandMeta {
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
  usage?: string;
  examples?: string[];
}
```

### 描述、参数与取值

- **描述的第一句是摘要**：`/help` 概览与子指令列表只显示描述的第一句（到第一个句号、分号、问号、叹号或换行为止），超过 24 字截断加省略号；详情里显示完整描述。所以第一句写成一句短话，细节写在后面，如 `'清空当前会话记忆；用 --type 选择清理类型'`。不另设摘要字段。
- **位置参数的说明**：`argument(name, description)` 给 DSL 里声明的位置参数加说明，名字不在 DSL 里时抛错。帮助里位置参数写成 `<名字>`（必填）与 `[名字]`（可选），带说明的另列在「参数」下。
- **带说明的取值**：`choices` 的每一项可以只写值，也可以写成 `{ value, description }`，帮助里逐项列在选项下面。`string` 选项只收其中之一，取值不在里面时回「只能是」；`string[]` 选项不按它校验，由指令自己核（如 `/clear --type` 认别名）。
- **`-h` 与 `--help` 是保留选项**：任何指令后面写 `-h` 或 `--help`（`--` 之前），回的就是 `/help <指令>`，别的参数一概不管、不执行；声明名为 `help`、`h` 或别名为 `-h`、`--help` 的选项时登记抛错。

### 子指令

```
/clear all          → 点路径 clear.all
/clear              → 命中 clear 根节点的 action（若有）
/db migrate up      → db.migrate.up
```

父指令有子指令、自身不声明位置参数时，匹配不到子指令的多余词（写错的子指令名，或写多了的选项值）不会被忽略：回「未知子指令或多余参数」并指向 `/help <指令>`，不执行父指令，也不进入权限确认。父指令要接收自由文本，就声明位置参数，如 `'note [tail:text]'`。子指令按最长前缀匹配，先于位置参数：自由文本的第一个词恰好与某个子指令同名时，整条输入路由到该子指令，不进父指令，只给这个词加引号也一样；把整段自由文本括进一对引号，就作为一个参数交给父指令（整段恰好是子指令名时除外）。

可见性沿树继承（restricted 父分组 → restricted 子节点，除非子节点重新声明），可在 authority 配置的 `authorityOverrides` 里按能力键单独改写最低等级（key 形如 `command:clear.all`，值为整数等级）。

帮助怎么按调用者过滤、怎么排版，见 [plugin-commands 的「帮助」](../plugins/plugin-commands.md#帮助)。

## 绑定门面

```ts
interface BoundCommands extends CommandService {
  command(name: string, description?: string, meta?: CommandMeta): CommandBuilder;
}
```

`commands.use.command(...)` 把 `pluginName` 填成本次激活 id，登记记在资源口的 `registrar` 上，按点路径名（去掉 inline 位置参数）为键：

- 提供者在场时 builder 的 `alias` / `option` / `action` 等调用同步转发；缺席时记下，上线后按序重放。
- 提供者换人时整体重挂到新提供者；本次激活关闭时与原语同一拍撤回，不等它所提供服务的下游交接。
- 同一激活再登记同名指令，替换先前那次（只留一层）；不同激活的同名指令照旧各占一层，后来者生效。
- 提供者在场时它拒收的登记（如指令名不合法）原样抛给调用方；缺席时登记照收，上线时再登记失败只记 warn（重放到一半压上的那一层随之撤掉）、留待下次换人重试。
- 撤回时调 `unregister(registryKey, pluginName)`，只摘自己那一层声明。不要自己调不带 `contextId` 的 `unregister`——那会摘掉同名指令的全部层。

## 服务接口（节选）

```ts
interface CommandService {
  prefix: string;
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;
  unregister(name: string, contextId?: string): void;
  execute(name: string, ctx: ExecutionInput): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  hasMatch(head: string, tokens?: string[]): boolean;
  has(name: string): boolean;
  get(name: string): Command | undefined;
  getAll(): Command[];
  setExecutionGuard(guard: ExecutionGuard | undefined): void;
}
```

`setExecutionGuard` 注入执行守卫；传 `undefined` 摘掉，需要更高等级或确认的指令退回 fail-closed。plugin-authority 激活时注入、停用时摘掉。

`unregister` 的 `contextId`：**插件自己的清理必须传它**（绑定门面的退订已代传）；缺省会摘掉全部层（管理面用）。注销键是点路径（inline DSL 在注册时被切掉），传 `'memory.clear <key:string>'` 会键不匹配、静默 no-op。

## 典型用法

```ts
import { commands } from '@aalis/api-commands';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-commands',
  uses: { commands: optional(commands) },
  apply({ commands }) {
    commands.use
      .command('persona [persona:string]', '查看或切换人格', { visibility: 'restricted' })
      .argument('persona', '要切换到的人格；不写时查看当前人格')
      .action(async (argv, persona) => {
        if (typeof persona !== 'string' || persona.length === 0) return '当前人格：…';
        return `已切换到 ${persona}`;
      });
  },
});
```

## 实现者

- [@aalis/plugin-commands](../plugins/plugin-commands.md)

## 相关

- `ExecutionGuard` 见 [api-authority](./api-authority.md)
- `ExecutionInput.skipConfirm` 用于没人可问的受信来源（scheduler 触发的指令、runtime 一次性子命令）免 `session` 档的确认；authorize 仍生效
- `ExecutionInput.confirmIntent` 由能当面问到发出者的调用方（plugin-commands 的入站相位）提供，原样交给执行守卫做意图确认
