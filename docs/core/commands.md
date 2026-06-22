# CommandRegistry — 指令系统

管理指令的注册、解析、权限检查和执行。

**契约源码**: `packages/plugin-commands-api/src/index.ts`  
**默认实现**: `packages/plugin-commands/src/commands.ts`

## 指令定义

指令经 builder 注册：名字是**完整点路径**（点分段自动建立分组节点），位置参数用 inline DSL（`<必填>` / `[可选]`）声明在名字里，选项与 action 链式追加。

```typescript
import { useCommandService } from '@aalis/plugin-commands-api';

useCommandService(ctx)
  .command('memory.set <key:string> [value:text]', '写入一条记忆', {
    visibility: 'restricted',   // 轴 A：'public' | 'restricted'（默认 public）
    confirm: 'session',         // 轴 B：'session' | 'always'（缺省=不确认）
    risk: 'dangerous',          // 声明糖：展开为 (visibility, confirm) 默认
  })
  .option('ttl', '<seconds:number>', { description: '过期秒数', default: 0 })
  .example('/memory.set name 阿离')
  .action(async (argv, key, value) => writeMemory(key, value, argv.options.ttl));
```

注册元数据 `CommandMeta`：

```typescript
interface CommandMeta {
  visibility?: 'public' | 'restricted'; // 轴 A 默认可见性（缺省 public）
  confirm?: 'session' | 'always';       // 轴 B 确认要求（缺省=不确认）
  risk?: 'safe' | 'sensitive' | 'dangerous'; // 声明糖：展开为 (visibility, confirm) 默认
  usage?: string;
  examples?: string[];
}
```

参数声明是指令自己的元数据，不改变核心的职责边界；解析器只负责把用户输入转成结构化的位置参数 + `argv.options`，具体业务仍由插件 action 实现。inline DSL 与 option 的类型：

```text
位置参数: <name:type> 必填 / [name:type] 可选     type: string | number | boolean | text
选项:     .option('name', '<val:type>' | '[val:type]' | '', opts)
          type: string | number | boolean | string[]；boolean 为纯 flag
          opts: { description?, default?, required?, choices? }；别名经名字 DSL 或 .alias() 追加
```

## 指令上下文

消费方（适配器 / CLI）调用 `execute(name, input)` 传入 `ExecutionInput`：

```typescript
interface ExecutionInput {
  sessionId: string;
  platform: string;
  userId?: string;
  sessionType?: 'group' | 'private' | 'channel'; // 会话信道类型（透传自 IncomingMessage.sessionType）
  args: string[];            // 命中节点后剩余的原始参数 token
  raw: string;               // 原始输入文本（含前缀）
  skipConfirm?: boolean;     // 受信系统源（scheduler 等）跳过确认弹窗；authorize 仍生效，不绕过提权
}
```

解析与守卫通过后，action（builder 的 `.action(handler)`）收到的是 `CommandArgv` + 按 inline DSL 顺序解析出的位置参数：

```typescript
type CommandHandler = (argv: CommandArgv, ...positionals: unknown[]) => Promise<string | undefined> | string | undefined;

interface CommandArgv {
  session: {
    sessionId: string;
    platform: string;
    userId?: string;
    sessionType?: 'group' | 'private' | 'channel';
    raw: string;
  };
  options: Record<string, unknown>; // 按 options 声明解析出的选项
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

守卫由 plugin-authority 注入（`setExecutionGuard`），两轴正交：

```
parseCommand(input)
  │
  ▼
execute(name, input)
  │
  ├─ 查找指令（含继承/覆盖后的有效可见性 / confirm / risk）
  ├─ 轴 A · 授权 authority.authorize() —— 数字等级裁决：
  │     deniedCapabilities 硬禁 > owner(∞) > 触发者等级 >= 操作 minLevel
  │     （minLevel = authorityOverrides[cap] > risk 派生 > visibility 兜底）
  ├─ 轴 B · 确认（与授权正交，owner 也吃，防注入借权）：
  │     操作声明了 confirm 且非 skipConfirm / 非 auto 放行 →
  │     authority.requestAccess() → session-confirm 协调器发起 HITL 意图确认
  └─ 调用 action(argv, ...positionals) → 返回结果
```

- 轴 A 决定**谁能跑**：每个外部身份一个整数等级（默认 0，封禁=负数），owner=∞（靠 owners 列表归属，永不被门槛锁出）；操作最低等级由 `risk`（safe→0 / sensitive→1 / dangerous→2）派生，owner 可经 `authorityOverrides` 逐条覆盖成任意整数，`visibility` 仅在无 risk 时兜底（public→0 / restricted→2）。
- 轴 B 决定**是否需当面确认意图**：由独立的 plugin-session-confirm 执行（经 `setConfirmHandler` 注册）。回复 `Y`=仅本次放行，`YS`=本会话限时放行，其它任意输入=取消；`confirm: 'always'` 每次都必须确认（不接受会话记忆）。owner 可用 `/auto` 临时免 dangerous 二次确认。
- `risk: 'dangerous'` 是声明糖，同时把默认设成 restricted + `confirm: 'session'`。

## 门槛与确认覆盖

owner 可通过 authority 配置逐条覆盖单条操作的两轴默认，无需改插件声明（键 = 点拼接的能力路径）：

```yaml
# 操作最低等级覆盖（轴 A，整数；压过 risk/visibility 派生值）
authorityOverrides:
  shutdown: 0       # 把关闭指令放开为所有人可用（等级 0 即默认人人可达）
  clear.all: 3      # 把子指令收紧到需等级 ≥ 3（子指令用点路径作为键）

# 确认覆盖（轴 B；'session' / 'always' / 'off' 关闭确认）
confirmOverrides:
  clear.all: always

# 全局硬禁用 glob：压过一切（含 owner），是配置总闸而非 per-user
deniedCapabilities:
  - 'tool:shell*'
```

## 子指令（递归）

子指令不是嵌套数组，而是用**点路径名**直接注册：点分段会自动建立缺失的祖先分组节点，从而形成任意层级：

```typescript
import { useCommandService } from '@aalis/plugin-commands-api';

const commands = useCommandService(ctx);

commands
  .command('clear', '清空当前会话')
  .option('type', '<type:string[]>', { description: '清理类型' })
  .action(c => runClear(c, 'session'));

commands.command('clear.list', '列出可清理类型').action(() => listClearTypes());

commands
  .command('clear.all', '【受限】全局清空', { visibility: 'restricted' })
  .option('type', '<type:string[]>')
  .action(c => runClear(c, 'all'));
```

解析与路由：
- 分析用户输入后，根据 `args` 逐层匹配子指令名，命中则下沉一层并消耗一个 arg
- 任一层未命中则停在当前节点，调用其 action（剩余位置参数按命中节点的 inline DSL 解析后作为 `...positionals` 传入）
- 节点未提供 action（仅为自动建立的分组节点）时会返回自动生成的 usage

可见性 / 确认继承：
- 每个节点未声明 `visibility` / `confirm` / `risk` 时沿点路径继承最近声明的祖先值（restricted 父分组 → restricted 子节点，除非子节点重新声明）；缺省 public、不确认
- 每个节点的两轴默认都可被单独覆盖，键 = 点拼接的路径（如 `clear.all`、`db.migrate.up`），在 authority 的 `authorityOverrides` / `confirmOverrides` 配置
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
| `/authority` | `[target]` | 查看自己或指定用户的权限等级（owner 显示等级 ∞） | public |
| `/level` | `<platform:userId> <int>` | 【仅 owner】设置用户权限等级（越大越高，0=默认，负数=封禁） | restricted |
| `/auto` | `[<分钟>\|on\|off]` | 【仅 owner 本人】自动确认模式：临时免 dangerous 二次确认 | restricted |

> 权限管理仅 owner 可达（防自授）：除以上指令外，WebUI「权限」页（owner-only）也可统一编辑用户等级、操作门槛/确认与 owner 列表。
