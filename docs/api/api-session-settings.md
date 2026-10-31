# api-session-settings — 会话设置契约

**包名**: `@aalis/api-session-settings`  
**源码**: `packages/api-session-settings/src/index.ts`  
**实现**: `@aalis/plugin-session-settings`

## 概述

插件配置字段可以声明「可按会话覆盖」：在 configSchema 的顶层字段上写 `session`。这类字段的全局层就是插件配置里的值，另外能按平台档、平台类型档、场所与本会话覆盖。宿主不把它们交给插件的运行态配置（`caps.config` 里没有），插件在 apply 里调 `fields()` 拿读取器，调用路径上按会话读生效值；改这类字段不重载插件。

本包定义声明、层表、解析与两个门面（读取门面 `sessionFields`、管理面 `sessionSettings`）。解析只在本包的纯函数 `resolveFields` 一处做：读取器在插件进程内调它，提供者 [@aalis/plugin-session-settings](../plugins/plugin-session-settings.md) 只交出各层的原样值。提供者缺席（没装、没启用，或会话管理没起来）时读取器只取全局层，插件配置里的值照常生效。

## 声明

```ts
import { defineConfig } from '@aalis/schema-config';

const configSchema = defineConfig({
  greeting: {
    type: 'string',
    label: '问候语',
    default: '<问候语>',
    session: { prominence: 'common', minLevel: 1 },
  },
});
```

`session`（`SessionFieldSpec`，本包经 declaration merging 并进 `@aalis/schema-config`）的成员：

| 成员 | 含义 |
|---|---|
| `prominence` | 必填。`composer` 也出现在输入框旁的快捷切换（同一会话最多两项，多出的按先后退到 `common`）；`common` 在设置里排在前面；`advanced` 收进默认折叠的「高级」，按实例分组 |
| `appliesTo` | 适用的会话种类（`owner`、`room`、`task` 里的一项或几项）。不写即适用全部会话种类（含子会话），只适用一部分时才写。不适用的会话只取全局层与作者默认，也不收这一项的写入 |
| `narrowest` | 只能是 `'place'`：只能设到场所为止，本会话层不收它，会话记录上存着的值也不参与解析 |
| `order` | 同一显眼程度里的先后，小的在前；不写排在写了的后面 |
| `dependsOn` | 可选项依赖同一 schema 里另一个带标记字段的生效值（那一项没设时带它的 actual）；本字段要有 `dynamicOptions` |
| `unset` | 哪一层都没有值时的含义（如「跟随服务偏好」）：字段没有 `default` 时必须写一句非空的，有 `default` 的不写 |
| `minLevel` | 改本会话这一层的门槛：1 或 2；不写即只有 owner 能改。往上各层另有固定的门槛（见 [plugin-session-settings](../plugins/plugin-session-settings.md)） |
| `preference` | 全局层不在插件配置里，由声明它的插件实例对这个服务的本插件偏好承担：值经字段的 `toText`、`fromText` 与偏好的 contextId 互换。不能有 `default` 与 `narrowest`；插件配置段里手写了这个键不生效，读取器告警一次 |

字段上的函数成员（`@aalis/schema-config`）：`validate`（取值校验，外来字段类型必须给）、`fromText` 与 `toText`（指令里的文字读写，外来类型与写了 `preference` 的字段要给）。经 JSON 下发时去掉它们（`WireSchemaField`）。

`fields()` 先调 `assertSessionFields(schema)` 校验声明，不合格抛 `TypeError` 点名字段，插件因此激活失败：`session` 只写在顶层字段上；不同时写 `secret` 或 `required`；各成员的取值；`dependsOn` 指向另一个带标记字段且本字段有 `dynamicOptions`；外来类型带 `validate`；没有 `default` 的写非空的 `unset`；写了 `preference` 的带 `toText` 与 `fromText`、没有 `default` 与 `narrowest`。

作者默认照常写进配置文件：宿主按 `defaultsFrom` 补写的插件配置段里有这些键，所以全局层总有值；「没设」本身有独立含义的项不给 `default`、写 `unset`。

## 层

```ts
const SESSION_LAYERS = [
  { name: 'global', label: '全局（插件配置）' },
  { name: 'platform', label: '平台档' },
  { name: 'platformType', label: '平台类型档' },
  { name: 'place', label: '场所' },
  { name: 'session', label: '本会话' },
] as const;   // 先后即生效顺序，后面的压过前面的；称呼是文字对象

type SessionSettingsLayer =
  | { scope: 'global' }
  | { scope: 'platform'; platform: string }
  | { scope: 'platformType'; platform: string; type: string }
  | { scope: 'place'; key: string };
```

| 层 | 选哪一份 | 存在哪 |
|---|---|---|
| 全局（插件配置） | 唯一 | `plugins.<实例 id>.<字段>`；写了 `preference` 的是这个实例的本插件服务偏好。宿主不提供配置文档时为这次激活 `caps.config` 里的同名键 |
| 平台档 | 根会话的出生平台；没有出生平台的会话取调用方给的入口平台 | 宿主配置文档 `sessionConfig.platforms.<平台>.<实例 id>.<字段>` |
| 平台类型档 | 根会话的出生平台与聊天窗口的类型名，两者都有才取 | `sessionConfig.platformTypes.<平台>.<类型>.<实例 id>.<字段>` |
| 场所 | 根会话的场所（会话管理的 `placeOf`） | 场所记录的 `metadata['session-settings']` |
| 本会话 | 会话自己；子会话的这一层在建立时写下 | 会话记录的 `metadata['session-settings']` |

- 子会话一律按根会话取平台、聊天窗口的类型与场所。
- 不在会话表里的会话、根会话是空记录（api-session-manager 的 `isUnfiled`）的会话只取全局层与平台档（平台按调用方给的入口平台），没有平台类型档、场所与会话种类，不按 `appliesTo` 筛。
- 要对所有群生效的设置按平台分别设在平台类型档；没有跨平台按类型名生效的一层。
- 层的标识：平台名与类型名非空、不含 `:`、不是 `*`；场所键要是已有的场所记录。
- `sessionConfig`（`SessionConfigDoc`，本包经 declaration merging 加进 `AalisConfig`）只认 `platforms`、`platformTypes` 两段，每处按插件实例 id 放这个实例的值。

```yaml
sessionConfig:
  platforms:
    onebot: { '@aalis/plugin-tools': { enabledToolGroups: ['search'] } }
  platformTypes:
    <平台>:
      group: { '@aalis/plugin-agent': { think: <档位 id> } }
```

## 解析

`resolveFields(schema, global, chain, warn)` 对每一个带标记字段：

1. 依次叠全局层与 `chain` 的各层（平台档、平台类型档、场所、本会话），后面的压过前面的。会话种类已知且这一项不适用时只取全局层；只能设到场所的项跳过本会话层；场所层只在 `appliesTo` 含场所种类（窗口按房间，工作区按 owner 的会话，api-session-manager 的 `placeKind`）时生效。
2. 每个值过 `readFieldValue`（类型、约束键与字段的 `validate`）：合法的取换算后的值；严格字段（`onInvalid: 'error'`）的坏值原样交给插件按拒绝处理、不回落到更宽的层；其余坏值当作没设，告警。
3. 哪一层都没有时取 `default`，来源记为 `'default'`；没有 `default` 的不给值。

来源 `SessionSource` 是层名或 `'default'`（全局层的值缺失或不合法、按作者默认）。

## 读取门面 `sessionFields`

按会话读、写自己字段的插件与列「操作门槛」的权限插件声明它：

```ts
import { ownHostConfig } from '@aalis/api-host-config';
import { sessionFields } from '@aalis/api-session-settings';
import { config, optional } from '@aalis/core';

const uses = { config, sessionFields: optional(sessionFields), document: optional(ownHostConfig) };
// apply 里调一次
const fields = caps.sessionFields.use.fields(configSchema, caps);
// 回合里
const { greeting } = fields.get(message.sessionId, { platform: message.platform });
```

```ts
interface SessionFields {
  /** 校验声明、把 schema 与读全局原样值的闭包登记给会话设置（随激活撤回），返回读取器 */
  fields<const S extends ConfigSchema>(
    schema: S,
    from: { config; document },                       // 插件的 caps：config 与 optional(ownHostConfig)
    actual?: { [K in keyof SessionFieldsOf<S>]?: ActualValue },
  ): SessionFieldReader<S>;
  /** 已登记的各项（只读，不含值）；提供者缺席时访问抛错，先看 present */
  getAll(): SessionFieldEntry[];   // { plugin, key, label, minLevel? }
}

interface SessionFieldReader<S> {
  /** 生效值；不给 sessionId 时只取全局层与作者默认 */
  get(sessionId?: string, at?: SessionAt): SessionFieldsOf<S>;
  /** 本实例在各层自己写的值（诊断用）：全局在前，场所另带场所种类，会话上的不列 */
  layers(): Array<{ layer: SessionSettingsLayer; placeKind?: SessionKind; values: Partial<SessionFieldsOf<S>> }>;
  /** 写本实例一个字段在某个会话本会话层的值（null 即恢复继承）；会话设置不在时抛 SessionSettingsError */
  set(sessionId: string, key, value): Promise<void>;
}
```

- `at.platform` 是入口平台，只对没有出生平台的会话起作用。
- 读取器只读、只写本实例的字段：实例由门面按这次激活的实例 id 填。跨插件要改别人的设置，改为调拥有它的插件的服务（如 agent 的 `assignModel`）。
- 全局值由门面现读：宿主提供配置文档时取 `ownHostConfig` 里本实例那一段的复制品，没有时取 `caps.config` 里的同名键。
- `ActualValue`：字段解析下来没设时此刻实际在用的值（`{ value, label? }`），由声明字段的插件给出闭包。用于显示（「跟随服务偏好（此刻：<模型名>）」），也用于建子会话时写下父会话没设的项。第一方只有 agent 的「模型」交它。

## 管理面 `sessionSettings`

同一个服务名的另一个描述符，只给会话服务与建子会话的插件（plugin-subtask）。显式列出交出的方法：

| 方法 | 用处 |
|---|---|
| `fields`、`getAll` | 同读取门面 |
| `placements(plugin)` | 一个实例的带标记字段在全局之外写过的每一处，扁平列出（层，或某个会话的本会话层） |
| `layers()` | 可以设的各层（`SessionSettingsLayerInfo`）：平台类型档另带适配器声明的类型显示名；场所另带称呼（不带平台：取了名的工作区写「工作区「名字」」，窗口写类型的显示名与窗口名），窗口场所另带 `platform` 与 `type` |
| `rows(target)` | 一组行：会话的（只列适用于它的项）或一层的（只列这一层可写的项），各带这一处自己的原样值、解析到这一处为止的生效值与来源，没设的另带 actual |
| `update(target, item)` | 写一项，`null` 即删掉这一处（全局层是恢复默认，其余层是恢复继承）。全部写入校验都在这里，不判门槛，不合的抛 `SessionSettingsError`。写宿主文档的几层先改内存里的文档再落盘，落盘失败时带回 `saveError`、不撤回 |
| `childMetadata(parentId, at?)` | 建子会话时并进 `createChildSession` 的 metadata 的一段：父会话此刻每一项适用于子会话（`appliesIn(spec, 'task')`、不是只能设到场所的）的生效值，没有值的取 actual；父会话自己那一层里此刻没登记的实例的条目原样带上 |
| `setAs(identity, sessionId, item, text)` | 以 identity 的身份写一个会话本会话层的一项，与 `/session.set` 不带 `--at` 是同一份实现（认项、文字读法、门槛、回执）。写成与否都回一句回执 |

提供者的 `register` 与 `chain` 只由读取器经 `fields()` 调，不交给持有管理面的插件：它们不能以别的实例 id 登记伪造的字段。

## 其余导出

- `appliesIn(spec, kind)`：这一项适用于这种会话（`appliesTo` 不写即适用全部）。
- `layerLabel(name)`：层表里这一层的称呼（文字对象）。
- `describeLayer(layer)`：日志里点名一层的写法，如「平台类型档 onebot · group」。
- `SETTINGS_ABSENT`：会话设置不在时的说法（文字对象）；会话协议的设置方法回 unsupported 时用它。
- `SessionSettingsError`、`isSessionSettingsError(err)`（按 name 判定，进程里装了两份本包也认得）、`sessionSettingsError(text)`（带给人看的原因）。
- 事件 `'session-settings:changed'`（不带参数）：宿主文档以外的设置变了（场所与会话记录上的值、字段登记增减、会话增删）。宿主文档的变化另有 api-host-config 的 `host-config:changed`。

## 第一方的项

| 实例 | 项 | 适用 | 门槛 | 没设时 |
|---|---|---|---|---|
| [plugin-agent](../plugins/plugin-agent.md) | `llm`（模型，全局层是本插件偏好）、`think` | 全部 | 1 级 | 跟随服务偏好；按模型的默认档 |
| plugin-agent | `maxToolIterations`、`historyLimit` | 全部 | owner | 不限；0 |
| [plugin-persona](../plugins/plugin-persona.md) | `persona` | 全部 | 1 级 | `default` |
| plugin-persona | `systemPromptExtra`、`disableOutputFormat`、`clientSideJsonRendering` | 全部 | owner | 空；关；按角色卡 |
| [plugin-tools](../plugins/plugin-tools.md) | `enabledToolGroups` | 全部 | owner | 在本机（WebUI、终端）建的会话全部分组，别的会话不开 |
| [plugin-skills](../plugins/plugin-skills.md) | `enabledSkills` | 全部 | owner | `['*']` |
| [plugin-memory-summary](../plugins/plugin-memory-summary.md) | `compressAt` | 全部 | owner | 0.8 |
| [plugin-checkpoint](../plugins/plugin-checkpoint.md) | `coverage`（记检查点的会话） | 全部 | owner | 按受众（`ownerOnly`） |
| [plugin-session-manager](../plugins/plugin-session-manager.md) | 取别的会话的范围 `takeScope` 与三个开关 `takeOtherGroups`、`takeOthersPrivate`、`takeCrossBot` | 全部 | owner | 同平台；读别的群；不读别人的私聊；不跨机器人账号 |
| [plugin-memory-vector](../plugins/plugin-memory-vector.md)、[plugin-user-relation](../plugins/user-relation.md) | 各自的范围：`crossSessionMode`、`recallScope` | 全部 | owner | 各插件的作者默认 |
| [plugin-subtask](../plugins/plugin-subtask.md) | `model`（子任务模型） | owner 会话与房间 | 1 级 | 不另指定（与本会话相同） |
| [plugin-i18n](../plugins/plugin-i18n.md) | `language` | 房间 | 1 级 | `['en']` |
| [plugin-trigger-policy](../plugins/plugin-trigger-policy.md)、plugin-trigger-laya、[plugin-flow-control](../plugins/plugin-flow-control.md) | 生效范围（`audience`）与各自的参数 | 房间 | owner | 生效范围默认多方房间 |

## 第三方要知道的

- 读这类字段只能经读取器：`caps.config` 与 `parseConfig` 不交出它们，`ConfigOf` 里也没有（类型见 `SessionFieldsOf`）。
- 权限类的项（决定能用什么工具、能读多宽的记忆之类）不要把 `task` 排除在 `appliesTo` 之外：子会话建立时只写下适用于子会话的项，不适用的项在子会话里按全局层取。
- 建子会话的插件在建之前调管理面的 `childMetadata`，并进 `createChildSession` 的 `metadata`；会话设置不在时不建（第一方的两个入口都这样）。
- 层值写在插件自己的实例 id 下：同一个插件装多个实例时各列各的。删除后缀实例不清它在各层的值，同名重建会继承原值。

## 相关

- 实现、`/session` 系列指令与门槛：[plugin-session-settings](../plugins/plugin-session-settings.md)
- 会话协议上的设置方法：[api-session-protocol](./api-session-protocol.md)
- 会话与场所记录：[api-session-manager](./api-session-manager.md)
- 宿主配置文档、`ownHostConfig` 与 `host-config:changed`：[api-host-config](./api-host-config.md)
