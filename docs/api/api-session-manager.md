# api-session-manager — 会话、会话设置与树形管理契约

**包名**: `@aalis/api-session-manager`  
**源码**: `packages/api-session-manager/src/index.ts`  
**实现**: `@aalis/plugin-session-manager`

## 概述

定义会话树形层级、会话种类、场所与工作区，以及会话设置的登记、存储、继承与解析。会话设置项（模型、人设、工具分组、白纸开关……）由拥有这项功能的插件登记，本契约与会话管理不认识任何具体的键：登记过的键按登记的字段校验与解析，插件没装或没启用时它的键原样留在存储里，不显示、不参与解析，重新启用后恢复。Agent 等消费方经 `resolveConfig()` 取一个会话的生效配置。

## 会话设置

### 值的类型

```ts
/** 各设置项的值；键由登记它的插件经 declaration merging 注入，每个键都可选（没有即继承上层） */
interface SessionConfig {}

/** 会话档案里存的配置：会话自己的覆盖；sessionDefaults 是旧数据里父会话给子会话的默认值，解析照常生效，不再有写入口 */
type StoredSessionConfig = SessionConfig & { sessionDefaults?: SessionConfig };

/** 写会话或某一层：给值即写入（按登记的字段校验），null 删掉这一项、恢复继承，没给的键不动 */
type SessionConfigPatch = { [K in keyof SessionConfig]?: SessionConfig[K] | null };
```

插件给 `SessionConfig` 加键的写法与 `AalisEvents` 相同：

```ts
declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    persona?: string;
  }
}
```

### 登记设置项

```ts
type SettingProminence = 'composer' | 'common' | 'advanced';

interface SessionSetting {
  key: keyof SessionConfig & string;   // 先经 declaration merging 加进 SessionConfig
  field: SchemaField;                  // schema-config 字段：类型、标签、说明、校验、可选项来源（dynamicOptions）
  appliesTo: readonly SessionKind[];   // 适用的会话种类
  narrowest?: 'place';                 // 最窄能设到哪一层：place 即只能设在场所及以上，见下文
  prominence: SettingProminence;
  order?: number;                      // 同一显眼程度里的先后，小的在前；不写的排在后面
  liveOnly?: boolean;                  // 只经继承链实时解析：建子会话复制配置时不带它
  dependsOn?: keyof SessionConfig & string;  // 可选项依赖另一项的生效值，见下文
  unset?: string;                      // 哪一层都没设、字段又没有默认值时这一项的含义，见下文
  validate?(value: unknown): string | undefined;  // 取值校验：合法回 undefined，否则回原因；外来字段类型必须给
}

interface RegisteredSessionSetting extends SessionSetting {
  plugin: string;                      // 登记它的插件实例 id
}
```

插件经绑定门面登记，随它的激活撤回：

```ts
const uses = { sessionManager: optional(sessionManager) };
// apply 里
sessionManager.use.registerSetting({
  key: 'persona',
  field: { type: 'select', label: '人设', dynamicOptions: 'persona', allowCustom: true },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'common',
});
```

会话管理换提供者时，门面把登记整体重挂到新的提供者上；会话管理不在时登记先记在账上，它上线时挂上。

- **显眼程度：** `composer` 也出现在输入框旁的快捷切换，同一会话最多两项，多出的按 `order` 退到 `common`；`common` 在设置里排在前面；`advanced` 收进默认折叠的「高级」，按登记它的插件分组。
- **字段：** 写入时按它校验，不合的拒绝。存储里不合它的值（旧数据、手写的配置文件）解析时当作没设置，同一处只告警一次；字段标了 `onInvalid: 'error'` 的，原值原样交出、不回落到下面的层，由登记它的插件按拒绝处理（例如金额上限写坏了按 0，不能退成不限）。没有任何一层设置时解析结果里没有这个键，`field.default` 只供界面显示，须与「没有这个键」时的行为一致。
- **可选项依赖另一项：** `dependsOn` 写另一个设置项的键。界面取这一项的动态可选项（`field.dynamicOptions`）时带上那一项在这个会话或这一层的生效值（webui-server 的 `/api/models/:service` 收在 `dependency` 查询参数里），那一项变了就重取。依赖值只交给会读它的可选项来源（目前是 webui-server 的 `llm-thinking`），走服务 `listModels()` 的可选项拿不到它。依赖的须是另一个键、字段须有 `dynamicOptions`，否则登记抛错。会话协议的设置行带同名字段。第一个用处是 plugin-agent 的「深度思考」：档位按「模型」这一项的生效模型取。
- **没设时的含义：** 设置行要写生效值。写得出具体值的给 `field.default`（如 plugin-agent 的工具迭代上限写 30）；写不出的给 `unset`，一句话说没设时怎样（「只给不属于任何分组的工具」「不另加限制」），界面写在生效值的位置，开关写在开关下面。`unset` 不是非空的一句话时登记抛错。会话协议的设置行带同名字段。
- **取值校验：** `validate` 在写入与解析时先于字段校验，回了原因的与不合字段同样处理。schema-config 不校验外来字段类型（如 `llm-ref`）的取值，外来类型的设置项不给 `validate` 时登记抛错。plugin-agent 的 `llm` 只收服务与模型都是非空字符串的 `{ provider, model }`。
- **同一个键几个插件登记：** 须是同一份内容的定义（逐项深比较，`validate` 比较函数本身），不必是同一个对象：进程里装了两份契约包时，两份导出的定义也认作同一份。几个插件共同遵守的设置项由契约包导出定义、各自登记，只要还有一个登记者在场，这一项就有效；`listSettings()` 里归最先登记、仍在场的那个插件。内容不同的登记抛错。
- **只能设到场所为止：** `narrowest: 'place'` 的项只能设在全局默认、平台档、平台类型档与场所上，会话自己的覆盖不收它（写入抛 `SessionConfigError`，写明「这一项在场所及以上设置」；清掉照收），建子会话也不复制它。会话上存着的旧值（会话自己的覆盖、父会话给子会话的默认值）不参与解析，`getOwnConfig` 也不交出，每个会话每一项告警一次。按房间的设置（如白纸）设在窗口场所上，换会话不丢。不写即可设到本会话；写别的值的登记抛错。
- 键不能是空串、`sessionDefaults` 或原型链上的名字，`appliesTo` 与 `prominence` 取值不对的登记抛错。
- 登记与撤回都发 `session:config:changed`。

第一方登记的设置项：

| 键 | 登记者 | 适用 | 显眼程度 | 没设时 |
|---|---|---|---|---|
| `llm` | [plugin-agent](../plugins/plugin-agent.md) | 全部 | composer | 全局默认层即 llm 服务的偏好（下文「默认模型只有一处」）；界面写服务实际用的那一个 |
| `think`、`maxToolIterations` | plugin-agent | 全部 | common、advanced | 模型的默认档（可选项接口标出）；30（默认值） |
| `historyLimit` | plugin-agent | 全部 | advanced，liveOnly | 0（默认值）：读全部活跃历史，不按条数压缩 |
| `compressAt` | [plugin-memory-summary](../plugins/plugin-memory-summary.md) | 全部 | advanced，liveOnly | 0.8（默认值） |
| `persona`、`systemPromptExtra` | [plugin-persona](../plugins/plugin-persona.md) | 全部 | common | 主卡 `default`（默认值）；不追加 |
| `disableOutputFormat`、`clientSideJsonRendering` | plugin-persona | 全部 | advanced | 关；按角色卡 |
| `enabledToolGroups` | [plugin-tools](../plugins/plugin-tools.md) | 全部 | common | 只给不属于任何分组的工具 |
| `memoryRecallScope` | 跨会话取料的插件各自登记 `MEMORY_RECALL_SCOPE_SETTING`（[api-memory](./api-memory.md)） | 全部 | advanced | 按各记忆插件的配置 |
| `paperEnabled`、`paperName`、`remoteAgentTypes` 与三项每日上限 | [plugin-paper](../plugins/plugin-paper.md) | 房间 | advanced，liveOnly，只能设到场所为止 | 关；每个窗口各一块；不允许；不另加限制、不按人限制 |

### 层表

会话设置的层由一张层表定义，后面的压过前面的：

```ts
const SESSION_LAYERS = [
  { name: 'defaults', label: '全局默认' },
  { name: 'platform', label: '平台档' },
  { name: 'type', label: '平台类型档' },
  { name: 'place', label: '场所' },
  { name: 'parent', label: '父会话' },
  { name: 'session', label: '本会话' },
] as const;
type SessionLayerName = (typeof SESSION_LAYERS)[number]['name'];
type InheritanceSource = Exclude<SessionLayerName, 'session'>;   // 继承链的层

/** 会话之上能单独读写的层（父会话与本会话经会话本身读写） */
type SessionConfigLayer =
  | { scope: 'defaults' }
  | { scope: 'platform'; platform: string }                 // 按平台名，不区分适配器实例
  | { scope: 'type'; platform: string; type: string }       // 某个平台的某种类型
  | { scope: 'place'; key: string };                        // 某个场所，键见下文「场所与工作区」
```

| 层 | 存在哪 | 作用于（子会话按根会话） | 取哪一份 |
|---|---|---|---|
| 全局默认 | 宿主配置 `sessionConfig.defaults` | 全部会话 | — |
| 平台档 | `sessionConfig.platforms.<平台>` | 全部会话 | 有出生平台的按出生平台，其余按调用方传入的入口平台 |
| 平台类型档 | `sessionConfig.types.<平台>.<类型名>` | 有聊天窗口的会话 | 出生平台与聊天窗口的类型名 |
| 场所 | 会话管理的场所记录（记忆后端） | 全部会话 | `placeOf` 的键 |
| 父会话 | 父会话记录的 `sessionDefaults`（旧数据） | 子会话 | — |
| 本会话 | 会话记录的 `config` | 这一个会话 | — |

读取、解析、来源显示、可设的层与界面的选层都照这张表走，加一层是这张表加一行、会话管理的实现表加一条、`SessionConfigLayer` 加一种。

前三层存放在宿主配置文档（`@aalis/api-host-config`）的 `sessionConfig` 字段里，由会话管理读写：

```yaml
sessionConfig:
  defaults:
    persona: aalis
  platforms:
    cli:
      enabledToolGroups: ['*']
    onebot:
      enabledToolGroups: [search]
  types:
    onebot:
      private:
        enabledToolGroups: [search, scheduler]
```

它们是「下次启动用什么」的配置，跟着配置文件走，可以手写，也由脚手架生成。插件配置的 schema 词汇（`map` 只收字符串值）装不下任意类型的设置值，所以不放在会话管理的插件配置里。`sessionConfig` 只认 `defaults`、`platforms`、`types` 三段，形状不对的部分与不认识的段（如拼错的 `platfroms`、旧的 `audiences`）告警一次后忽略，按层写时不再写回。宿主没有提供配置文档时这三层为空、按层写被拒。类型名不限于适配器声明的：卸了适配器或配置里写过的照样能读写、能清掉。

层的标识：平台名与类型名非空、不含 `:`、不是 `*`、不是原型链上的名字（与作用域 `平台:类型:目标` 的段同一套写法）；场所键必须是已有的场所记录。不合的读写都抛 `SessionConfigError`。配置文件里名字不合这套写法的平台档、平台类型档读时告警一次后忽略，按层写时从文件删掉；适配器给的不合写法的平台名与类型名同样不列，`listLayers` 列出的层都能按层读写。

### 继承与解析

`resolveInheritance(sessionId, platform)` 按层表的先后叠加全局默认到父会话（不含会话自身 `config`），`resolveConfig` 在它之上叠会话自己的覆盖。子会话一律按根会话选层：有出生平台的会话不论从哪个入口驱动，都按记下的出生平台选平台档、按聊天窗口的类型名选平台类型档，忽略调用方传入的 `platform`；没有出生平台的会话（WebUI、CLI 等）按传入的入口平台选平台档，没有平台类型档。因此从 WebUI 往 QQ 群插话，这一轮仍按 onebot 的平台档与群的平台类型档选工具组、人设与模型。会话表里没有的 ID 按没有出生平台处理，不从 ID 推。

```ts
interface SessionInheritance {
  platform?: string;                 // 选平台档的平台
  type?: string;                     // 选平台类型档的类型名：只有有聊天窗口的会话带
  values: SessionConfig;             // 继承值（不含会话自身 config）：已登记、取值合法的键
  sources: Record<string, InheritanceSource>;  // 每个键来自哪一层
}
```

`resolveInheritance` 只看继承值，才不会把会话自己的覆盖当成继承来的；会话设置的来源显示与 `/session` 用它。场所层按 `placeOf` 选，要场所的调 `placeOf`。哪一层都没设的项，消费方按「没有这个键」处理。

**默认模型只有一处：** 字段类型为 `llm-ref` 的设置项（plugin-agent 的「模型」）在全局默认层不另存值，读写的就是 llm 服务的偏好（运行态与宿主配置的 `servicePreferences.llm`）。会话管理按字段类型认它，不按键名或插件名。

- 按层读全局默认层（`getLayer`、`resolveLayer`、继承链）时，这一项取偏好指向的模型：条目在时按它的提供者与模型 ID；不在时按还装着的提供者拆（取能作为 `<提供者>/` 前缀的最长的一个，模型 ID 里的 `/` 留在模型里），提供者也不在时按最后一个 `/` 拆。读不成模型引用的偏好（手写的、不带 `/`，或只写了提供者、拆出的提供者只剩 npm scope，如 `@scope/llm-x`）读出来没有这一项，偏好没有生效由 doctor 报出。
- 按层写全局默认层时写的是全局偏好（`services.use.prefer`，`null` 即取消偏好），连同文档的 `servicePreferences` 一起落盘；落盘失败时偏好与文档一并撤回。只有这一项与读出的值不同时才动偏好：改这一层的别的项不碰偏好，读不成模型引用的偏好也原样留着。`sessionConfig.defaults` 不收这一项，配置文件里写了的告警一次后忽略。
- `resolveConfig` 在全局默认之上的各层都没设时不给它的值：取用方交给 api-llm 的 `resolveLLMModel`，落到取用方此刻选中的那一个（取用方这个插件的偏好 > 全局偏好 > 提供者自带优先级 > 登记先后），偏好指向的模型不在时也有着落。`childConfig` 同样不带它。
- llm 服务可能变了（`service:changed`：偏好从别处改了、提供者上下线）同样发 `session:config:changed`：偏好指向的模型在不在、服务实际用的那一个随之变。
- `resolvedDefaults()` 给出这些项此刻实际落到的值：llm 服务按偏好、提供者自带的优先级与登记先后解析到的能对话的模型（偏好指向的模型不在时是服务落到的那一个），没有可用模型时没有。会话服务据此在设置行上带 `resolved`，界面写「默认（<模型名>）」、标出偏好指向的模型不在。

### 写入

`createSession`、`createChildSession`、`ensureSession`、`updateSession` 的 `config` 与 `updateLayer` 的补丁都按登记的设置项校验：没登记的键（提供它的插件没装或没启用）、不合字段的值、写进会话自己覆盖的 `narrowest` 项抛 `SessionConfigError`，什么都不改；`null` 删掉这一项，没登记的键也能删。用 `isSessionConfigError(err)` 判定，不用 `instanceof`。`sessionDefaults` 不是设置项，写不进去。改了配置（`updateSession` 带 `config`、`updateLayer`）发 `session:config:changed`。

`updateLayer` 按层存：全局默认、平台档与平台类型档写进宿主配置文档并保存，保存成功后发事件，保存失败（拒写或写盘出错）时撤回文档里的改动，以拒绝传出；场所层写进场所记录，随会话表落盘。每次按层写记一行设置改动日志（哪一层、哪些键）。

### 建子会话

`childConfig(parentId, platform)` 给出父会话的生效配置去掉 `liveOnly` 与 `narrowest` 项，建子会话时复制它：会话服务的 `session/create` 与 [plugin-subtask](../plugins/plugin-subtask.md) 的 `create_subtask` 都用它。复制会把当时的值冻结进新会话，`liveOnly` 的项（白纸与远端代理）不冻结，免得子会话凭冻结的值继续开远端任务；`memoryRecallScope` 照常复制，否则经子任务就绕过了收窄。

## 会话

```ts
type SessionKind = 'owner' | 'room' | 'task';

/** 子会话为 task，有出生平台为 room（含 owner 自己的私聊），其余为 owner */
function sessionKind(session: Pick<SessionInfo, 'parentId' | 'originPlatform'>): SessionKind;

interface OriginChat {
  type: string;          // 平台类型名
  multiParty: boolean;   // 多方标记：建档时按适配器的声明记下，之后不随声明改动
  selfId?: string;       // 机器人账号：消息上带了才有
  targetId: string;      // 多方为群号，一对一为对端账号；与作用域第三段同口径
}

interface WorkBinding {
  root: string;          // 绑定目录（真实路径），建会话时定：所属工作区的目录，或为这个会话建的同仓 worktree
  extraRoots: string[];  // 附加可写目录
  worktrees: string[];   // 本会话树经宿主建的同仓 worktree
}

interface SessionInfo {
  id: string;
  name: string;
  title?: string;
  parentId?: string;
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  config: StoredSessionConfig;     // 原样存储：含没启用的插件的键
  createdAt: number;
  updatedAt: number;
  createdFrom?: string;            // 创建来源：建这个会话的审批面的登记名（webui、cli）
  inputContext?: string;
  result?: string;
  metadata?: Record<string, unknown>;
  kind: SessionKind;               // sessionKind 的结果
  originPlatform?: string;         // 出生平台：IM 房间建档时记下；只有房间的根会话带
  originChat?: OriginChat;         // 聊天窗口：与出生平台同时记下
  workspace?: string;              // 所属工作区的 id（不带 workspace: 前缀）；缺省即默认工作区。只有根会话带
  work?: WorkBinding;              // 绑定：只有项目会话的根会话带
  currentDir?: string;             // 当前目录：每个会话各带一份，没有值时为场所的主目录
  originInstance?: string;         // 有出生平台的房间：接管它的平台适配器的插件实例 id；只供列表分组
  lastReplyAt?: number;            // 她最近一次开口的时间：回合结局为 replied 时写入
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number; error?: string };  // 最近结束的一轮
  tokens?: { input: number; output: number };  // 这个会话自己的模型调用累计的 token，不含子会话
}
```

会话种类是会话列表的分区、设置项的 `appliesTo` 与会话协议的 `SessionSummary.kind` 共同的来源。它与审批的发起类别是两回事：owner 在自己的 QQ 私聊里亲手发起的回合照样能产生审批。

会话之间的差别按字段判，不按会话 ID 的写法：

- 来源字段 `originPlatform` 与 `originChat`：会话表里还没有记录的会话收到第一条原生入站（不带 `source`、不是子会话）时，参考实现按这条消息记下（出生平台取消息的平台，聊天窗口经 api-gateway 的 `chatScopeOf` 按这个平台的类型声明解析），之后不变。只有 IM 房间的根会话带，子会话按根会话取（`rootSessionOf`）。按 ID 建档（`ensureSession`、`createChildSession` 给父会话兜底建档）的记录建档时不带，没有创建来源与绑定的根会话由之后第一条归消息平台的适配器管的原生入站补记；认领这个 ID 的平台不止一个时判不出它是谁的窗口，不收录、不补记。读表时缺这两个字段的记录按没有出生平台，运行时不从 ID 推。
- 创建来源 `createdFrom`：建这个会话的审批面的登记名，经专用参数写（`createSession` 的第二个参数、`ensureSession` 的第三个参数，类型 `SessionCreation`），只有会话服务（owner 连接的 `session/create`，写这条连接所在审批面的登记名）与终端（写 `cli`）传。建档时写；`ensureSession` 碰上既没有创建来源、也没有出生平台与绑定的已有记录（按 ID 兜底建档留下的空记录）时补写，随这次更新落盘、发 `session:updated`，其余已有记录不改。专用参数只给根会话：`createSession` 带 `parentId` 又带它时抛错，子会话按根会话取。
- 所属工作区 `workspace` 与绑定 `work`：只在建档时经 `SessionCreation` 写，只用于根会话，子会话随根会话。`workspace` 是工作区的 id，须有记录（没有时抛错）；不带或带 `default` 即默认工作区，不记。在项目工作区（有目录的）里建会话必带 `work: { root }`（绑定目录，由调用方校验：工作区的目录，或为这个会话建的 worktree），默认工作区带绑定抛错。之后绑定只经 `setExtraRoots`、`addWorktree` 改（写在根会话上），取消登记工作区时清掉。
- 当前目录 `currentDir`：建档不写，没有值即场所的主目录；子会话建时取父会话此刻的值，之后各改各的。只经 `setCurrentDir` 改，全部会话都有。
- 所属工作区、绑定与当前目录随会话表持久化，任何清空都不清，删除会话时随记录删除。

`createSession`、`createChildSession`、`ensureSession` 的会话字段参数里带上这几项一律丢弃。`kind` 由 session-manager 按 `parentId` 与出生平台推出，新建、建档、补记与加载时覆盖写入，调用方传的值与存储里的旧值都不采信；参数类型里同样没有它们，也没有下面四个由 session-manager 写入的字段。

房间类别 `roomClass(info, lookup, isOwner)` 是按这些字段判「受众里有谁」的纯函数，子会话取根会话的：有出生平台的，聊天窗口为多方的是 `room`，一对一而对端是 owner 身份的是 `owner-only`（`isOwner` 由调用方传入），其余一对一是 `room`，只认多方标记、不认类型名；没有出生平台、带创建来源的是 `owner-only`；其余（不在会话表里的、按 ID 建档的、`mcp-server`、编排与定时任务的会话）一律 `internal`。

- `originInstance`：接管这个房间的适配器的插件实例 id（`contextId`），与 `@aalis/api-platform` 的 `resolvePlatformBySession` 解析到的相同：收录与补记来源字段之前已问过认领这个 ID 的适配器（`claimantsOf`），第一个认领者随来源字段一起记下，落盘保存，记下后不再重算。会话列表据此把同一插件的多个实例分组显示；路由不读它，平台动作仍按会话 ID 实时路由。还没有适配器认领（适配器没装好、连接还没上来、账号暂时不属于任何实例）的为 undefined，下一条真人入站时重新解析，认领到就补记并发 `session:updated`；同一条记录已有解析在途的不重复解析。按 ID 建档（`ensureSession`）的记录没有出生平台，补记来源字段时才记下。
- `lastReplyAt`：回合结局（`agent:turn:after` 的 `outcome`）为 `replied` 时写入，`silent`、`aborted`、`error` 不改；同一会话别的回合还在跑时同样写入，随 `session:updated` 推出。
- `lastTurn`：每一轮结束时写入这一轮的结局（取值同 `agent:turn:after` 的 `outcome`；消息被拦下、没有结局的一轮记为 `silent`）与结束时间；结局为 `error` 时带 `agent:turn:after` 给的一句原因（`error`，最多留 200 字，空串当作没给），其余结局不带。别的回合还在跑时同样写入，随 `session:updated` 推出并落盘。被停止的会话收口为 `completed`，从 `lastTurn.outcome` 为 `aborted` 看出。
- `tokens`：按 `@aalis/api-llm` 的 `llm:usage` 累加这个会话自己的输入与输出 token（对话、摘要、识图、转写的调用都带会话 id），不含子会话。只记已有的会话，不为用量建会话；不改 `updatedAt`，记了就发 `session:updated`；随会话落盘，删除会话时一并清掉。

`status` 的变化：回合开始时翻 `active`；会话里最后一轮结束时，仍为 `active` 的会话（根会话与子会话一样）按这一轮的结局收口，结局为 `error` 的收口为 `error`，其余（含被停止、消息被拦下、没有结局的一轮）为 `completed`。子会话以回复完成时，plugin-subtask 在回合结束之前先以回复为结果调 `completeSession`。种类 `owner` 只表示「没有出生平台」，包括 `mcp-server`、`workflow::<id>` 与定时任务指定的目标会话，不代表 owner 本人在场。

## 场所与工作区

每个会话恰好一个场所，子会话取根会话的。场所只管归属、白纸与设置层，不管权限（上限按主体与房间类别）。

```ts
interface SessionPlace {
  kind: 'window' | 'workspace';   // window：IM 的群与别人的私聊；workspace：本机的工作区
  key: string;                    // 窗口为 `平台:类型:目标`；工作区为 `workspace:<id>`，默认工作区为 `workspace:default`
}
interface PlaceInfo extends SessionPlace {
  name: string;                   // 显示名；工作区的目录经 WorkspaceInfo 取
}
interface WorkspaceInfo {
  id: string;                     // 默认工作区为 default
  name: string;
  root?: string;
}
/** 场所的白纸 id：`p:` 加场所键的 UTF-8 十六进制（只有小写，大小写不敏感的文件系统上不同的键不会落进同一个目录） */
function placePaperId(key: string): string;
```

`placeOf(sessionId)` 按根会话取第一条：

1. 有出生平台：一对一而对端是 owner 身份的（owner 的 IM 私聊）为默认工作区；其余为窗口，键由 api-gateway 的 `windowKey` 拼出，不含机器人账号，同一个群里两个账号的会话是同一个窗口。聊天窗口缺失（读表时类型不对被去掉）或目标为空的坏数据同样为窗口，键里缺的段按空串拼，日志点名一次，不落进默认工作区：owner 给工作区设的值不会套到房间上。owner 谓词取 authority 的 `isOwner`（与房间类别同一判据），没有 authority 时一对一窗口按窗口算。
2. 没有出生平台的按根会话记下的工作区：有值的为 `workspace:<id>`（绑定在这个工作区仓库的 worktree 上的会话也是它，不看绑定目录）；没有的为默认工作区——WebUI 与终端在默认工作区建的会话、没有发起会话的内部会话（`mcp-server`、编排、定时任务）、按 ID 建档且还没补记来源字段的会话，以及会话表里没有的 ID。记下的工作区没有记录（坏数据）时按默认工作区，日志点名。

场所记录 `{ key, kind, name, root?, config, createdAt, updatedAt }` 存在记忆后端元数据的 `places` 命名空间，与会话表一同跟随选中的记忆后端加载与写回；`config` 就是场所层的值。默认工作区的记录在激活时补上；窗口的记录在 IM 房间建档或补记来源字段时建（owner 的 IM 私聊在默认工作区，不建），显示名取群名或对方昵称，随出生平台的入站更新；删除会话不删场所，同一窗口换了会话照样取到它的设置。窗口场所不提供删除。

工作区：

- `addWorkspace(root)`：root 是已校验的真实路径（目录校验由调用方做）。同一个真实路径只登记一个，已登记的返回那一个（`existed: true`）；否则生成随机的固定编号（不由路径算），显示名取文件夹名，允许重名。
- `listWorkspaces()`：全部工作区，默认工作区在前，其后按登记先后。目录在不在由用到它的一方在用时检查，不存储。
- `removeWorkspace(id)`：只删工作区记录与它的场所设置，不动文件；原属会话（根会话记下的是它的）清掉所属工作区与绑定，会话树里的当前目录一并清掉，回到默认工作区，各发 `session:updated`，另发 `session:config:changed`。默认工作区与没有记录的 ID 抛错。之后再添加同一个目录得到的是新工作区。

## 服务接口（节选）

描述符 `sessionManager`（`name: 'session-manager'`），业务层 `BoundSessionManager` 是 `SessionManagerService` 形状的活句柄加上 `registerSetting(setting)`（`interface BoundSessionManager extends SessionManagerService`）。

```ts
interface SessionManagerService {
  createSession(opts?, creation?: SessionCreation): Promise<SessionInfo>;
  getSession(id: string): SessionInfo | undefined;
  listSessions(filter?: { parentId?: string | null; status?: SessionInfo['status'] }): SessionInfo[];
  updateSession(id, updates): Promise<SessionInfo>;
  ensureSession(id, patch?, creation?: { createdFrom: string }): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  createChildSession(parentId, opts?): Promise<SessionInfo>;
  getChildren(parentId: string): SessionInfo[];
  completeSession(id: string, result?: string): Promise<void>;

  setCurrentDir(sessionId: string, dir: string): Promise<void>;                    // 这个会话自己的当前目录
  setExtraRoots(sessionId: string, extraRoots: readonly string[]): Promise<void>;  // 写到项目会话的根会话上
  addWorktree(sessionId: string, path: string): Promise<void>;                     // 写到项目会话的根会话上

  placeOf(sessionId: string): SessionPlace;
  getPlace(key: string): PlaceInfo | undefined;
  addWorkspace(root: string): { workspace: WorkspaceInfo; existed: boolean };
  listWorkspaces(): WorkspaceInfo[];
  removeWorkspace(id: string): Promise<void>;

  registerSetting(setting: SessionSetting, plugin: string): () => void;  // 提供者一侧；插件用绑定门面
  listSettings(): RegisteredSessionSetting[];
  resolveConfig(sessionId: string, platform?: string): SessionConfig;
  resolveInheritance(sessionId: string, platform?: string): SessionInheritance;
  getOwnConfig(sessionId: string): SessionConfig;                 // 会话自己的覆盖里已登记、取值合法的项（只能设到场所为止的不算）
  childConfig(parentId: string, platform?: string): SessionConfig;
  resolvedDefaults(): SessionConfig;                              // 由服务偏好承担的项此刻实际落到的值
  listLayers(): SessionConfigLayer[];                             // 可以设的各层，按层表的先后
  getLayer(layer: SessionConfigLayer): SessionConfig;             // 这一层自己的值
  resolveLayer(layer: SessionConfigLayer): Pick<SessionInheritance, 'values' | 'sources'>;  // 解析到这一层为止
  updateLayer(layer: SessionConfigLayer, patch: SessionConfigPatch): Promise<void>;

  generateTitle(sessionId: string, userMessage?: string): Promise<string | undefined>;
  updateSessionTitle(sessionId: string, title: string): Promise<void>;
}
```

> 完整签名以源码 `index.ts` 为准；上面是消费方最常用的部分。

事件：`session:created`、`session:updated`、`session:completed`、`session:deleted`，以及 `session:config:changed`（不带参数：设置项登记或撤回、某一层或某个会话的覆盖被改写、全局默认的模型变了），会话服务据此推 `session/config/changed`。

## 实现者

- [@aalis/plugin-session-manager](../plugins/plugin-session-manager.md) — 会话与场所记录持久化到 `MemoryService` 的 `sessions`、`places` namespace，前三层读写宿主配置文档

## 相关

- `/session`、`/model`、`/persona` 等指令由 [plugin-agent](../plugins/plugin-agent.md) 注册（不是 session-manager）
- 会话设置在会话协议上的读写见 [api-session-protocol](./api-session-protocol.md)
