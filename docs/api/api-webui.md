# api-webui — WebUI 服务、页面与管理面契约

**包名**: `@aalis/api-webui`  
**源码**: `packages/api-webui/src/index.ts`（服务、登记门面、「需要处理」、管理面推送）、`packages/api-webui/src/page.ts`（页面与提示）、`packages/api-webui/src/frame.ts`（插件前端的消息通道）、`packages/api-webui/frame/`（插件前端的助手与样式基线，浏览器里运行）、`packages/api-webui/src/rest.ts`（管理面 REST）、`packages/api-webui/src/theme.ts`（主题）  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、按激活绑定的登记门面、页面与提示、插件前端的消息通道、管理面推送的事件类型、管理面 REST 的路由与类型，以及主题的令牌表与主题文件格式。契约包是 MIT：第三方前端只依赖它，照本页实现页面的渲染、调用、布局记录与管理面。本页的页面契约、消息通道与路由先标 experimental。

页面默认声明式，需要自绘时用插件前端（见下文「插件前端」）。声明式页面只交声明：插件在 `apply` 里经 `webuiServer` 的 `definePage` 一次交出组件、数据源与动作的处理函数，经 `notify` 发提示；样式、窄屏变形、确认框与输入表单都由宿主统一画。登记归属这次激活，插件停用时同一拍撤回。

`GET /api/plugins` 的 `requiredServices` / `optionalServices` 是插件 `uses` 声明按是否包 `optional()` 拆出的服务名，包含 core 内置服务（`events` / `lifecycle` / `logger` / `config` / `provide` / `services`）。这些内置服务和宿主服务（`app` / `plugins` / `host-config` 等）由根激活登记，与第三方服务一样是普通提供者：`/api/services` 里以「宿主」为提供者列出；插件声明了它们同样要经过激活闸，只是这些服务在加载插件前已就绪。经 `services` 动态查询获得的服务不在声明列表中。

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
  definePage<
    const P extends PagePlacement = 'plugin',
    const S extends Record<string, unknown> = Record<never, never>,
    const R extends Record<string, unknown> = Record<never, never>,
  >(page: PageDefinition<P, S, NoInfer<keyof S & string>, R>): PageHandle;
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

`PageDefinition` 是声明式页面（`DeclarativePageDefinition`，写 `content`）与插件前端页面（`FramePageDefinition`，写 `frame`，见下文「插件前端」）的联合，二者只能写一个。声明式页面：

```ts
interface DeclarativePageDefinition<P, S, A> {
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

## 插件前端

声明式页面是默认。声明式表达不了的页面，插件可以自带一份静态网页（插件前端）：由 webui-server 托管，宿主把它画进 iframe，与宿主页面不同源。它拿不到登录状态，发不出网络请求、取不到外站资源；跳转、WebRTC 与 preconnect 仍可能把数据带出去（见下文「托管与隔离」的残余）。要数据与执行动作只能经消息通道请宿主代办，且只能调这一页声明过的数据源与动作，走与声明式页面同一道服务端闸门。

位置只有插件页面（`plugin`）与会话面板（`session`），设置不收插件前端。

### 声明

```ts
webui.definePage({
  key: 'board',
  title: '看板',
  icon: 'layout-grid',
  frame: {
    module: import.meta.url,   // 声明这个页面的模块地址
    entry: 'index.html',       // 包根下 webui/ 里的入口，不写为 index.html
    host: ['sessions:read'],   // 申请的宿主数据能力，不写就没有
  },
  sources: {
    cards: { data: () => listCards() },
    card: {
      input: { id: { type: 'string', label: '卡片', required: true } },
      data: ({ input }) => getCard(input.id),
    },
  },
  actions: {
    archive: {
      label: '归档',
      effect: 'destructive',
      input: { id: { type: 'string', label: '卡片', required: true } },
      handler: ({ input }) => archive(input.id),
    },
  },
});
```

- **`frame.module`**：写 `import.meta.url`。webui-server 从这个文件所在目录往上找最近一个带 `name` 字段的 `package.json`（双格式构建放在 `dist/esm/` 里、只写 `type` 的那种跳过），它的 `name` 要等于插件名（实例 id 第一个「:」之前的部分），那一层就是插件包根。只托管包根下 `webui/` 目录里的文件，插件不能指定别的目录。
- **`frame.entry`**：`webui/` 下以 `.html` 结尾的相对路径，不以 `/` 开头，各段非空、不以点开头。
- **`frame.host`**：申请的宿主数据能力，从词表里选、不重复，见下文「宿主数据能力」。
- **`sources`**：只给插件前端。每个数据源有可选的 `input`（写法与校验同动作的 `input`）与 `data({ input, ctx })`，`data` 返回能转成 JSON 的值。
- **`actions`**：与声明式的动作同一个定义，只是不收 `row`：插件前端里没有宿主画的表格行，要指定对象就放进 `input`。`destructive` 的由宿主弹确认框。
- `applies`、`order`、`icon`、`ctx` 与声明式相同；`invalidate(name?, sessionId?)` 的第一个参数是数据源名。
- 同时写 `content` 与 `frame` 或两样都不写、插件前端写 `placement: 'settings'`、动作写 `row`、`host` 写词表之外的名字，都在编译期报错。

插件包的样子（`package.json` 的 `files` 里要带上 `webui`）：

```text
<包根>/package.json      "files" 里加上 "webui"
<包根>/webui/index.html  入口
<包根>/webui/…           构建好的脚本、样式、图片、字体
```

插件前端只有一个文档，资源用相对路径引用；页面内的切换只用内存里的状态，不改地址。

**登记时校验：** `content` 与 `frame` 恰好一个；`frame` 只认 `module`、`entry`、`host`；位置是 `plugin` 或 `session`；`host` 都在词表里、不重复；数据源的名字非空、各有 `data` 函数、`input` 是合法的字段表；动作不带 `row`；数据源名与动作名不超过 `FRAME_NAME_MAX_LENGTH`（128）个字符，更长的名字插件前端发不出来；`module` 是 `file:` 地址、找得到名字相符的包根、`webui/` 是目录、入口文件存在且按 realpath 落在 `webui/` 之内。不认识的字段照旧一律拒收。不过就不登记，记一条错误日志写明原因。

### 界面收到的样子

`GET /api/pages` 里的插件前端页面（`FramePageView`）不带 `content` 与数据源，带：

- `frame: { src, host }`：`src` 是宿主签发的框架地址 `/frames/<token>/<入口>`，`host` 是申请的能力；
- `actions`：与声明式相同的 `ActionView`，宿主据它决定确认框。

不下发插件包的本机路径（`module`）与单独的 `entry` 字段，入口已含在 `src` 里。数据源与动作走下文「管理面 REST」的「页面与布局」里取数与动作两条路由：数据源名放在 `componentId` 的位置，`input` 以 JSON 字符串放在查询参数里；动作的请求体不收 `rowKey`。数据源返回不能转成 JSON 的值时回 500 并记告警。

### 托管与隔离

- `GET /frames/:token/<路径>`：插件前端的文件。`token` 是页面登记时随机生成的 128 位标识（base64url），页面撤回或重新登记后旧的回 404；地址变了界面就重新挂载，插件升级后不会读到旧缓存。不要登录：`token` 只出现在要登录的 `GET /api/pages` 里，文件是随包发布的代码，不含数据。
- `GET /frames/_base/<路径>`：宿主给框架的公用文件，随本包发布，只有助手 `frame.js` 与样式基线 `frame.css`（见下文「助手」「样式基线」）。
- 只收 `GET` 与 `HEAD`，别的方法回 405。扩展名只有 `html`、`js`、`mjs`、`css`、`svg`、`png`、`jpg`、`jpeg`、`gif`、`webp`、`woff2`；文件要按 realpath 落在 `webui/` 之内，指向外面的符号链接也算越界；点开头的段、目录与其余不合的一律 404，不回目录列表、不发 3xx。
- 响应头：框架 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-DNS-Prefetch-Control: off`、`Access-Control-Allow-Origin: *`（框架是不透明来源，模块脚本连取自己目录下的文件也走 CORS）、`Cache-Control: no-cache`（用 ETag 再验证）。
- 框架 CSP，`<Host>` 是请求的 Host 去掉默认端口 `:80`、`:443`：

  ```text
  sandbox allow-scripts; default-src 'none'; script-src <Host>/frames/<token>/ <Host>/frames/_base/; style-src <Host>/frames/<token>/ <Host>/frames/_base/ 'unsafe-inline'; img-src <Host>/frames/<token>/ data: blob:; font-src <Host>/frames/<token>/ data:; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <Host>
  ```

  来源写成带路径、不带协议的来源：只放行这一页自己的目录，http 访问与经 TLS 代理的 https 访问都成立。Host 只收主机名或 IPv4 地址加可选端口；IPv6 字面地址写不进 CSP 的来源，与带非法字符的一样回 400。经反向代理访问时，代理要把原始的 Host 转过来。
- 宿主的 iframe 带 `sandbox`，值是 `FRAME_SANDBOX`（`'allow-scripts'`），与 CSP 的 `sandbox` 指令同一个常量：不给同源、表单、弹窗、原生对话框、顶层跳转与下载。框架读不到 cookie 与浏览器存储，碰不到宿主页面；发不出 fetch、XHR、WebSocket 一类请求，取不到外站的脚本、样式、图片。别人把框架地址当顶层页面打开，它照样是不透明来源。
- **残余：** 跳转、WebRTC 与 preconnect 仍可能把数据带出去。WebRTC 能连任意主机的 STUN、TURN（CSP 的 `webrtc` 指令，当前的 Chromium 不认）。`<link rel="preconnect">`（写在标记里或由脚本插入）不受 CSP 约束，本地 Chrome 实测框架里的 preconnect 能向任意主机建立 TCP 连接；主机名的 DNS 解析也可能把数据带出去，`X-DNS-Prefetch-Control: off` 不能保证拦住。框架能让自己跳到别的地址：沙箱挡不住框架自我导航，注入的 `<meta http-equiv="refresh">` 不需要脚本；宿主在它离开时立即卸载（助手在 `pagehide` 时发 `leaving`，第二次 `load` 兜底），但跳到不返回页面的地址（例如回 204）时察觉不到，新页面开始显示到卸载之间也有一小段。

### 消息通道

宿主与框架之间只用 `postMessage`。框架先在窗口上发 `hello`，宿主核过来源窗口、随机数与主版本，经 `MessageChannel` 交给框架一个专用端口，之后的消息都走这个端口。版本常量 `FRAME_PROTOCOL_VERSION`（`'1.0'`），写法与 `SESSION_PROTOCOL_VERSION` 相同；第一版标 experimental，只做加法，加字段、加消息升次版本。实例、页面与会话面板的会话一律取宿主挂载时的值，消息里没有这些字段，带了就是多余的键。

**框架 → 宿主**（请求带 `id`：框架自选的整数，在途的不重复；宿主回 `result`）

| type | 字段 | 成功时的 `value` |
|---|---|---|
| `hello` | `protocol`、`nonce` | 窗口消息，宿主回 `init` 与端口 |
| `data` | `id`、`source`、`input?` | 数据源的值 |
| `action` | `id`、`action`、`input?` | 处理函数给的一句话，或 `null` |
| `open` | `id`、`target`：`{ url }`（只许 http、https）或 `{ session }` | `null` |
| `sessions.list` | `id`、`parentId?`、`archived?`、`cursor?`、`limit?` | `{ sessions, nextCursor? }` |
| `turn.abort` | `id`、`sessionId`、`turnId?` | `null` |
| `leaving` | — | 框架文档正在被替换，不回 |

**宿主 → 框架**

| type | 字段 | 什么时候 |
|---|---|---|
| `init` | `protocol`、`experimental: true`、`sessionId?`（会话面板）、`theme` | 握手时随端口交出 |
| `result` | `id`，以及 `ok: true, value` 或 `ok: false, error: { code, message }` | 回每个请求 |
| `theme` | `kind`（`dark`、`light`）、`tokens`（主题令牌名到值） | 主题切换，或跟随系统时深浅变了 |
| `invalidate` | `source?` | 数据变了；带 `source` 时只重取这个数据源。会话或管理连接重连后宿主推一次不带 `source` 的，意思是全部重取（含会话列表） |
| `sessions.changed` | `upserts`、`removes` | 申请了 `sessions:read` 的框架挂载起就收 |

**错误码**（`FrameErrorCode`，封闭集合）：

| code | 含义 |
|---|---|
| `invalid` | 消息或输入不对；转发的 HTTP 400、414、431 |
| `denied` | 没申请的能力；这个框架已开着一个宿主对话框时再请求外链或要确认的动作 |
| `not-found` | 页面、会话、数据源或动作不在；HTTP 404 |
| `busy` | 超出在途上限 |
| `cancelled` | 用户在宿主的确认框或外链对话框里取消 |
| `unavailable` | 会话服务不在、连接断开；HTTP 503 与连不上 |
| `failed` | 插件的处理函数或宿主服务出错（其余 4xx 与 5xx），`message` 写原因 |

**校验函数：** `parseFrameHello(value)` 与 `parseFrameMessage(value)` 是不碰 DOM、不依赖 zod 的纯函数，宿主前端与第三方宿主前端共用，换前端时规则不漂。它们核类型标记、字段类型、多余的键、字符串长度（名字 `FRAME_NAME_MAX_LENGTH` 128 个字符，会话 id、回合 id、游标与随机数 `FRAME_ID_MAX_LENGTH` 256 个，地址 `FRAME_URL_MAX_LENGTH` 2048 个）、`input` 是对象、`open` 的地址是 http 或 https 的绝对地址，回 `{ ok: true, message }` 或 `{ ok: false, id?, problem }`：认得出请求 `id` 时一并给出，宿主据它回 `invalid`、不往下走。不合格的 `hello` 一律忽略。来源窗口、随机数、主版本，以及外链是否与宿主同源，由宿主另核。

**宿主的处理规则：** 上限、对话框与卸载涉及界面与计时，不在校验函数里，各宿主前端照下面实现（默认前端的写法见 [plugin-webui-client](../plugins/plugin-webui-client.md) 的「插件前端」一节）：

- 握手只认一次：来源窗口是这个框架、来源是 `null`、随机数对得上的第一个 `hello`。握手完成前框架不可见；第一次 `load` 之后 10 秒内没有合格的 `hello` 算没有响应。
- 在途请求最多 8 个，超了回 `busy`；每秒最多收 200 条消息，超了卸载框架。
- 动作按这一页 `PageView` 的 `actions` 找，找不到回 `not-found`、不发请求；`destructive` 先由宿主弹确认框，框里按输入字段列出这次的值。外链经宿主的对话框，由用户点真实的链接打开。宿主对话框同一个框架同一时刻只一个，开着时再请求的回 `denied`；确认不默认聚焦，对话框显示后 500 毫秒内不接受确认（按点按事件发生的时刻 `timeStamp` 算，主线程忙时排队晚到的点按也拦下）；连续被取消 3 次就卸载框架。经过确认框的动作由宿主另用 Toast 显示结果，其余的结果只回给框架。
- 收到 `leaving` 或第二次 `load` 立即卸载。卸载时关端口、撤监听、在途的结果不再转回、关掉它弹出的对话框、清计时器。

### 宿主数据能力

插件前端可以在 `frame.host` 里申请读宿主数据、做通用会话动作的能力。词表 `FRAME_HOST_CAPABILITIES` 是封闭集合，按加法扩；不申请就没有。宿主照声明转发，走的是宿主自己的界面用的同一条会话协议与同一道服务端闸门，不为插件前端另开接口。申请了的框架能列任何会话、停任何会话的回合，与 owner 自己的界面相同。

| 能力 | 显示为 | 允许的请求与推送 | 经哪条现有协议 |
|---|---|---|---|
| `sessions:read` | 读会话树与状态 | `sessions.list`；挂载起推 `sessions.changed` | 会话协议 `sessions/list`（只透传 `parentId`、`archived`、`cursor`、`limit`，回包去掉 `groups`）；`sessions.changed` 取自宿主已有的 `sessions/changed` 订阅，去掉 `groups` |
| `turn:abort` | 停止会话的回合 | `turn.abort` | 会话协议 `turn/abort` |

能力表 `FRAME_REQUIRED_CAPABILITY` 给出每种请求与推送要的能力（`data`、`action`、`open` 为 `null`，不要能力）。宿主转发请求前按页面的 `frame.host` 核，没申请的回 `denied`；推送只发给申请了的框架。读会话的时间线、应答审批、发消息、改设置、建删会话与文件媒体都不给。

### 助手

`GET /frames/_base/frame.js` 是给插件前端用的浏览器 ES 模块，源码在本包的 `frame/`，按浏览器环境单独编译，与本包同版本发布，由 webui-server 托管。插件前端直接导入，不用构建：

```js
import { connect } from '/frames/_base/frame.js';

const frame = await connect();
const cards = await frame.data('cards');
frame.onInvalidate(source => { /* 重取 source 这个数据源；没带 source 时全部重取 */ });
```

`connect()` 给出的连接（类型 `FrameClient`，从 `@aalis/api-webui` 导入）：

| 成员 | 做什么 |
|---|---|
| `sessionId` | 会话面板挂在哪个会话上；插件页面没有 |
| `data(source, input?)` | 取这一页一个数据源的数据 |
| `action(name, input?)` | 调这一页的一个动作，回处理函数给的一句话或 `null`；`destructive` 的由宿主先弹确认框 |
| `open({ url })`、`open({ session })` | 请宿主打开外站地址（经宿主的对话框，由用户点开）或应用内的会话 |
| `onInvalidate(listener)` | 数据变了：带数据源名时只重取它，不带时全部重取。回退订 |
| `listSessions(params?)`、`onSessionsChanged(listener)` | 列会话、收会话列表的增量（要 `sessions:read`） |
| `abortTurn({ sessionId, turnId? })` | 停止一个会话的回合（要 `turn:abort`） |

- 请求失败时抛出 `Error`，带 `code`（上文的错误码）。用户在宿主的确认框里取消是 `cancelled`，不算出错。
- 握手：从地址片段读出随机数发 `hello`，片段不清（清片段会往会话历史里加条目）；只认来自 `window.parent`、带一个端口的第一个 `init`，之后只用这个端口；10 秒等不到 `init`，或 `init` 里的 `theme` 不是带 `tokens` 的对象时，`connect()` 报错。`connect()` 调多次是同一个连接。
- 主题：收到 `init` 的同一拍把主题令牌写到根元素的内联样式上，设 `data-theme`（`dark` 或 `light`）与 `color-scheme`，收到 `theme` 时更新。
- 在 `pagehide` 时经端口发 `leaving`。不画界面，不缓存数据，不改地址。
- 宿主前端与助手不一定同版本，兼容靠握手的主版本检查与只做加法。用 TypeScript 写插件前端时，在项目里任意一个 `.d.ts` 中给这个地址补一条模块声明。以 `/` 开头的名字 TypeScript 当作相对模块名、不能直接声明，所以写成通配：

  ```ts
  declare module '*/frames/_base/frame.js' {
    export function connect(): Promise<import('@aalis/api-webui').FrameClient>;
  }
  ```

  用打包工具时把这个地址设为 external，原样留给浏览器去取。

### 样式基线

`GET /frames/_base/frame.css` 是可选引用的样式基线：`<link rel="stylesheet" href="/frames/_base/frame.css">`。

- 只给元素级的样式：系统字体与 rem 尺寸的基础排版、链接、按钮（一种，与宿主的次要按钮一致）、输入框、表格、代码与焦点环；不设按类名选的变体，不用卡片、阴影与渐变。
- 按钮 28 像素高、字重常规；输入框与选择框 28 像素高。触屏上按钮外面多一圈 4 像素的透明边框，看得见的 36 像素，点按范围 44 像素，占排版位置；插件改写按钮的边框，或用简写的 `background` 换底色时，底色会铺满这 44 像素。触屏上输入框与选择框 44 像素高、字号 16 像素。
- 颜色只引用主题令牌（下文「主题」的令牌表），由助手写在根元素上，深浅跟着宿主。尺寸写在样式基线自己里面，取值与宿主界面相同；触屏（`pointer: coarse`）上的尺寸与减少动效时去掉过渡，都由它自己的媒体查询求值。宿主内部的尺寸令牌名不外露，`init` 与 `theme` 里只有主题令牌。
- 圆角用 `--radius-sm`、`--radius-md` 两个名字写默认值（4 像素与 6 像素）。

### 作者须知

- 宽度：插件页面跟着主区，会话面板约 340 像素，手机 390 像素。按容器宽度排版，尺寸用 rem，触屏可点区 44 像素，输入框字号不小于 16 像素（iOS 聚焦时不放大整页）。框架占满它的区域，内容在框架里自己滚动。
- 只有一个文档：页面内的切换只用内存里的状态，不改地址（History API 与片段都会往会话历史里加条目，手机上按返回会先退框架里的条目）。离开这个文档就会被卸载。
- 链接一律经 `open` 请宿主打开；要确认的操作交给动作的 `effect: 'destructive'`，由宿主弹确认框。
- 不受信的文本（群成员的昵称与消息、作品、网页标题）只用文本节点或转义后的输出插入，不当 HTML。注入的标记跑不了脚本，但仍能让框架跳走。
- 框架里做不到的：发网络请求、取外站资源；`eval`、worker 与 WebAssembly；浏览器存储（状态存在插件自己的数据里，经数据源与动作读写）；存储里的图片（只能用 `data:` 或打包进 `webui/`）；剪贴板写入多半也不可用。
- 宿主切走就卸载、切回来重新挂载，不保活；需要保留的状态由插件存在自己的数据里。

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

## 需要处理

「需要处理」是宿主汇总的一个列表，每项计 1：推给了审批面、还没结算的审批，插件故障（失败与缺服务的实例），插件的提示。经 `GET /api/attention`（要登录）给出，变了经 `/admin` 推 `attention.changed`，前端重取；首页摘要、插件详情、运行状况与标签页标题都读这一个列表，数目一致。

```ts
type AttentionItem =
  | { kind: 'approval'; id: string; sessionId: string; session?: string; tool: string } // session 是会话的标题
  | { kind: 'plugin'; instance: string; state: 'error' | 'pending'; error?: string; missing: string[] }
  | ({ kind: 'notice'; instance: string } & Notice);
interface AttentionResponse { items: AttentionItem[] }
```

- 顺序：审批在前，其后是插件故障与提示，各按先后。审批服务不在时没有审批这一类；会话管理不在或不认识这个会话时审批没有 `session`。
- 插件故障：`error` 是失败（带原因 `error`），`pending` 是缺服务；`missing` 是此刻没有提供者的 required 服务（失败的也可能有）。
- 跳转由前端按项推出：审批进它的会话；插件故障进插件详情；提示按 `open` 去配置或打开那个页面（按 `instance` 与页面 key 在 `GET /api/pages` 里找标题与位置），没有 `open` 的没有跳转。

## 页面的调用与布局

页面的声明、取数、动作与布局记录的路由见下文「管理面 REST」的「页面与布局」，这里写服务端怎样核这些调用。

**服务端闸门：**

- 只许调页面声明过的组件与动作，按实例、页面与组件或动作分派；没有的回 404。
- 参数只收用得上的键：`sessionId` 只给会话面板，`rowKey` 只给详情里的组件与行动作，`input` 只给声明了输入的动作与插件前端声明了输入的数据源；多出的键回 400，该有的没有或不是非空字符串回 400。行动作只收 `rowKey`，不收整行。插件前端数据源的 `input` 是一个 JSON 字符串，不是或解不开回 400。
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
  | { op: 'open-tab' | 'close-tab' | 'tab-up' | 'tab-down'; tab: PanelTabRef }
  | { op: 'remove-tab'; tab: PageRef };
```

- **会话面板的标签：** 宿主的标签与插件的会话面板（位置为 `session` 的页面）在同一张表里，同一套写法。宿主的标签是封闭集合 `HOST_PANEL_TABS`，每个对应会话协议里的一类数据，由宿主按数据画、不走页面登记，以后按加法加。界面把表里开着、此刻可用的排成标签栏，关着的与适用、还没进表的插件页面列在「+」里；宿主标签按数据出现（计划要有计划条目，设置总有，用量要有用量数据），插件标签要这个会话适用。
- **读出时：** 宿主标签缺哪个，就按 `HOST_PANEL_TABS` 的顺序补在末尾、开着，新记录因此是计划、设置、用量都开着，以后加的宿主标签对已有的记录也出现。认不出的宿主标签与形状不对的条目丢掉，重复的留第一个。
- 按操作写，不整份覆盖：两台设备同时改，各自的操作都生效。请求体只收两个键：`pin`、`unpin`、`move-up`、`move-down` 带 `page`，`open-tab`、`close-tab`、`tab-up`、`tab-down` 带 `tab`，`remove-tab` 只带插件标签（宿主标签回 400）；`instance` 与 `pageKey` 是 1 到 512 个字符。
- `pin` 只收此刻登记着、位置为 `plugin` 的页面；`open-tab` 打开插件标签时只收此刻登记着、位置为 `session` 的页面。页面不存在回 404，位置不对回 400。其余只动记录，所属插件停用时也能做。
- `open-tab` 把表里的标签设为开，插件标签第一次打开时追加在末尾；`close-tab` 设为关，位置保留，再打开回到原位；`tab-up`、`tab-down` 与表里的邻居对调；`remove-tab` 把插件标签从表里删掉，再打开时追加在末尾。关闭只设为关、位置保留，插件标签累计到上限后，移出用不着的才能打开新的；宿主标签只能关、不能移出。
- 已固定的再固定、挪到头的、取消没固定的、关掉或移出没进过表的都不变，回原记录、不推事件。每个列表最多 `MAX_LAYOUT_ENTRIES`（50）条，会话面板的标签连同宿主标签算，满了回 409。
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
/** 日志的筛选：历史（GET /api/logs/tail、/api/logs/range 的同名查询参数）与实时推送同一份，在服务端筛 */
interface LogFilter {
  level?: LogLevel; // 这一级及以上
  plugin?: string; // 插件实例 id：这个实例与它分出的子作用域
  text?: string; // 正文里含有这段文字，不分大小写
}

/** 前端发往 /admin */
type WebuiAdminClientMessage = { type: 'log.subscribe'; filter?: LogFilter } | { type: 'log.unsubscribe' };

/** /admin 推给前端 */
type WebuiAdminEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'plugins.changed' }
  | { type: 'page.invalidate'; instance: string; pageKey: string; componentId?: string; sessionId?: string }
  | { type: 'layout.changed' }
  | { type: 'attention.changed' }
  | { type: 'app.restarting' }
  | { type: 'client.reload' };
```

| 事件 | 字段 | 推给谁 | 前端怎么办 |
|---|---|---|---|
| `log` | `entry`：`{ seq, timestamp, level, scope, message }`，与 `GET /api/logs/tail` 返回的条目同形 | 订阅了日志、符合它订阅时的筛选的连接 | 追加到日志列表 |
| `plugins.changed` | 无 | 全部连接 | 插件状态可能变了（启停、装卸、激活成败之后），或页面登记表变了（插件登记或撤回页面）：重取 `GET /api/plugins` 与 `GET /api/pages`。一次启停可能连着推几条，服务端不合并，前端合并成一次重取。打开着的页面所属插件停用时，主区显示占位；页面重新登记后回到原页 |
| `page.invalidate` | `instance`、`pageKey`，可选 `componentId`、`sessionId` | 全部连接 | 插件说这一页的数据变了：打开着这一页的界面重取，带 `componentId` 时只重取这个组件，带 `sessionId` 时只有打开着这个会话的面板重取。页面登记时宿主也推一次整页的（插件重载时撤回与重新登记几乎同时，界面不一定看得到页面不在的那一刻）。服务端按这四项合并：同一组一秒内最多推一次 |
| `layout.changed` | 无 | 全部连接 | 布局记录变了：重取 `GET /api/layout` |
| `attention.changed` | 无 | 全部连接 | 「需要处理」变了（审批推出或结算、插件的故障有变、提示登记或撤回）：重取 `GET /api/attention` |
| `app.restarting` | 无 | 全部连接 | 应用即将重启，连接随后断开：提示正在重启，稍后重连 |
| `client.reload` | 无 | 全部连接 | 前端偏好改了，或有前端包被卸载，活跃前端可能换了：整页重新加载 |

- **断线重连**：事件只是「变了」的信号，断线期间丢的不补发。重连后重取插件与页面、「需要处理」、布局记录和当前打开的页面；日志页开着时重新订阅。
- **日志**：日志页打开时发 `{ type: 'log.subscribe', filter }`，离开时发 `{ type: 'log.unsubscribe' }`；订阅与退订不回执，筛选变了再订阅一次就换掉，不带 `filter` 推全部。先发订阅、再带同一份筛选取 `GET /api/logs/tail`，两边按 `seq` 去重；更早的日志用 `GET /api/logs/range` 带同一份筛选往前翻。按插件筛时怎样认作用域见 [plugin-webui-server](../plugins/plugin-webui-server.md) 的「日志的筛选」。
- **认不出的消息**（不是 JSON、`type` 不认识，或筛选写法不对）：服务端记一行告警后忽略，连接与之前的订阅照常。
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
// 日志页打开时，只看警告及以上
admin.send(JSON.stringify({ type: 'log.subscribe', filter: { level: 'warn' } } satisfies WebuiAdminClientMessage));
```

## 管理面 REST

webui-server 的全部 HTTP 路由，第三方前端照它实现；路由表与请求、回应的类型在 `packages/api-webui/src/rest.ts`，只有类型。先标 experimental，终端客户端接入后只做加法。WebSocket 端点不在这里：`/session` 见 [api-session-protocol](./api-session-protocol.md)，`/admin` 见上文「管理面推送」。

- **路由表**：`WebuiRestRoutes` 是回 JSON 的路由，每项写 `query`（查询参数）、`body`（请求体）与 2xx 时的 `response`；`WebuiFileRoutes` 是回文件或页面的路由，写请求与 2xx 时的响应头（小写，不含 `Date`、`ETag` 这类传输层的头）。键是「方法 路径」，路径照 webui-server 登记的写法：`:name` 是一段路径参数，要 `encodeURIComponent`（实例 id 可能带 `@`、`/` 与 `:`）；`{*path}` 是其后的任意多段。`WebuiRestResponse<K>` 取一条 JSON 路由的回应。
- **登录**：不要登录的只有 `/api/auth/` 下的四条与 `/frames/` 下的文件。其余的带登录 cookie，没登录的 `/api/` 请求回 401，页面回登录页。
- **来源**：改状态的请求（非 GET）带 `Origin` 时要与本服务同源，否则回 403（见 [plugin-webui-server](../plugins/plugin-webui-server.md) 的「改状态的请求校验来源」）。
- **失败**：一律回 4xx 或 5xx 与 `ErrorResponse`。路由表里没有的 `/api/` 路径回 404。请求体不是 JSON 或太大、路径参数解不开时回 4xx，处理时出错回 500，`error` 只写一句说明，不带堆栈，原因记在服务端日志里。
- **对得上**：webui-server 的路由一律按这张表登记，回 JSON 的处理函数只能回表里的回应或 `ErrorResponse`；路由都经按表登记的入口（`test/architecture/webui-routes.test.ts`）；启动时实际登记的路由与表逐条对上，每条路由的实际回应与类型对得上（`test/plugins/webui-rest-contract.test.ts`）。

```ts
interface ErrorResponse {
  error: string;
  issues?: SchemaIssue[]; // 输入没过校验时逐项列出
  applied?: true; // 改动已在运行态生效，只是没写进配置文件
}
interface OkResponse { ok: true }
/** 管理动作的回执：message 写做成了什么；动作之后插件没落在预期状态（激活失败、仍在激活等）时也写在这里 */
interface MessageResponse extends OkResponse { message: string }
```

### 认证

| 路由 | 请求 | 返回 |
|---|---|---|
| `POST /api/auth/login` | `{ token }` | `{ ok: true, identity }`，设登录 cookie；token 不对回 401，同一来源地址失败过多回 429 |
| `GET /api/auth/status` | — | `{ authed, identity? }` |
| `POST /api/auth/logout` | — | `OkResponse`，清掉登录 cookie |
| `GET /api/auth/login.js` | — | 登录页的脚本 |

`identity` 是 `UserIdentity`（api-authority），单 owner 下恒为 `{ platform: 'webui', userId: 'console' }`。页面地址带 `?token=` 也能登录：对了设 cookie 并 302 到不带查询串的同一地址。

### 插件与宿主配置

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/plugins` | — | `PluginListResponse` |
| `PUT /api/plugins/:name/config` | `{ config }`，部分更新：提交的顶层键整键替换，值为 `null` 的视为删除 | `PluginConfigResponse` |
| `POST /api/plugins/:name/enable` · `/disable` · `/reload` | — | `MessageResponse` |
| `POST /api/plugins/scan` | — | `{ ok: true, message, loaded }`：重新扫描插件目录，`loaded` 是新加载的插件 |
| `POST /api/plugins/:name/instances` | `{ suffix, config? }` | `{ ok: true, message, instanceId, ignored }` |
| `DELETE /api/plugins/:instanceId/instance` | — | `MessageResponse` |
| `GET /api/config` | — | `HostConfigResponse` |
| `PUT /api/config` | 核心键 → 新值，`null` 回到默认；只收核心键，别的顶层键回 400 | `{ ok: true, message, restartNeeded }` |
| `POST /api/restart` | — | `MessageResponse`，之后应用重启、连接断开 |
| `GET /api/services` | — | `ServiceListResponse` |
| `POST /api/services/:name/prefer` | `{ contextId }` | `OkResponse` |
| `DELETE /api/services/:name/prefer` | — | `OkResponse` |

```ts
interface PluginListItem {
  name: string; // 插件包名，同一插件的几个实例按它合在一起
  instanceId: string;
  displayName?: string;
  subsystem?: string; // 插件声明的子系统，组名与顺序见 DEFAULT_SUBSYSTEM_METADATA
  version?: string; // 已装的包的版本
  state: PluginState; // pending | activating | active | disabled | disposed | error
  error?: string;
  slow?: boolean; // 激活超过慢激活阈值、已转入后台
  self?: true; // 提供这个界面：不能从界面停用或卸载
  provides: string[];
  requiredServices: string[];
  optionalServices: string[];
  missing: string[]; // 此刻没有提供者的 required 服务
  tools: string[];
  commands: string[];
  reusable: boolean;
  extends?: ExtendDeclaration;
  config: Record<string, unknown>; // 配置文档里这一段，密钥字段上是引用 { $secret }
  configSchema?: ConfigSchema;
  defaultConfig: Record<string, unknown>;
}
interface PluginListResponse {
  plugins: PluginListItem[];
  secretRefCounts: Record<string, number>; // 密钥键 → 配置文档里引用它的处数
}
interface PluginConfigResponse extends MessageResponse {
  ignored: string[]; // 本次提交里裁掉的未声明字段
  removed: string[]; // 配置文档里原有、随这次写回删掉的未声明字段
}
interface HostConfigResponse {
  config: Record<string, unknown>; // 配置文档里写了的核心键
  schema: ConfigSchema; // 核心键的 schema
  restartKeys: string[]; // 要重启才生效的键
  home?: string; // 家目录
}
interface ServiceListResponse {
  // 服务名 → 提供者（第一个就是正在用的）与偏好的提供者
  services: Record<string, { providers: ServiceProviderView[]; preferred: string | null }>;
}
interface ServiceProviderView {
  contextId: string; // 提供者的插件实例 id，宿主自己提供的是 root
  displayName?: string;
  label?: string;
  priority: number;
  exclusive: boolean;
}
```

### 运行状况、日志与主题

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/attention` | — | `AttentionResponse`，见上文「需要处理」 |
| `GET /api/platforms` | — | `{ platforms: PlatformStatus[] }` |
| `GET /api/logs/tail` | 查询参数 `LogQuery` | `LogEntry[]`：符合筛选的最后 `limit` 条 |
| `GET /api/logs/range` | `LogQuery` 加 `before` | `LogEntry[]`：`seq` 比 `before` 小的最后 `limit` 条 |
| `GET /api/themes` | — | `PluginThemesResponse`，见下文「插件提供的主题」 |

```ts
interface PlatformStatus {
  adapterName: string;
  platform: string;
  contextId: string; // 适配器所在的插件实例
  connections: PlatformConnection[]; // api-platform
}
interface LogQuery extends LogFilter { limit?: number } // 默认 200，上限 5000；筛选写法不对回 400
```

### 可选项与模型

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/models/:service` | 查询参数 `dependency?` | `LLMModelsResponse`（`:service` 是 `llm`）或 `OptionsResponse`（其余） |
| `POST /api/llm-providers/:contextId/refresh` | — | `{ ok: true, added, removed, total }` |

- `llm`：模型列表，模型字段的可选项走它。
- 宿主回答的来源：`platform`（平台名）、`gateway-scopes`（会话范围）、`toolGroups`（工具分组，`'*'` 是全部分组）、`llm-thinking`（深度思考的档位，按 `dependency` 取那个模型声明的档位，`dependency` 是模型引用 `{ provider, model }` 的 JSON，没带时按服务偏好，写法不对回 400；模型不能调时 `models` 与 `details` 为空）。
- 其余服务名调那个服务各提供者的 `listModels()`，回 `{ models }`。
- 刷新：`:contextId` 是提供者的插件实例，与模型的 `contextId` 相同；名下的模型都不能运行时刷新、或名下没有模型时回 404。

```ts
interface LLMModelsResponse { providers: LLMModelEntry[] }
interface LLMModelEntry {
  model: string;
  provider: string; // 显示名
  contextId: string; // 提供它的插件实例，llm-ref 的取值 { provider, model } 认的是它
  capabilities: string[];
}
interface OptionsResponse {
  models: string[]; // 取值
  details?: OptionDetail[]; // 带名字的可选项，有它时按它画
  labels?: Record<string, string>; // 不在可选项里的取值的名字（换了模型以后存着的档位）
}
interface OptionDetail {
  value: string;
  label: string;
  default?: true; // 没设时生效的那一项
  description?: string; // 工具分组的说明
  pluginName?: string; // 登记工具分组的插件
}
```

### 页面与布局

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/pages` | — | `{ pages: PageView[] }`：登记着的全部页面，加上所属实例 `instance`，`placement` 总是给出；按 `order`、实例、key 排好。声明式页面（`DeclarativePageView`）是声明去掉函数（数据源、处理函数、`applies`）；插件前端页面（`FramePageView`）见上文「插件前端」 |
| `GET /api/session-pages` | 查询参数 `sessionId` | `{ pages: PageRef[] }`：这个会话适用的会话面板页面。会话不存在回 404 |
| `GET /api/pages/:instance/:pageKey/data/:componentId` | 查询参数 `PageDataQuery` | `PageDataResponse`（声明式页面，按组件种类见 `PageDataByType`）或 `FrameDataResponse`（插件前端的数据源，`componentId` 是数据源名，`data` 是数据源返回的值） |
| `POST /api/pages/:instance/:pageKey/actions/:action` | `PageActionRequest` | `{ message? }` |
| `GET /api/layout` | — | `LayoutRecords` |
| `POST /api/layout` | `LayoutOperation` | 改后的 `LayoutRecords` |

```ts
interface PageDataQuery {
  sessionId?: string; // 会话面板必填
  rowKey?: string; // 详情里的组件必填
  input?: string; // 插件前端声明了输入的数据源：JSON 字符串
}
interface PageActionRequest {
  sessionId?: string; // 会话面板必填
  rowKey?: string; // 行动作必填（插件前端没有行动作）
  input?: Record<string, unknown>; // 声明了输入的动作
}
```

两条路由只收用得上的键，多出或缺了都拒收，见上文「页面的调用与布局」；布局记录的操作见那一节的「布局记录」。

### 市场

| 路由 | 请求 | 返回 |
|---|---|---|
| `GET /api/marketplace` | 查询参数 `q?`：空格分隔的每个词都要在包名、描述或关键词里 | `{ packages: MarketplacePackage[], warning? }` |
| `GET /api/system-components` | — | `{ components: SystemComponent[], warning? }` |
| `GET /api/marketplace/depgraph` | 查询参数 `name`：包名 | `DependencyGraphResponse` |
| `POST /api/marketplace/install` | `{ name }` | `InstallResult`（api-package-manager） |
| `POST /api/marketplace/uninstall` | `{ name }` | `{ ok, message }` |
| `POST /api/marketplace/update` | `{ targets: [{ name, version }] }`，整批 | `UpdateResult`（api-package-manager），成功后进程重启 |

装卸与更新被包管理拒绝时也回 200，`ok` 为 `false`、`message` 写原因；`warning` 是检索源或安装源查不到时的说明。

```ts
interface MarketplacePackage {
  name: string;
  version: string; // 安装源上的最新版，查不到为空串；不是本地已装的版本
  description: string;
  author?: string;
  installed: boolean;
  resolved?: string; // 本地已装的版本
  request?: string; // 根 package.json 里的依赖声明
  origin?: DepOrigin; // 本地这份从哪来（util-dep-spec）
  updatable: boolean; // 能否经市场更新，界面直接用它，不自己比版本
  official: boolean; // @aalis/ 下的包
  category: 'plugin' | 'api' | 'schema' | 'interface' | 'util';
  keywords?: string[];
  downloads?: number; // 月下载量
  updated?: string; // ISO 时间
  score?: number; // 只用来排序
  insecure?: boolean;
  license?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}
interface SystemComponent {
  name: string;
  version?: string; // 本地已装的版本
  latest?: string; // 安装源上的最新版
  request?: string;
  origin: DepOrigin; // 从 updatable 推不出来源，所以另给
  description?: string;
  kind: 'core' | 'runtime' | 'api' | 'schema' | 'util';
  updatable: boolean; // 根 dependencies 里以 semver 范围声明、且最新版严格新于本地
}
interface DependencyGraphResponse {
  upstream: DependencyNode; // 它依赖谁
  downstream: DependencyNode; // 谁依赖它
  services: { required: Array<{ service: string; providedBy: string | null }>; provides: string[] };
  serviceDependents: string[]; // 卸载它会断掉服务的插件
}
interface DependencyNode {
  name: string;
  present: boolean; // false：本地没有这个包，链路在此中断
  services?: { provides: string[]; requires: string[] }; // 已加载的插件才有
  children: DependencyNode[];
}
```

### 文件

| 路由 | 请求 | 响应头 |
|---|---|---|
| `GET /api/session-file` | 查询参数 `sessionId`、`handle`（会话服务签发的句柄，条目附件的 `src`） | 当附件下发：`application/octet-stream`、`Content-Disposition: attachment`、`Content-Length`、`nosniff` |
| `GET /api/page-file` | 查询参数 `handle`（`FileCell.handle`） | 同上 |
| `GET /api/media` | 查询参数 `uri`：存储地址 | 按文件头判定的图片、视频或音频类型，`Content-Disposition: inline`、`Content-Length`、`nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`、`Cache-Control: private, max-age=3600` |
| `GET /api/proxy/image` | 查询参数 `url`：外站图片 | `image/*`、`nosniff`、`Content-Security-Policy: sandbox`、`Cache-Control: private, max-age=86400` |

### 插件前端的文件

| 路由 | 说明 |
|---|---|
| `GET /frames/:token/{*path}` | 插件前端的文件，`token` 取自 `FramePageView.frame.src` |
| `GET /frames/_base/frame.js` | 宿主给框架的助手 |
| `GET /frames/_base/frame.css` | 宿主给框架的样式基线 |

只收 GET 与 HEAD，别的方法回 405；不要登录。响应头带框架 CSP（`sandbox allow-scripts; …`）、`nosniff`、`Referrer-Policy: no-referrer`、`X-DNS-Prefetch-Control: off`、`Access-Control-Allow-Origin: *` 与 `Cache-Control: no-cache`，规则见上文「托管与隔离」。

### 前端托管

| 路由 | 说明 |
|---|---|
| `GET /__clients` · `GET /__clients.js` | 换前端的恢复页与它的脚本：任何前端卡住时都能在这里切回 |
| `GET /{*path}` | 其余 GET：活跃前端的 `index.html`，前端自己的路由由它接手；`/assets/` 下没有的文件回 404，还没有前端时回 404 与 `ErrorResponse` |

这几条带文档级 CSP；活跃前端的静态文件（`index.html` 旁的脚本、样式与图片）在它们之前按文件路径给出。

## 主题

一个主题是名字、种类（深或浅）与一套颜色令牌值，只改颜色，不改间距、圆角、字号与布局。主题文件是可交换的 JSON，内置主题就是随包带的这种文件（`packages/api-webui/src/themes/`），第三方主题照同一格式写，在设置「外观」里导入，插件也能经贡献点提供（见下文「插件提供的主题」），三者都经 `parseTheme` 校验。本节的格式、令牌表与贡献点是公开契约，先标 experimental。

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

### 插件提供的主题

插件经贡献点 `webui:theme`（[api-contributions](./api-contributions.md)）提供主题，只交一份主题文件这份数据，与导入的主题走同一套校验：

```ts
import { contributions } from '@aalis/api-contributions';

interface ThemeContribution {
  id: string;        // 局部名，与插件实例 id 合成全局键
  theme: ThemeFile;
}

// apply 里
contributions.contribute('webui:theme', {
  id: 'dusk',
  theme: { format: 'aalis-theme', version: 1, name: '黄昏', kind: 'dark', colors: { '--color-bg': '#201a18' } },
});
```

- 登记随这次激活撤回：插件停用或卸载，它的主题就不在了；界面上正在用它的回到同深浅的偏中性，回来了就回到它。
- webui-server 经 `GET /api/themes` 列出 `PluginThemesResponse`：`{ themes: PluginTheme[] }`，每项是 `{ id, instance, theme }`，`id` 是贡献点的全局键（`<插件实例 id>/<局部 id>`），`instance` 是提供它的插件实例，`theme` 是过了 `parseTheme` 的主题（缺的令牌已补齐）。不合格式的不列出，webui-server 每份记一条告警。
- 设置「外观」的主题选择里，插件提供的主题写明出自哪个插件；能导出成主题文件。

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
