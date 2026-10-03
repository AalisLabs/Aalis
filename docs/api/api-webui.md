# api-webui — WebUI 服务、声明式页面与管理面契约

**包名**: `@aalis/api-webui`  
**源码**: `packages/api-webui/src/index.ts`（服务、登记门面、管理面推送）、`packages/api-webui/src/page.ts`（声明式页面与提示）、`packages/api-webui/src/theme.ts`（主题）  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、按激活绑定的登记门面、声明式页面与提示、管理面推送的事件类型，以及主题的令牌表与主题文件格式。契约包是 MIT：第三方前端只依赖它，照本页实现页面的渲染、调用与布局记录。本页的页面契约与路由先标 experimental。

插件不带前端代码，页面只交声明。插件在 `apply` 里经 `webuiServer` 的 `definePage` 一次交出组件、数据源与动作的处理函数，经 `notify` 发提示；样式、窄屏变形、确认框与输入表单都由宿主统一画。登记归属这次激活，插件停用时同一拍撤回。

`GET /api/plugins` 的 `uses` 是插件 `uses` 声明的完整快照，每项为 `{ key, service, kind }`，`key` 保留 `apply` 参数名；插件页展开后按 `kind` 标为「必需」或「可选」。core 内置服务（`events` / `lifecycle` / `logger` / `config` / `provide` / `services`）和宿主服务（`app` / `plugins` / `host-config` 等）由根激活登记，与第三方服务一样是普通提供者：`/api/services` 里以「宿主」为提供者列出；插件声明了它们同样要经过激活闸，只是这些服务在加载插件前已就绪。`requiredServices` / `optionalServices` 是 `uses` 按是否包 `optional()` 拆出的服务名，包含 core 内置服务。`capabilities` 是工具和指令的敏感可见性标记。经 `services` 动态查询获得的服务不在声明列表中。

## 服务接口

```ts
interface WebUIService {
  getPort(): number;
  getHost(): string;
  addPage(page: PageDefinition, instance: string): () => void;
  invalidate(instance: string, pageKey: string, componentId?: string, sessionId?: string): void;
  addNotice(notice: Notice, instance: string): () => void;
}
```

- `addPage`：登记一个页面，归属插件实例 `instance`；同一实例同一 key 再登记就是替换。按质量门槛校验（见下文），不过就不登记并记一条错误日志。返回的撤回只撤这一次登记。
- `invalidate`：页面数据变了，推给打开着它的界面，按实例、页面、组件与会话合并短时间内的连发。
- `addNotice`：登记一条提示，归属 `instance`；同一实例同一 id 再登记就是替换。`open` 指向的不是本实例位置为 `plugin` 或 `settings` 的已登记页面时不登记，记一条错误日志。

插件不直接调这几个方法，走下面的绑定门面。替换整个后端的实现要实现全部方法。

## 绑定接口

```ts
interface BoundWebui extends ServiceRef<WebUIService> {
  definePage<const P extends PagePlacement = 'plugin', const S extends Record<string, unknown> = Record<never, never>>(
    page: PageDefinition<P, S, NoInfer<keyof S & string>>,
  ): PageHandle;
  notify(notice: Notice): NoticeHandle;
}

interface PageHandle {
  invalidate(componentId?: string, sessionId?: string): void;
}

interface NoticeHandle {
  clear(): void;
}
```

`definePage` 与 `notify` 走 `registrar`：同键替换（页面按 key，提示按 id）、提供者换人整体重挂、停用时同一拍撤回、关闭后拒收。页面的账本先于提示的建：重挂时页面先挂上，提示的 `open` 才核得过。同一个插件里先 `definePage`，再发引用它的提示。

`webui-server` 未就绪时登记排队，就绪后挂上；不必把 `webuiServer` 标成 required。

另有调用型描述符 `webuiClient`（`WebuiClientProvider`），绑定接口是普通 `ServiceRef`。

## 展示元数据（declaration merging）

本包向 `PluginMeta` 注入 `extends?: ExtendDeclaration`（core 不读，仅 WebUI 展示）。`subsystem` 是 `PluginDefinition` 上的展示字段，写在 `definePlugin({ subsystem })`。

本包不向 `@aalis/schema-config` 的 `SchemaField` 注入属性：`secret`（值是凭据，宿主存进密钥存储、WebUI 不回显）与影响取值判定的 `dynamicOptions` / `allowCustom` 都由 `@aalis/schema-config` 声明，插件用它们不必引入本包。

## 声明式页面

### 一个例子

```ts
import { webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-jobs',
  uses: { webui: optional(webuiServer) },
  apply({ webui }) {
    const page = webui.definePage({
      key: 'jobs',
      title: '任务',
      icon: 'calendar-clock',
      actions: {
        create: {
          label: '新建',
          effect: 'write',
          input: { name: { type: 'string', label: '名字', required: true } },
          handler: async ({ input }) => {
            await jobs.create(input.name); // input.name 推为 string
            return `已新建 ${input.name}`;
          },
        },
        pause: {
          label: '暂停',
          effect: 'write',
          row: true,
          handler: async ({ rowKey }) => jobs.pause(rowKey),
        },
        remove: {
          label: '删除',
          effect: 'destructive',
          confirm: '删除后不能恢复',
          row: true,
          handler: async ({ rowKey }) => jobs.remove(rowKey),
        },
      },
      content: [
        {
          type: 'table',
          id: 'list',
          rowKey: 'name',
          columns: [
            { key: 'name', label: '名字', primary: true },
            { key: 'nextRunAt', label: '下次运行', kind: 'countdown' },
          ],
          rowActions: [{ action: 'pause', visibleWhen: 'running' }, { action: 'remove' }],
          data: () => jobs.list().map(j => ({ name: j.name, nextRunAt: j.nextRunAt, running: j.running })),
          detail: [{ type: 'markdown', id: 'definition', data: ({ rowKey }) => jobs.describe(rowKey) }],
        },
        { type: 'actions', actions: ['create'] },
      ],
    });
    jobs.onChange(() => page.invalidate('list'));
  },
});
```

组件与处理函数在同一份声明里，返回形状按组件种类推出：键值组件的数据源返回行、文字组件返回数字、引用没声明的动作、页面动作读 `rowKey`、插件详情的页面读 `ctx.sessionId`、输入字段写错，都在编译期报错（`test/plugins/webui-page-types.test.ts`）。

### 页面

```ts
interface PageDefinition<P, S, A> {
  key: string;        // 本插件实例内唯一
  title: string;
  icon?: string;      // lucide 图标名（kebab-case），界面不认识的换成通用图标
  placement?: P;      // 'plugin'（默认）| 'settings' | 'session'
  order?: number;     // 同一位置里的先后，小的在前，不写的排在后面
  applies?(session: PanelSession): boolean | Promise<boolean>; // 只给 session
  content: PageContent<组件>;  // 组件数组，或 { tabs: [{ key, title, content }] }
  actions?: { [动作名]: ActionDefinition };
}
```

| 位置 | 出现在哪 |
|---|---|
| `plugin`（默认） | 本插件详情的页面区块，地址 `/p/:instance/:pageKey`，占整个主区。只有这个位置的页面能被用户固定到图标栏；插件不能自己进图标栏 |
| `settings` | 设置里的一节 |
| `session` | 会话右侧面板的一个标签，从面板标签栏的「+」按需打开，见下文「会话面板」 |

排法只有三种：竖排（组件数组）、标签页（`{ tabs }`，只在页面最外层）、主从（表格或关系图带 `detail`）。

### 组件

一个组件一件事，共五样：

| 组件 | 数据源返回 | 说明 |
|---|---|---|
| `table` | `TableRow[]` | 带 `rowKey`（指名行里的一个字段，值是这一行的非空字符串标识，表格内不重复）。数据源返回全部行，排序、搜索与分页由宿主在界面上做，行数超过一页才出现搜索框与分页。列可以标 `primary: true`，窄时（手机或会话面板）只显示标了的列；都没标时显示第一列，带详情的表格另留选中用的那一列。`rowActions` 是行上的按钮，`visibleWhen` 指名的行字段为真时才显示（这个字段要是布尔值）。可带 `detail` 与空状态文案 `empty` |
| `graph` | `GraphData` | 通用图：`{ nodes: [{ id, label, kind? }], edges: [{ source, target, label?, kind? }] }`，节点 id 唯一，边的两端是节点 id。`nodeKinds`、`edgeKinds` 声明每类的名字与分类色 `tone`（1 到 6，对应 `--color-chart-1` 到 `-6`，不收颜色值），也是图例；`spacing` 是布局疏密（理想边长，像素）。节点详情同样走 `detail`，详情的数据源收到节点 id。可带 `empty` |
| `info` | `InfoItem[]` | 键值：`{ label, value, kind? }`，数字用等宽数字；`kind` 同单元格的显示种类，不收 `image`、`file` |
| `markdown` | `string` | 只读文字。不渲染原始 HTML，图片只认 `/api/media` 地址，外站图片显示成链接，链接只许 http、https、mailto。要原样显示 YAML、JSON 这类原文，用 `markdownCode(text, language?)` 包成代码块：围栏比原文里最长的一串反引号多一个，原文不会把代码块提前收尾 |
| `actions` | 不取数 | 一组按钮，每个按钮对应一个动作 |

- 每个组件可带 `label`（小标题）与 `description`（一句说明）。
- 有数据源的组件带 `id`，在页面内唯一（跨标签与详情也算）：取数与 `invalidate` 都按它。
- **详情：** 选中一行（一个节点）后显示的组件，宽时在右边、窄时进下一级。详情里的数据源收到选中行的 `rowKey`（`{ rowKey, ctx }`），插件按它重新查；详情里的 `actions` 组件放行动作，作用于选中的那一行。详情里的组件不再带详情，也不放标签页。动作不再返回对象当详情弹窗，看详情只有这一条路。

**单元格的显示种类**（列的 `kind`，封闭集合，不写为 `text`）：

| 种类 | 值 | 界面上 |
|---|---|---|
| `text` | 字符串、数字或布尔值 | 原样，数字用等宽数字 |
| `time` | 毫秒时间戳或 ISO 字符串 | 本地时间 |
| `countdown` | 毫秒时间戳 | 剩余时间，到零不重取 |
| `link` | 网址 | 只认 http、https，新标签打开，其余按文本 |
| `status` | `{ text, state? }` | 一句话；`state` 为 `attention`（需要处理）、`error`（出错）、`running`（进行中）、`inactive`（停用或弱化），正常时不写、不上色 |
| `code` | 字符串 | 等宽 |
| `long-text` | 字符串 | 收起时只占一行、末尾省略，可以展开 |
| `image` | 存储地址 | 宿主换成 `/api/media?uri=…` 地址，按需懒加载；空值不换 |
| `file` | 存储地址 | 宿主换成 `{ name, handle? }`：`handle` 是下载句柄，经 `GET /api/page-file?handle=` 下载。插件私有数据的根（`data`、`pluginData`）里的文件不签发，只有名字；规则与会话条目的文件句柄同一条（api-storage 的 `canIssueFileHandle`） |

页面里没有 base64 文件载荷，也没有按整行取文件的列方法：图片与文件都给存储地址。

### 动作

```ts
type ActionDefinition<I, C> = {
  label: string;                 // 按钮上的字：两到四个字的动词
  effect: 'read' | 'write' | 'destructive';
  confirm?: string;              // 只给 destructive：确认框里的话
  input?: I;                     // 一组 schema-config 字段
} & (
  | { row: true; handler(args: { rowKey: string; input; ctx: C }): ActionResult }
  | { row?: false; handler(args: { input; ctx: C }): ActionResult }
);

type ActionResult = string | void | Promise<string | void>;
```

- **效果：** 按钮样式与确认由 `effect` 推出。插件页面里的按钮一律是次要或文字按钮，不画主要按钮；`destructive` 用危险色字，由宿主弹确认框（文案取 `confirm`，不写时是「这个操作不能撤销。」；带输入的在表单里写同一句警示），插件不能自己画确认框。`write` 与 `destructive` 的每次调用，宿主记一行 info 日志（动作名、效果、实例、页面与来源地址）。
- **行动作：** `row: true` 的动作只能放在表格的 `rowActions` 与详情里的 `actions` 组件里，处理函数收到那一行的 `rowKey`，按它重新查，不信任界面回传的整行；其余动作只能放在页面最外层与标签里的 `actions` 组件里。
- **输入：** 声明了 `input` 的动作，点了按钮弹一个小表单，提交时值交给处理函数。行动作的表单里，与行字段同名的输入项用这一行的值预填，「编辑」就这样做。新建与编辑都用它，没有单独的表单组件。处理函数收到的 `input` 按声明的字段推出类型（静态选项的 `select` 推为选项值的联合），宿主已按字段校验、解析并补上默认值。
- **结果：** 成功时可以返回一句话，宿主用 Toast 显示；失败就抛错，原因显示给操作的人。返回别的（对象、数字）按失败处理并记告警。
- **长动作：** 按钮显示「进行中」，宿主不设短超时；结果变了由插件 `invalidate`。

### 数据与刷新

数据源与处理函数收到 `ctx`：`{ caller }`，会话面板另有 `sessionId`（见下）。数据源可以同步返回，也可以返回 Promise；抛错时那一块显示出错，原因原样给界面，不影响页面的其他组件。

页面打开时取一次数，标题栏另有手动刷新。插件在数据变化处调 `definePage` 返回的 `invalidate(componentId?, sessionId?)`：不写 `componentId` 是整页，带 `sessionId` 时只有打开着这个会话的面板重取。宿主按实例、页面、组件与会话合并短时间内的连发：同一组一秒内最多推一次，窗口里再来的并成窗口结束时的一次。数据靠外部变化的（例如手改了文件），靠打开时取一次加手动刷新。

### 会话面板

位置为 `session` 的页面是会话右侧面板的标签。

- **适用：** `applies(session)` 收到 `{ sessionId, kind }`，`kind` 是会话种类（`'owner' | 'room' | 'task'`，与会话设置项的 `appliesTo` 同一个来源）；不写就适用于全部会话。插件按自己的数据判断，例如没开白纸的群返回 `false`。宿主按会话一次算完适用的页面；`applies` 抛错、超过 2 秒或没回布尔值都按不适用处理，记一条告警，不拖垮整个列表。界面在切换会话、收到 `plugins.changed`，或收到这一页带本会话或不带会话的 `page.invalidate` 时重取。
- **会话上下文：** `ctx.sessionId` 由宿主单独给出，不从参数里取。数据源与动作每次调用前，宿主经会话管理核这个会话存在，把规范化后的 id 交给插件。会话管理服务不在时，会话面板的调用回 503。
- 打开哪些面板由用户决定：默认一个都不打开；从「+」打开后进布局记录、在所有适用的会话里出现，可以关闭与排序，与宿主自己的标签（计划、设置、用量）同一套（见下文「布局记录」）。

### 质量门槛

webui-server 登记时整份核一遍，不过就不登记并记一条错误日志（列出每个问题与位置）：

- 一屏（页面最外层、一个标签、一个详情）最多 `MAX_SCREEN_COMPONENTS`（6）个组件，最多 `MAX_PAGE_TABS`（6）个标签；一屏、一页至少一个；
- 标签页只在最外层，标签里不再套标签；详情里的组件不再带详情；
- 组件 id 在页面内唯一，标签的 key 在页面内唯一，表格的列 key 不重复，关系图的类别不重复；
- `actions`、`rowActions` 引用的动作都已声明，行动作只放在行上与详情里，页面动作只放在最外层与标签里；
- `icon` 只收 lucide 图标名（小写字母、数字与连字符），内联 SVG 一类的标记拒收；`applies` 只给会话面板，`confirm` 只给 `destructive` 且不能为空，`tone` 只有 1 到 6；
- 不认识的字段一律拒收，第一版的写法（定时刷新、按钮的危险样式、按名引用的数据源、列上的取文件方法，以及统计、表单与标签页组件）都在这里被拦下。

`visibleWhen` 指名的是行字段，登记时还没有行，取数时核：每一行都要有这个字段且是布尔值，不是就当数据源返回的形状不对。数据源返回的形状不对（表格行缺 `rowKey` 或重复、图片与文件列的值不是存储地址、关系图的边连着不存在的节点、文字不是字符串等），这一块回 500 并记告警。

### 窄宽度

宿主统一变形，插件不写任何窄屏专用的东西：表格只显示标了 `primary` 的列，动作收进「更多」；带详情的表格与关系图变成两级，先列表、点进去看详情；标签页横向滚动；关系图可以缩放查看；表单变成单列。手机上确认框、选择器与动作的输入表单从底部弹出。

## 提示

```ts
interface Notice {
  id: string;                       // 本插件实例内唯一；同一个 id 再发一次就是替换
  level: 'action' | 'error';        // 需要你处理、出错
  title: string;                    // 数量写进标题，例如「3 件作品待裁决」
  detail?: string;
  open?: 'config' | { page: string }; // 去本插件的配置，或打开本插件位置为 plugin 或 settings 的页面
}
```

- 出现在「需要处理」与插件详情，每条计 1。跳转按钮的文字由宿主推出：「去配置」或「打开 <页面标题>」。
- 归属这次激活，插件停用就撤回；只能由插件自己 `clear`，问题没解决就一直在，没有用户忽略。
- 插件不能弹 Toast：Toast 只回报用户自己操作的结果，后台的事走提示。
- 第一次使用时模型插件缺密钥起不来这类故障，由宿主推导的插件故障覆盖，不靠提示。

## 页面与布局的路由

都要登录，改状态的请求校验来源（见 [plugin-webui-server](../plugins/plugin-webui-server.md) 的「改状态的请求校验来源」）。路径里的实例 id、页面 key、组件 id、动作名都要 `encodeURIComponent`（实例 id 可能带 `@`、`/` 与 `:`）。失败回 4xx 或 5xx 与 `{ error, issues? }`（`PageErrorResponse`）。

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/pages` | — | `{ pages: PageView[] }`：登记着的全部页面，声明去掉函数（数据源、处理函数、`applies`），加上所属实例 `instance`，`placement` 总是给出；按 `order`、实例、key 排好 |
| `GET /api/session-pages?sessionId=` | — | `{ pages: PageRef[] }`：这个会话适用的会话面板页面。会话不存在回 404 |
| `GET /api/pages/:instance/:pageKey/data/:componentId` | 查询参数只收 `sessionId`（会话面板必填）与 `rowKey`（详情里的组件必填） | `{ data }`，按组件种类见 `PageDataByType` |
| `POST /api/pages/:instance/:pageKey/actions/:action` | `{ sessionId?, rowKey?, input? }` | `{ message? }` |
| `GET /api/page-file?handle=` | — | 文件，一律当附件以 `application/octet-stream` 下发；句柄无效回 403，文件已不在回 404 |
| `GET /api/layout` | — | `LayoutRecords` |
| `POST /api/layout` | `LayoutOperation` | 改后的 `LayoutRecords` |

**服务端闸门：**

- 只许调页面声明过的组件与动作，按实例、页面与组件或动作分派；没有的回 404。
- 参数只收用得上的键：`sessionId` 只给会话面板，`rowKey` 只给详情里的组件与行动作，`input` 只给声明了输入的动作；多出的键回 400，该有的没有或不是非空字符串回 400。行动作只收 `rowKey`，不收整行。
- `input` 按声明的字段校验类型、必填与可选项，拒收多余的键；没过时 `issues` 逐项列出（与 `validateConfig` 的问题同形）。过了的按字段解析（数字字符串转成数字等）并补上默认值，再交给处理函数。
- 会话面板的 `sessionId` 经会话管理核过存在再传，见上文。
- 确认框只是界面上的交互，服务端的闸门是 owner 身份加改状态请求的来源校验。

**界面收到的数据：** 表格的行里，`image` 列已换成 `/api/media` 地址，`file` 列已换成 `FileCell`（`{ name, handle? }`），其余原样（`PageRow`）。

### 布局记录

owner 的界面布局：图标栏上固定的页面与会话面板的标签，都按 owner 排的顺序。存在 webui-server 的插件数据里，跟着 owner 走，换设备、换浏览器一致，在所有会话里生效；只有 owner 能读写。

```ts
interface PageRef { instance: string; pageKey: string }
const HOST_PANEL_TABS = ['plan', 'settings', 'usage'] as const;  // 宿主的标签：计划、设置、用量
type HostPanelTab = (typeof HOST_PANEL_TABS)[number];
type PanelTabRef = { host: HostPanelTab } | PageRef;
interface LayoutRecords {
  pinned: PageRef[];
  panelTabs: Array<{ tab: PanelTabRef; open: boolean }>;
}
type LayoutOperation =
  | { op: 'pin' | 'unpin' | 'move-up' | 'move-down'; page: PageRef }
  | { op: 'open-tab' | 'close-tab' | 'tab-up' | 'tab-down'; tab: PanelTabRef };
```

- **会话面板的标签：** 宿主的标签与插件的会话面板（位置为 `session` 的页面）在同一张表里，同一套写法。宿主的标签是封闭集合 `HOST_PANEL_TABS`，每个对应会话协议里的一类数据，由宿主按数据画、不走页面登记，以后按加法加。界面把表里开着、此刻可用的排成标签栏，关着的与适用、还没进表的插件页面列在「+」里；宿主标签按数据出现（计划要有计划条目，设置总有，用量要有用量数据），插件标签要这个会话适用。
- **读出时：** 宿主标签缺哪个，就按 `HOST_PANEL_TABS` 的顺序补在末尾、开着，新记录因此是计划、设置、用量都开着，以后加的宿主标签对已有的记录也出现。认不出的宿主标签与形状不对的条目丢掉，重复的留第一个。
- 按操作写，不整份覆盖：两台设备同时改，各自的操作都生效。请求体只收两个键：`pin`、`unpin`、`move-up`、`move-down` 带 `page`，`open-tab`、`close-tab`、`tab-up`、`tab-down` 带 `tab`；`instance` 与 `pageKey` 是 1 到 512 个字符。
- `pin` 只收此刻登记着、位置为 `plugin` 的页面；`open-tab` 打开插件标签时只收此刻登记着、位置为 `session` 的页面。页面不存在回 404，位置不对回 400。其余只动记录，所属插件停用时也能做。
- `open-tab` 把表里的标签设为开，插件标签第一次打开时追加在末尾；`close-tab` 设为关，位置保留，再打开回到原位；`tab-up`、`tab-down` 与表里的邻居对调。
- 已固定的再固定、挪到头的、取消没固定的、关掉没进过表的都不变，回原记录、不推事件。每个列表最多 `MAX_LAYOUT_ENTRIES`（50）条，会话面板的标签连同宿主标签算，满了回 409。
- 所属插件停用或卸载时记录保留，界面按当前的页面表决定显示哪些；重新启用后回来。
- 记录变了经 `/admin` 推 `layout.changed`，各设备重取。存储服务不在时回 503；落盘失败回 500，记录不变。

## 前端提供者

`WebuiClientProvider`：`getClientDir()` 返回含 `index.html` 的静态目录。两条接入：

- **纯静态包**：`package.json` 标 `aalis.client: true` + 含 `dist/index.html`，被 webui-server 自动发现挂载（无需 `apply`）。
- **主动覆盖**：插件 `apply` 里 `provide(webuiClient, impl, { label })`，展示名优先取提供方插件的 `displayName`，没有时取 provide 的 `label` 选项。`onBehalfOf` 代登记归属被代者身份，不计入代理人 `provides`。

## 管理面推送（/admin）

会话之外的推送走 WebUI 的 WebSocket 端点 `/admin`，与会话协议的 `/session`（见 [api-session-protocol](./api-session-protocol.md)）分开，校验相同：浏览器发起的握手要与 WebUI 同源，跨源回 403；升级请求带登录 cookie，没登录或 token 不对回 401（详见 [plugin-webui-server](../plugins/plugin-webui-server.md) 的「WebSocket」一节）。浏览器对同一主机的 HTTP/1.1 连接数有上限（约 6 条，所有标签页共用），WebSocket 不占这个上限，开多少个标签页 REST 请求都不会因此排队。

每个文本帧是一个 JSON 对象，`type` 区分种类。本包只给类型，前端导入类型即可，服务端不校验自己发出的帧：

```ts
/** 前端发往 /admin */
type WebuiAdminClientMessage = { type: 'log.subscribe' } | { type: 'log.unsubscribe' };

/** /admin 推给前端 */
type WebuiAdminEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'plugins.changed' }
  | { type: 'page.invalidate'; instance: string; pageKey: string; componentId?: string; sessionId?: string }
  | { type: 'layout.changed' }
  | { type: 'app.restarting' }
  | { type: 'client.reload' };
```

| 事件 | 字段 | 推给谁 | 前端怎么办 |
|---|---|---|---|
| `log` | `entry`：`{ seq, timestamp, level, scope, message }`，与 `GET /api/logs/tail` 返回的条目同形 | 订阅了日志的连接 | 追加到日志列表 |
| `plugins.changed` | 无 | 全部连接 | 插件状态可能变了（启停、装卸、激活成败之后），或页面登记表变了（插件登记或撤回页面）：重取 `GET /api/plugins` 与 `GET /api/pages`。一次启停可能连着推几条，服务端不合并，前端合并成一次重取。打开着的页面所属插件停用时，主区显示占位；页面重新登记后回到原页 |
| `page.invalidate` | `instance`、`pageKey`，可选 `componentId`、`sessionId` | 全部连接 | 插件说这一页的数据变了：打开着这一页的界面重取，带 `componentId` 时只重取这个组件，带 `sessionId` 时只有打开着这个会话的面板重取。页面登记时宿主也推一次整页的（插件重载时撤回与重新登记几乎同时，界面不一定看得到页面不在的那一刻）。服务端按这四项合并：同一组一秒内最多推一次 |
| `layout.changed` | 无 | 全部连接 | 布局记录变了：重取 `GET /api/layout` |
| `app.restarting` | 无 | 全部连接 | 应用即将重启，连接随后断开：提示正在重启，稍后重连 |
| `client.reload` | 无 | 全部连接 | 前端偏好改了，或有前端包被卸载，活跃前端可能换了：整页重新加载 |

- **断线重连**：事件只是「变了」的信号，断线期间丢的不补发。重连后重取插件与页面、布局记录和当前打开的页面；日志页开着时重新订阅。
- **日志**：日志页打开时发 `{ type: 'log.subscribe' }`，离开时发 `{ type: 'log.unsubscribe' }`；订阅与退订不回执。先发订阅、再取 `GET /api/logs/tail`，两边按 `seq` 去重；更早的日志用 `GET /api/logs/range` 往前翻。
- **认不出的消息**（不是 JSON，或 `type` 不认识）：服务端记一行告警后忽略，连接照常。
- 平台连接状态没有变化事件，页面打开时取一次 `GET /api/platforms`，配手动刷新。
- 连接的心跳与关闭码见 [plugin-webui-server](../plugins/plugin-webui-server.md) 的 WebSocket 一节。

浏览器里的前端：

```ts
import type { WebuiAdminClientMessage, WebuiAdminEvent } from '@aalis/api-webui';

const admin = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/admin`); // 同源，cookie 自动带上
admin.onmessage = event => {
  const e = JSON.parse(event.data) as WebuiAdminEvent;
  if (e.type === 'plugins.changed') refetchPluginsAndPages();
};
// 日志页打开时
admin.send(JSON.stringify({ type: 'log.subscribe' } satisfies WebuiAdminClientMessage));
```

## 主题

一个主题是名字、种类（深或浅）与一套颜色令牌值，只改颜色，不改间距、圆角、字号与布局。主题文件是可交换的 JSON，内置主题就是随包带的这种文件（`packages/api-webui/src/themes/`），第三方主题照同一格式写，三者都经 `parseTheme` 校验。本节的格式与令牌表是公开契约，先标 experimental。

### 主题文件

```json
{
  "format": "aalis-theme",
  "version": 1,
  "name": "夜读",
  "kind": "dark",
  "colors": {
    "--color-bg": "#101012",
    "--color-accent": "rgb(120 90 230)"
  }
}
```

| 字段 | 说明 |
|---|---|
| `format` | 固定为 `THEME_FILE_FORMAT`（`aalis-theme`） |
| `version` | 格式版本，现为 `THEME_FILE_VERSION`（1）。令牌表改名时加一，旧版本的文件按版本迁移，迁不了的拒收并说明 |
| `name` | 1 到 40 个字，按纯文本显示 |
| `kind` | `dark` 或 `light` |
| `colors` | 令牌名 → 颜色。只收令牌表里的名字；值只认十六进制（3、4、6、8 位）、`rgb()` 与 `hsl()`（逗号或空格分隔，可带不透明度），命名色、`url()` 与样式文本一律拒收 |

没有别的字段，多出的字段同样拒收。没写的令牌按同种类的偏中性主题补齐。

```ts
function parseTheme(value: unknown): ThemeParseResult;

type ThemeParseResult = { ok: true; theme: Theme } | { ok: false; errors: string[] };

interface Theme {
  name: string;
  kind: 'dark' | 'light';
  colors: Record<ThemeToken, string>; // 每个令牌都有值
}
```

`value` 是已按 JSON 解析的对象。不合格式时 `errors` 列出全部原因（如「--color-bg 的值不是颜色：url(...)」「--evil 不在令牌表里」）；格式名或版本不对时只给这一条。

### 内置主题

`BUILTIN_THEMES` 的键是主题 id（配色名加种类），值是主题文件：

| 配色 | 深色 | 浅色 |
|---|---|---|
| 偏中性 | `calm-dark` | `calm-light` |
| 品牌柔和 | `aalis-dark` | `aalis-light` |
| 文档站原色 | `brand-dark` | `brand-light` |
| 安静中性 | `neutral-dark` | `neutral-light` |

`DEFAULT_THEMES` 是跟随系统时的默认：深色用 `calm-dark`，浅色用 `calm-light`，也是补齐缺失令牌的来源。

### 令牌表

`THEME_TOKENS` 列出全部颜色令牌，名字就是 CSS 自定义属性名，界面的样式只引用这些名字：

| 令牌 | 用途 |
|---|---|
| `--color-bg`、`--color-bg-side`、`--color-bg-rail` | 主区；左栏与右侧面板；图标栏 |
| `--color-surface-raised` | 浮在内容上的：菜单、弹出层、对话框、Toast |
| `--color-fill-1`、`-2`、`-3` | 半透明的叠加底：悬停与代码块；选中行、用户消息、次要按钮；次要按钮的悬停 |
| `--color-border`、`--color-border-control` | 分隔线；输入框与复选框的外框 |
| `--color-text`、`-2`、`-3`、`--color-text-disabled` | 正文；次要字与图标；弱化字；不可用 |
| `--color-accent`、`--color-accent-hover`、`--color-on-accent` | 主按钮的底、悬停与上面的字（危险按钮上的字同用 `on-accent`） |
| `--color-accent-text`、`--color-accent-subtle`、`--color-focus` | 链接与强调字；选中标签的浅底；焦点环 |
| `--color-mark` | 金色标记：需要处理的圆点、当前项的指示条 |
| `--color-danger`、`--color-danger-hover` | 确认框里的危险按钮 |
| `--color-danger-text`、`--color-danger-subtle` | 出错的文字与浅底 |
| `--color-warning-text`、`--color-warning-subtle` | 需要处理、警告的文字与浅底 |
| `--color-success-text`、`--color-success-subtle` | 成功的文字与浅底 |
| `--color-scrim`、`--color-shadow` | 对话框后的遮罩；浮层的投影 |
| `--color-chart-1` 到 `-6` | 关系图等图表的分类色 |
| `--color-syntax-keyword`、`-string`、`-number`、`-comment`、`-function`、`-type` | 代码高亮 |

### 对比度检查

```ts
function themeContrastIssues(theme: Theme): ContrastIssue[];

interface ContrastIssue {
  pair: string;    // 组合名，如「弱化字 / 侧栏里的选中行」
  ratio: number;   // 算出的对比度，保留两位小数
  minimum: number; // 要求
}
```

按 WCAG 2 的公式检查一张固定的组合表，半透明的底色先叠到下层再算：文字（正文、次要字、弱化字在主区、侧栏、选中行与浮层高亮项上，链接，主按钮与危险按钮上的字，出错、警告、成功的文字在主区与各自浅底上，图标栏上的次要字，代码高亮）要求 4.5；焦点环、输入框外框、图表色、图标栏当前项上的图标、金色标记对主区、侧栏、图标栏与选中行要求 3。内置主题全部通过（`test/plugins/webui-theme.test.ts`）；导入主题时用同一张表，不达标的列出并提示。

## 实现者

- [@aalis/plugin-webui-server](../plugins/plugin-webui-server.md) — 后端服务 + 静态文件托管
- `@aalis/plugin-webui-client` — 前端 React 应用（独立发布）

## 相关

- ConfigSchema 来自 `@aalis/schema-config`（含 `secret` 在内的字段属性都由它声明）
- 会话里的工具调用、用量等条目经会话协议推送，见 [api-session-protocol](./api-session-protocol.md)
- 会话种类与 `sessionKind` 见 [api-session-manager](./api-session-manager.md)
