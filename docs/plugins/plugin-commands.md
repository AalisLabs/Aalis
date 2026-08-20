# plugin-commands — 指令系统

**包名**: `@aalis/plugin-commands`  
**源码**: `packages/plugin-commands/src/index.ts`

## 概述

内置指令注册与执行系统，支持指令前缀配置、递归子指令和声明式参数/选项解析。

## 插件声明

```typescript
meta.name = '@aalis/plugin-commands'
meta.provides = ['commands']
meta.inject = {}
```

## 内置指令

> 权限管理指令仅 owner 可达（防自授）；除下列指令外，WebUI「权限」页（owner-only）也可统一编辑用户等级、操作门槛/确认与 owner 列表，并以可折叠缩进行展示完整指令树、逐节点独立编辑。

| 指令 | 参数 | 说明 | 可见性 |
|---|---|---|---|
| `/help` | — | 显示帮助信息 | public |
| `/status` | — | 系统状态 | public |
| `/clear` | `[--type/-t <type>]` | 清空当前会话指定类型；默认全部类型 | public |
| `/clear list` | — | 列出可清理类型 | public |
| `/clear all` | `[--type/-t <type>]` | 【受限】清空全部会话指定类型；默认全部类型 | restricted |
| `/model` | `[keyword]` | 列出 / 搜索可用对话模型（分页，`-p` 翻页） | public |
| `/tools` | — | 列出所有 AI 工具 | public |
| `/shutdown` | — | 关闭应用 | restricted |
| `/restart` | — | 重启应用 | restricted |
| `/authority` | `[target]` | 查看自己或指定用户的权限等级（owner 显示等级 ∞） | restricted（sensitive，等级 1） |
| `/level` | `<platform:userId> <int>` | 【仅 owner】设置用户权限等级（越大越高，0=默认，负数=封禁） | restricted |
| `/auto` | `[<分钟>\|on\|off]` | 【仅 owner 本人】自动确认模式：临时免 dangerous 二次确认 | restricted |

## 门槛与确认覆盖（authority 配置）

owner 可通过 authority 配置逐条覆盖单条指令的两轴默认，无需改插件声明。键为完整能力键 `type:name`，指令即 `command:<点路径>`：

```yaml
# 操作最低等级覆盖（轴 A，整数；压过 risk/visibility 派生值）
authorityOverrides:
  'command:shutdown': 0     # 放开为所有人可用（等级 0 即默认所有人可达）
  'command:clear.all': 3    # 子指令收紧到需等级 ≥ 3（子指令用完整能力键，含 command: 前缀）

# 确认覆盖（轴 B；'session' / 'always' / 'off' 关闭确认）
confirmOverrides:
  'command:clear.all': always

# 全局硬禁用 glob：压过一切（含 owner），是配置总闸而非 per-user
deniedCapabilities:
  - 'tool:shell*'
```

轴 B 的确认回复机制：`Y`=仅本次放行，`YS`=本会话限时放行，其它任意输入=取消；`confirm: 'always'` 每次都必须确认（不接受会话记忆）；owner 可用 `/auto` 临时免 dangerous 二次确认。

## 选项解析形式

执行时按命中节点声明解析选项：

- `--name value`
- `--name=value`
- `--flag` / `--no-flag`（boolean 显式开/关）
- `-t value`（当 option 声明 `alias: 't'`）
- `string[]` 支持重复传入或逗号分隔，如 `-t vector -t image`、`--type context,summary`

参数支持引号包裹，如 `/echo "hello world"`。

## `/clear` 类型

`/clear` 通过 `memory:clear` hook 让各插件参与清理，命令插件只负责编排和基础缓存清理。可用类型：

| 类型 | 内容 |
|---|---|
| `context` | 消息历史与会话上下文 |
| `summary` | 会话摘要 |
| `vector` | 向量记忆 |
| `image` | 图片缓存 |
| `video` | 视频缓存 |
| `audio` | 语音缓存 |
| `file` | 文件缓存 |
| `persona` | 会话角色状态 |
| `checkpoint` | 检查点（对话回滚存档） |
| `user-profile` | 用户档案，仅全局清理 |
| `user-relation` | 用户关系图谱，仅全局清理 |

示例：

```text
/clear
/clear --type context,summary
/clear -t vector -t image
/clear all --type user-profile
```
