# plugin-commands-api — 斜杠指令系统契约

**包名**: `@aalis/plugin-commands-api`  
**源码**: `packages/plugin-commands-api/src/index.ts`  
**实现**: `@aalis/plugin-commands`

## 概述

定义斜杠指令系统：指令定义、子指令递归结构、领域 helper `useCommandService(ctx)`、CommandService 接口。所有插件注册的指令最终汇聚到 `CommandService`，由 `plugin-commands` 解析并派发。

## 关键类型

```ts
interface CommandDefinition {
  name: string;                          // 不含前缀 "/"
  description: string;
  visibility?: CapabilityVisibility;     // 'public' | 'restricted'（默认 public）
  permissions?: CapabilityId[];          // 额外触达的资源能力（如 storage:path:...:write）
  // CapabilityVisibility / CapabilityId 从 @aalis/plugin-authority-api 导入
  arguments?: CommandArgumentDefinition[];
  options?: CommandOptionDefinition[];
  subcommands?: SubcommandDefinition[];  // 子指令递归
  usage?: string;
  examples?: string[];
  action: (ctx: CommandContext) => Promise<string | undefined>;
}
```

### 子指令递归

```
/clear all          → 命中 subcommand "all"
/clear              → 命中 root action（args=[]）
/db migrate up      → 三层匹配，命中最深 action
```

每一层未命中 → 调用当前层级的 `action`，若该层无 `action` 则返回 usage 提示。可见性沿树继承（restricted 父分组 → restricted 子节点，除非子节点重新声明），可在 authority 配置的 `visibilityOverrides[path-key]` 单独覆盖（key 形如 `clear.all`）。

## 领域 Helper

```ts
const commands = useCommandService(ctx);
commands.command(definition: CommandDefinition): () => void;
```

helper 内部使用 `ctx.getService('commands')`；服务未 provide 时 `command()` 调用会被 `whenService` 自动延迟到服务就绪。

## 服务接口（节选）

```ts
interface CommandService {
  prefix: string;                                           // 通常是 "/"
  register(cmd: CommandDefinition, pluginName: string): () => void;
  parse(text: string): { name: string; args: string[] } | null;
  execute(name: string, args: string[], ctx: CommandContext): Promise<string | undefined>;
  list(): CommandNodeInfo[];                                 // 扁平树视图，供 WebUI
  setExecutionGuard(guard: ExecutionGuard): void;
}
```

## 典型用法

```ts
const commands = useCommandService(ctx);
commands.command({
  name: 'persona',
  description: '查看/切换人格',
  visibility: 'restricted',
  arguments: [{ name: 'persona', type: 'string', required: false }],
  subcommands: [
    {
      name: 'list',
      description: '列出可选人格',
      action: async () => listPersonas().join('\n'),
    },
  ],
  action: async (ctx) => {
    if (!ctx.args.length) return getCurrentPersona();
    return await setPersona(ctx.args[0]);
  },
});
```

## 实现者

- [@aalis/plugin-commands](../plugins/plugin-commands.md)

## 相关

- `ExecutionGuard` 见 [plugin-authority-api](./plugin-authority-api.md)
- `ExecutionInput.skipConfirm` 用于受信系统源（scheduler 等）跳过受限确认弹窗；authorize 仍生效
