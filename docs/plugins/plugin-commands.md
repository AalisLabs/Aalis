# plugin-commands — 指令系统

**包名**: `@aalis/plugin-commands`  
**源码**: `packages/plugin-commands/src/index.ts`

## 概述

内置指令注册与执行系统，支持指令前缀配置、递归子指令和声明式参数/选项解析。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-commands',
  provides: [commands],
  uses: {
    commands: optional(commands),
    gateway,
    storage: optional(storage),
    memory: optional(memory),
    authority: optional(authority),
    app: optional(appService),
    events,
    hooks,
    logger,
    config,
    provide,
    services,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `commandPrefix` | string | `'/'` | 指令前缀：指令触发前缀，设为空字符串可使用纯关键词触发 |

## 内置指令

| 指令 | 参数 | 说明 | 可见性 |
|---|---|---|---|
| `/help` | `[name]` | 无参时列出顶层指令（子指令只显示个数）；带指令名时显示用法详情，空格和点两种写法都可以，如 `/help clear all` | public |
| `/status` | — | 系统状态 | public |
| `/clear` | `[--type/-t <type>]` | 清空当前会话指定类型；默认全部类型 | public（需确认 confirm: session；群聊等共享会话要求等级 ≥ 2 或 owner，私聊不限） |
| `/clear list` | — | 列出可清理类型 | public |
| `/clear all` | `[--type/-t <type>]` | 【危险】清空全部会话中指定类型的内容；不指定类型时清空全部类型 | restricted（risk: dangerous，等级 2，需确认 confirm: session） |
| `/shutdown` | — | 关闭应用 | restricted |
| `/restart` | — | 重启应用 | restricted |

`/model` 由 plugin-agent 注册，`/tools` 由 plugin-tool-system 注册，`/authority`、`/level`、`/auto` 由 plugin-authority 注册，详见各自页面。

单条指令的等级与确认可在 plugin-authority 配置中按能力键 `command:<点路径>`（如 `command:clear.all`）覆盖，见 plugin-authority 文档。

权限守卫由 plugin-authority 注入。未安装 plugin-authority 时指令系统按 fail-closed 处理：等同所有人都是默认等级、没有确认通道，需要更高等级（restricted 或 risk 为 sensitive / dangerous）或声明了 confirm 的指令一律拒绝并提示缺少权限插件，其余指令照常执行。上表中除 `/help`、`/status` 外的指令因此都不可用（`/clear list` 沿点路径继承 `/clear` 的 confirm）。

## 选项解析形式

执行时按命中节点声明解析选项：

- `--name value`
- `--name=value`
- `--flag` / `--no-flag`（boolean 显式开/关）
- `-t value`（短名在 option 的 syntax 字符串中声明，如 `.option('type', '-t <type:string[]>')`）
- `string[]` 支持重复传入或逗号分隔，如 `-t vector -t image`、`--type context,vector`

参数支持单引号或双引号包裹，也可以用反斜杠转义，如 `"hello world"` 会作为一个参数；`--` 之后的内容全部按位置参数处理。

## `/clear` 类型

`/clear` 通过 `memory:clear` hook 让各插件参与清理。本插件自身负责 `context` 中的消息历史（经 memory 服务清空，含归档）和 `image` / `video` / `audio` / `file` 四类附件缓存（`data:/images` 等目录，按会话划分子目录），其余内容由对应插件的中间件处理。可用类型：

| 类型 | 内容 |
|---|---|
| `context` | 消息历史（含归档）与会话上下文：会话摘要、角色状态、已发现工具、待办；`/clear all` 时另清 OneBot 合并转发原文 |
| `summary` | 会话摘要 |
| `vector` | 向量记忆 |
| `image` | 图片缓存 |
| `video` | 视频缓存 |
| `audio` | 语音缓存 |
| `file` | 文件缓存 |
| `persona` | 会话角色状态 |
| `checkpoint` | 检查点（对话回滚存档） |
| `user-profile` | 用户档案与第三方行为指令，仅全局清理 |
| `user-relation` | 用户关系图谱，仅全局清理 |

不指定类型等于全部类型。`context` 只管会话级的短期上下文；向量、用户档案与关系图属于跨会话的长期记忆，不随 `context` 清理，只在指定对应类型或不指定类型时清理：会话级 `/clear` 只删除本会话的向量，档案与关系图只在 `/clear all` 时清理。OneBot 合并转发原文没有会话归属，会话级清理不动它，由适配器按 7 天期限回收。

任何类型都不清会话表（会话名称、父子关系与会话级配置，随删除会话清理），也不清第三方插件的绑定数据（如 plugin-maimai 的好友码绑定，用 `/maimai unbind` 解除）。各部分数据由归属插件自己清理，插件未安装或未激活时，它的数据不在清理范围内。

示例：

```text
/clear
/clear --type context,vector
/clear -t vector -t image
/clear all --type user-profile
```
