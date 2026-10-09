# plugin-skills — AI 技能库系统

**包名**: `@aalis/plugin-skills`  
**源码**: `packages/plugin-skills/src/index.ts`

## 概述

Agent Skills 技能系统，兼容 Anthropic Agent Skills 标准。每个技能是一个文件夹，含必需的 `SKILL.md`（YAML frontmatter 加 Markdown 正文）与可选的 `scripts/`、`references/`、`assets/` 目录。技能按渐进披露分三阶段进入上下文：Discovery、Activation、Execution。角色卡可声明 `skills: [...]` 作为技能白名单，按会话取：卡取调用所在会话的生效设置里的人设（会话管理按层解析，与 agent 同一取法），没有会话管理或没有会话时取主卡。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-skills',
  provides: [skills],
  apply(caps) { /* 见源码 */ },
  uses: {
    tools: optional(tools),
    webui: optional(webuiServer),
    storage: optional(storage),
    persona: optional(persona),
    sessionManager: optional(sessionManager),
    contributions,
    hooks,
    events,
    logger,
    config,
    provide,
  },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `skillsUri` | string | `'skills:/'` | 技能存储 URI：技能文件夹 storage URI（默认 `skills:/`，即家目录的 `self/skills`）。每个 skill 为一个子目录，含 SKILL.md。 |
| `maxSkillBytes` | number | `200000` | 单 skill 最大字节数：SKILL.md 单文件最大字节数，避免一次加载过大内容污染上下文。 |
| `maxSkills` | number | `200` | 技能数量上限：扫描时最多加载的 skill 数量。 |
| `discoveryEnabled` | boolean | `true` | 启用 Discovery 注入：往 system prompt 注入一行技能库路标，提示 agent 用 list_skills 检索、load_skill 加载技能；关闭时激活正文注入也一并停用。 |
| `triggersEnabled` | boolean | `true` | 启用 triggers 自动激活：匹配 SKILL.md frontmatter 中的 triggers regex 时自动加载该 skill。 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `list_skills` | 列出可用技能（受这个会话的角色卡白名单过滤），可按关键词模糊匹配 name/description，支持 offset 翻页 |
| `load_skill` | 激活指定技能（不在这个会话的角色卡白名单里的拒绝）：从下一次模型调用起，向该会话注入其 SKILL.md 正文（不含 frontmatter）与附属资源清单（需 `discoveryEnabled` 开启）；无会话上下文时直接在工具结果中返回正文与资源清单 |
| `skill_create` | 创建技能（在 `skillsUri` 下生成 `<name>/SKILL.md`，目录名经字符清洗；可一次性写入附属文件） |
| `skill_update` | 更新已有技能的 description / body / triggers / license / frontmatter / files。`frontmatter` 里传的 `name` 会被忽略：技能名在创建时钉死（技能目录名就是由它清洗而来），改名请重建技能 |
| `skill_delete` | 删除技能（连同整个文件夹） |
| `skill_add_file` | 为指定技能写入一个附属文件，同名覆盖 |
| `skill_remove_file` | 删除技能下的一个附属文件（不能是 SKILL.md） |
| `skill_list_files` | 列出技能目录下所有附属文件的相对路径 |
| `skill_read_file` | 读取技能下某附属文件的文本内容 |
| `skill_rescan` | 重新扫描技能目录 |

## 工作方式

1. Discovery：`discoveryEnabled` 开启时，通过 `agent:prompt` 贡献点向 system prompt 注入一行静态路标，提示 agent 用 `list_skills` 检索、`load_skill` 加载；不注入技能清单本身。这个会话的角色卡一个技能都不允许时不注入
2. Activation：调用 `load_skill(name)`，或在 `triggersEnabled` 开启时由 `agent:input:before` 中间件以 frontmatter `triggers` 正则匹配用户消息自动激活（只在这个会话的角色卡白名单里找）
3. Execution：`discoveryEnabled` 开启时，已激活技能的 SKILL.md 正文与附属资源清单经 `agent:prompt` 贡献注入该会话后续的模型调用，agent 按指令使用 scripts/references；关闭时不注入激活正文

## 技能的设置页

WebUI 设置里的「技能」一节（`key: 'skills'`，位置 `settings`）：一张技能表（名称、描述、自动触发、附属文件数），选中一个在详情里看它的属性（名称、描述、自动触发、许可证、位置与附属文件，空的不列）与 SKILL.md 正文。行动作「删除」（确认框）删掉整个技能目录；技能不存在或目录删不掉时回错误，原因显示给 owner。经工具或服务增删改技能、重扫目录后页面重取；手改技能目录靠打开时取一次与手动刷新。

## 配置校验

`skillsUri` 必须是 storage URI；显式无效类型或非法 URI 在扫描与工具注册前报配置错误。数字字符串上限按数值解析，其余错误类型回落默认值并告警。
