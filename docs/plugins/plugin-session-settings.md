# plugin-session-settings — 会话设置

**包名**: `@aalis/plugin-session-settings`  
**源码**: `packages/plugin-session-settings/src/`  
**契约**: [@aalis/api-session-settings](../api/api-session-settings.md)

## 概述

插件配置字段（configSchema 顶层写了 `session` 的）按平台档、平台类型档、场所与本会话覆盖：本插件存放与修改各层的值、管写入校验、给建子会话写下的那一层，登记 `/session`、`/session.set`、`/session.reset` 三条指令。解析在各插件进程内由读取器做（契约包的 `resolveFields`），本插件只交出各层的原样值。

本插件需要另装：`npm create aalis` 的最小档装上它，已有部署不会自动装上。没装、没启用或会话管理没起来时：`/session` 系列指令、WebUI 的「会话默认」、会话面板的「设置」标签、输入框旁的快捷切换与房间页的「场所设置」都不出现，建不了子任务与子会话；插件详情里这些字段照常能改，各插件只用插件配置里的值（平台档、平台类型档、场所与会话层这段时间不生效）。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-session-settings',
  provides: [sessionSettings],
  uses: {
    sessionManager,                     // 场所与本会话层存在会话管理的记录上；缺席时停在 pending
    events,
    logger,
    provide,
    services,                           // 写声明了 preference 的字段的本插件偏好
    hostConfig: optional(hostConfig),   // 全局层与平台档、平台类型档；缺席时这三层写不了
    platform: optional(platform),       // 列可设的平台与类型、类型的显示名
    authority: optional(authority),     // 指令的门槛；缺席时指令一律拒绝写
    commands: optional(commands),       // /session 系列
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

本插件没有插件配置。

## 各层存在哪

| 层 | 存在哪 |
|---|---|
| 全局（插件配置） | `plugins.<实例 id>.<字段>`；写了 `preference` 的字段（agent 的「模型」）是这个实例的本插件服务偏好 `pluginServicePreferences.<实例 id>.<服务名>` |
| 平台档 | `sessionConfig.platforms.<平台>.<实例 id>.<字段>` |
| 平台类型档 | `sessionConfig.platformTypes.<平台>.<类型>.<实例 id>.<字段>` |
| 场所 | 场所记录的 `metadata['session-settings'].values` |
| 本会话 | 会话记录的 `metadata['session-settings'].values` |

```yaml
plugins:
  '@aalis/plugin-agent': { historyLimit: 0 }
pluginServicePreferences:
  '@aalis/plugin-agent': { llm: <llm 实例 id>/<模型 id> }   # agent「模型」的全局层
sessionConfig:
  platforms:
    onebot: { '@aalis/plugin-tools': { enabledToolGroups: ['search'] } }
  platformTypes:
    <平台>:
      group: { '@aalis/plugin-agent': { think: <档位 id> } }
```

- 会话与场所记录里一项一条（`{ plugin, key, value }`），不拿实例 id 当对象键；删掉一项就删掉这一条。值随会话管理落盘，随记录删除。
- 读宿主文档时核形状：`sessionConfig` 只认 `platforms`、`platformTypes` 两段，不认识的段（如 `types`）、名字不合层标识写法的平台名与类型名、不是对象的实例值告警一次后忽略；既没登记、配置文档的 `plugins` 里也没有的实例 id 告警一次，值留着不生效。留空的段（只剩键名、读出来是 `null`）与没有这一段同样处理，不告警。
- 读会话、场所记录时：`values` 不是数组、条目缺 `plugin`、`key` 或 `value`（`value` 为 `null` 也算缺）的按没设处理，每条记录告警一次。
- 声明字段的插件交的此刻实际在用的值（`actual`）与写了 `preference` 的字段的 `fromText` 抛错时只影响这一项：这一行不带实际在用的值、全局层按没有偏好，建子会话时不写这一项；同一个错告警一次。
- 写平台档、平台类型档时在现读的原样文档上只改这一处的这一项，读不懂的部分原样留着；要写的路径上已有的值不是对象时拒收，回执点名那一段。
- 写全局层时在最新的文档上只改这一个键（恢复默认时有作者默认写作者默认，没有就删掉），不经插件配置的应用、插件不重载；写了 `preference` 的字段改本插件偏好（运行态与文档），指向的不是这个服务的提供者时拒收。
- 写宿主文档的几层先改内存里的文档再落盘：落盘失败（配置文件被外部改过而拒写、写盘出错）时这次修改已在运行态生效，回执写与插件详情保存相同的那一句（api-host-config 的 `saveFailureText`），不撤回。
- 手写在 agent 配置段里的 `llm` 键不生效（它的全局层是本插件偏好），读取器告警一次，键留在文件里由 owner 删掉。

## 解析时取哪几层

- 子会话一律按根会话取平台、聊天窗口的类型与场所。
- 有出生平台的会话（IM 房间）按出生平台取平台档、按聊天窗口的类型名取平台类型档，不论从哪个入口驱动：owner 从 WebUI 往 QQ 群插话，这一轮仍按 onebot 与群的档取。
- 没有出生平台的会话（WebUI、终端）按调用方给的入口平台取平台档，没有平台类型档。
- 不在会话表里的会话只取全局层与平台档；根会话是空记录的另取它自己的本会话层。两种都没有场所层，不按 `appliesTo` 筛。
- 一层的行解析到这一层为止：窗口场所在全局、平台档、平台类型档之上，工作区场所只在全局之上，平台类型档在全局、平台档之上，平台档只在全局之上。

## 子会话

两个建子会话的入口（会话服务的 `session/create` 带 `parentId`、[plugin-subtask](./plugin-subtask.md) 的 `create_subtask`）在建之前调 `childMetadata`：父会话此刻每一项适用于子会话的生效值（包括具体模型：没设的取 agent 此刻实际在用的那一个）写进子会话自己那一层，之后父会话与场所、平台档、全局再改都不影响它，追问也不重写。语言、回复策略这些不适用于子会话的项照旧跟根会话。父会话自己那一层里此刻没登记的实例（重载中、停用或卸载后留下的）的条目原样带过去。本插件不在时两个入口都不建。

父会话改直接子会话的设置走 `setAs`，与在那个子会话里用 `/session.set` 是同一份实现（[plugin-subtask](./plugin-subtask.md) 的 `set_subtask_setting`）。

## 指令

| 指令 | 作用 |
|---|---|
| `/session` | 列出当前对话里你能改的项，每项写生效值与它来自哪一层；没设的写没设时的含义，模型写此刻在用的那一个。owner 看到全部，别人只看到自己能改的 |
| `/session.set [--at <层>] <项> <值>` | 改一项，下一轮起生效。`--at` 收 `session`（缺省）、`place`、`platformType`、`platform`、`global`；`-n <名字>` 改会话显示名 |
| `/session.reset [--at <层>] [项]` | 恢复继承（全局层是恢复默认）。不写项时清掉这一层你能改的全部项，只用于本会话与场所；平台类型档以上必须写明清哪一项 |

- 项写字段名；几个插件同名时写成 `<实例 id>/<键>`。项写错（不存在、不适用或重名）时回执列出你在这一层能改的项。
- 值的文字读法：开关收 `on`、`off`、`true`、`false`、`1`、`0`；数字收数字；单选有静态可选项时只收选项值（不收选项标签，回执列出可选值）；多选与列表按逗号或顿号拆；文字按指令的分词规则读（含空格、换行或引号时整段加引号，反斜杠一律写两个，以 - 开头时前面加 --）；外来类型调字段的 `fromText`（如模型写 `<实例 id>/<模型 id>`）。空值：列表与映射写 `[]`，文字写 `""`（所有指令里空的引号算一个空参数）；回执与 `/session` 里空值写「无」。映射在聊天里只收 `[]`，其余到设置页里改。
- 写入校验都在提供者那里：不合字段的值、不适用于这个会话的项、只能设到场所的项写到本会话、平台类型档收不适用于房间的项，都拒收并写明原因，点名这一项时写行上的称呼加键（「最大工具迭代（maxToolIterations）的值不合法：…」）。设了不存在的模型、思考档或人设（全局层的模型除外）不当场拒绝，下一轮由对应插件处理。
- WebUI 与终端的会话里写 `--at platformType` 回「这个会话没有聊天窗口，不属于任何平台类型档」；空记录与未收录的会话写 `--at place` 回「这个会话还没收录，没有场所层」。会话管理还没收录的会话写本会话层之前先建档。

### 门槛

所有会话一律判门槛，私聊也不例外；权限服务不在时聊天里改不了设置。门槛取「项的门槛」与「写在哪一层的门槛」两者中较高的：

- **项的门槛**：能力 `setting:<实例 id>/<键>`，默认按字段声明的 `minLevel`（不写即只有 owner），交给权限服务的 `authorize` 裁决。owner 能在权限页「操作门槛」里和指令、工具一样按项调，改过的存进 `authorityOverrides`。
- **层的门槛**：固定，不能调，经权限服务的 `meetsLevel` 裁决。

| 写到 | 层的门槛 |
|---|---|
| 本会话 | 不另设（只看项的门槛） |
| 群或私聊的场所 | 2 级 |
| 工作区场所（含默认工作区）、平台类型档、平台档、全局 | 只有 owner |

第一方的项里 1 级就能改的是模型、深度思考、人设、语言与子任务模型；其余只有 owner（见 [api-session-settings](../api/api-session-settings.md) 的「第一方的项」）。owner 在任何平台都能用 `/session.set --at global` 写插件配置，等同在本机改配置文件；别人发起的回合拿不到 owner 的身份。

## 事件

- 会话增删、场所与会话记录上的值变了、字段登记增减时发 `session-settings:changed`，会话服务据此推 `session/config/changed`。
- 宿主文档（全局层、平台档、平台类型档、本插件偏好）的变化由宿主发 `host-config:changed`，本插件不转发。

## 相关

- 契约与读取器：[api-session-settings](../api/api-session-settings.md)
- 会话协议上的设置方法与 WebUI：[api-session-protocol](../api/api-session-protocol.md)、[plugin-session-server](./plugin-session-server.md)、[plugin-webui-client](./plugin-webui-client.md)
- 「操作门槛」：[plugin-authority](./plugin-authority.md)
