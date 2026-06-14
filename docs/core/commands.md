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
  visibility?: CapabilityVisibility;  // 'public' | 'restricted'（默认 public）
  permissions?: CapabilityId[];       // 额外触达的资源能力（如 storage:path:...:write）
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
  skipConfirm?: boolean;     // 受信系统源（scheduler）跳过受限确认弹窗；authorize 仍生效
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
  ├─ 查找指令（含继承/覆盖后的有效可见性 + 资源能力）
  ├─ 执行守卫: authority.authorize() —— 逐能力裁决 deny > owner > public > granted
  ├─ 若命中未授予的 restricted 能力且非 skipConfirm:
  │     authority.requestAccess() → 临时委托（白名单 / 会话授予 / 确认回调）
  └─ 调用 action(cmdCtx) → 返回结果
```

## 可见性覆盖

owner 可通过配置覆盖单条操作的默认可见性，无需改插件声明：

```yaml
visibilityOverrides:
  shutdown: public        # 把关闭指令放开为所有人可用
  clear.all: restricted   # 把子指令收紧为需授予（子指令用点路径作为键）
```

此外 `restrictedCapabilities`（额外 restricted 能力 glob）与 `deniedCapabilities`（全局硬禁用 glob）也在 authority 配置里调整。

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
    { name: 'all', description: '【受限】全局清空',
      visibility: 'restricted',
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

可见性继承：
- 每个节点未声明 `visibility` 时沿点路径继承最近声明的祖先值（restricted 父分组 → restricted 子节点，除非子节点重新声明）；缺省 public
- 每个节点也可被单独覆盖，键 = 点拼接的路径（如 `clear.all`、`db.migrate.up`），在 `visibilityOverrides` 配置
- WebUI「权限」页以可折叠的缩进行展示完整指令树，每一节点可独立编辑

## 基础指令参考

| 指令 | 参数 | 说明 | 可见性 |
|---|---|---|---|
| `/help` | — | 显示帮助信息 | public |
| `/status` | — | 系统状态 | public |
| `/clear` | `[--type/-t <type>]` | 清空当前会话指定类型；默认全部类型 | public |
| `/clear list` | — | 列出可清理类型 | public |
| `/clear all` | `[--type/-t <type>]` | 【受限】清空全部会话指定类型；默认全部类型 | restricted |
| `/model` | `[model_name]` | 查看或切换会话模型 | public |
| `/tools` | — | 列出所有 AI 工具 | public |
| `/shutdown` | — | 关闭应用 | restricted |
| `/restart` | — | 重启应用 | restricted |
| `/grant` | `<target> <capability>` | 给用户授予一个能力（受子集约束） | restricted |
| `/deny` | `<target> <capability>` | 禁用用户一个能力 | restricted |
| `/authority` | `[target]` | 查看自己或指定用户的能力授予 | public |
| `/bind` | `<code>` | 将当前平台账号绑定到 WebUI 账户 | public |
