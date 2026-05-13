# CommandRegistry — 指令系统

管理指令的注册、解析、权限检查和执行。

**类型源码**: `packages/core/src/types/core.ts`, `packages/core/src/types/commands.ts`  
**默认实现**: `packages/plugin-commands/src/commands.ts`

## 指令定义

```typescript
interface CommandDefinition {
  name: string;              // 指令名
  description: string;       // 描述
  action: (ctx: CommandContext) => Promise<string | void>;
  authority?: number;        // 最低权限等级（默认 1）
  safety?: SafetyLevel;      // 'safe' | 'dangerous'
  arguments?: CommandArgumentDefinition[];
  options?: CommandOptionDefinition[];
  usage?: string;
  examples?: string[];
}
```

参数声明是指令自己的元数据，不改变核心的职责边界；解析器只负责把用户输入转成结构化 `ctx.operands` / `ctx.options`，具体业务仍由插件 action 实现。

```typescript
interface CommandArgumentDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'text';
  required?: boolean;
  variadic?: boolean;
  description?: string;
}

interface CommandOptionDefinition {
  name: string;                 // --name
  alias?: string | string[];    // -n 或额外长别名
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]';
  choices?: string[];
  default?: unknown;
  required?: boolean;
  description?: string;
}
```

## 指令上下文

```typescript
interface CommandContext {
  sessionId: string;
  platform: string;
  userId?: string;
  args: string[];            // 去掉已解析选项后的剩余位置参数
  operands?: Record<string, unknown>; // 按 arguments 声明解析出的参数
  options?: Record<string, unknown>;  // 按 options 声明解析出的选项
  raw: string;               // 原始输入文本
  skipSafetyCheck?: boolean; // 工具桥接时跳过重复确认
}
```

## 指令解析

`parseCommand(input)` 根据配置的前缀模式解析用户输入：

- **有前缀模式** (`prefix = '/'`): 匹配 `/指令名 参数...`
- **无前缀模式** (`prefix = ''`): 匹配 `指令名 参数...`（精确匹配指令名）
- 支持引号包裹的参数，如 `/echo "hello world"`

执行时会按命中节点的声明解析选项：

- `--name value`
- `--name=value`
- `--flag` / `--no-flag`（boolean）
- `-t value`（当 option 声明 `alias: 't'`）
- `string[]` 支持重复传入或逗号分隔，如 `-t vector -t image`、`--type context,summary`

## 指令执行流程

```
parseCommand(input)
  │
  ▼
execute(name, cmdCtx)
  │
  ├─ 查找指令（含覆盖的权限/安全等级）
  ├─ 权限检查: authority.getAuthority() ≥ 指令要求
  ├─ 如果 safety='dangerous':
  │     authority.confirmDangerous() → 交互式确认
  └─ 调用 action(cmdCtx) → 返回结果
```

## 覆盖系统

支持通过配置覆盖指令的权限等级和安全等级：

```yaml
commandOverrides:
  shutdown:
    authority: 3         # 降低关闭指令的权限要求
    safety: safe         # 改为安全操作（不需确认）
  # 子指令使用冒号拼接路径作为键（可递归多层）
  clear:all:
    authority: 4
```

```typescript
commands.setOverride('shutdown', { authority: 3, safety: 'safe' });
commands.setOverride('clear:all', { authority: 4 });
commands.removeOverride('shutdown');
commands.getOverrides();
```

## 子指令（递归）

指令可在 `subcommands` 中声明子指令，子指令本身可再含 `subcommands` 形成任意层级：

```typescript
import { useCommandService } from '@aalis/plugin-commands-api';

const commands = useCommandService(ctx);
commands.command({
  name: 'clear',
  description: '清空当前会话',
  options: [
    { name: 'type', alias: 't', type: 'string[]', description: '清理类型' },
  ],
  subcommands: [
    { name: 'list', description: '列出可清理类型', action: async () => listClearTypes() },
    { name: 'all', description: '【危险】全局清空',
      authority: 3, safety: 'dangerous',
      options: [{ name: 'type', alias: 't', type: 'string[]' }],
      action: async (c) => runClear(c, 'all') },
  ],
  action: async (c) => runClear(c, 'session'),
});
```

解析与路由：
- 分析用户输入后，根据 `args` 逐层匹配子指令名，命中则下沉一层并消耗一个 arg
- 任一层未命中则停在当前节点，调用其 `action`（`args` 为去掉已解析选项后的剩余位置参数）
- 节点未提供 `action` 时会返回自动生成的 usage

权限/安全级继承：
- 每个节点未声明 `authority`/`safety` 时继承父节点的有效值（已应用 override）
- 与根一致，每个节点也可被单独 override，键 = 冒号拼接的路径（如 `clear:all`、`db:migrate:up`）
- WebUI「权限」页以可折叠的缩进行展示完整指令树，每一节点可独立编辑

## 基础指令参考

| 指令 | 参数 | 说明 | 权限 | 安全等级 |
|---|---|---|---|---|
| `/help` | — | 显示帮助信息 | 0 | safe |
| `/status` | — | 系统状态 | 0 | safe |
| `/clear` | `[--type/-t <type>]` | 清空当前会话指定类型；默认全部类型 | 0 | safe |
| `/clear list` | — | 列出可清理类型 | 0 | safe |
| `/clear all` | `[--type/-t <type>]` | 【危险】清空全部会话指定类型；默认全部类型 | 3 | dangerous |
| `/model` | `[model_name]` | 查看或切换会话模型 | 0 | safe |
| `/tools` | — | 列出所有 AI 工具 | 0 | safe |
| `/shutdown` | — | 关闭应用 | 5 | dangerous |
| `/restart` | — | 重启应用 | 5 | dangerous |
| `/grant` | `<platform:userId> <level>` | 设置用户权限 | 2 | safe |
| `/authority` | `[platform:userId]` | 查看权限等级 | 0 | safe |
