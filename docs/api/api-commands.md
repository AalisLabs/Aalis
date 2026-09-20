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
  session: { sessionId: string; platform: string; userId?: string; sessionType?: 'group' | 'private' | 'channel'; raw: string };
  options: Record<string, unknown>;
}

type CommandHandler = (argv: CommandArgv, ...positionals: unknown[]) => Promise<string | undefined> | string | undefined;

interface CommandBuilder {
  alias(name: string): CommandBuilder;
  option(name: string, syntax: string, options?: OptionRegisterOptions): CommandBuilder;
  action(handler: CommandHandler): CommandBuilder;
  usage(text: string): CommandBuilder;
  example(line: string): CommandBuilder;
}

interface CommandMeta {
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
  usage?: string;
  examples?: string[];
}
```

### 子指令

```
/clear all          → 点路径 clear.all
/clear              → 命中 clear 根节点的 action（若有）
/db migrate up      → db.migrate.up
```

可见性沿树继承（restricted 父分组 → restricted 子节点，除非子节点重新声明），可在 authority 配置的 `authorityOverrides` 里按能力键单独改写最低等级（key 形如 `command:clear.all`，值为整数等级）。

## 绑定门面

```ts
interface BoundCommands extends ServiceRef<CommandService> {
  command(name: string, description?: string, meta?: CommandMeta): CommandBuilder;
}
```

`commands.command(...)` 把 `pluginName` 填成本次激活 id。builder 同时支持热转发与提供者换人重放：`follow` 在场即重放 `alias` / `option` / `action` 等调用；撤回时 `unregister(registryKey, pluginName)` 只摘自己那一层声明。不要自己调不带 `contextId` 的 `unregister`——那会摘掉同名指令的全部层。

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
  setExecutionGuard(guard: ExecutionGuard): void;
}
```

`unregister` 的 `contextId`：**插件自己的清理必须传它**（绑定门面的退订已代传）；缺省会摘掉全部层（管理面用）。注销键是点路径（inline DSL 在注册时被切掉），传 `'memory.clear <key:string>'` 会键不匹配、静默 no-op。

## 典型用法

```ts
import { commands } from '@aalis/api-commands';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-commands',
  uses: { commands: optional(commands) },
  apply({ commands }) {
    commands
      .command('persona [persona:string]', '查看/切换人格', { visibility: 'restricted' })
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
- `ExecutionInput.skipConfirm` 用于受信系统源（scheduler 等）跳过受限确认弹窗；authorize 仍生效
