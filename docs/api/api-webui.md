# api-webui — WebUI 服务与声明式页面组件契约

**包名**: `@aalis/api-webui`  
**源码**: `packages/api-webui/src/index.ts`、`packages/api-webui/src/theme.ts`（主题）  
**实现**: `@aalis/plugin-webui-server`（+ `@aalis/plugin-webui-client` 提供前端）

## 概述

定义 WebUI 后台服务接口、声明式页面组件 schema、按激活绑定的登记门面，以及主题的令牌表与主题文件格式。插件不需要懂 HTTP/React，只需在 `apply` 里 `uses` 声明 `webuiServer`，调用 `webui.registerPage` / `webui.registerAction`。webui-server 负责渲染并暴露 REST + WebSocket。页面动作随本次激活撤回；同名动作为替换。

`GET /api/plugins` 的 `uses` 是插件 `uses` 声明的完整快照，每项为 `{ key, service, kind }`，`key` 保留 `apply` 参数名；插件页展开后按 `kind` 标为「必需」或「可选」。core 内置服务（`events` / `lifecycle` / `logger` / `config` / `provide` / `services`）和宿主服务（`app` / `plugins` / `host-config` 等）由根激活登记，与第三方服务一样是普通提供者：`/api/services` 里以「宿主」为提供者列出；插件声明了它们同样要经过激活闸，只是这些服务在加载插件前已就绪。`requiredServices` / `optionalServices` 是 `uses` 按是否包 `optional()` 拆出的服务名，包含 core 内置服务。`capabilities` 是工具和指令的敏感可见性标记。经 `services` 动态查询获得的服务不在声明列表中。

## 服务接口

```ts
interface WebUIService {
  getPort(): number;
  getHost(): string;
  registerPage(page: WebuiPage, contextId: string): () => void;
  getPages(): Array<WebuiPage & { pluginName: string }>;
  registerAction(method: string, handler: WebuiActionHandler, contextId: string): () => void;
}

type WebuiActionHandler = (args: Record<string, unknown>, caller?: UserIdentity) => Promise<unknown>;
```

插件侧走绑定门面，不要自己传 `contextId`。

## 绑定接口

```ts
interface BoundWebui extends ServiceRef<WebUIService> {
  registerPage(page: WebuiPage): () => void;
  registerAction(method: string, handler: WebuiActionHandler): () => void;
}
```

`webuiServer` 的 `registerPage` / `registerAction` 走 `registrar`：同键替换、提供者换人整体重挂、关闭后拒收。调用型查询（`getPort` / `getPages`）走 `current` / `require()`。

另有调用型描述符 `webuiClient`（`WebuiClientProvider`），绑定接口是普通 `ServiceRef`。

## 展示元数据（declaration merging）

本包向 `PluginMeta` 注入 `extends?: ExtendDeclaration`（core 不读，仅 WebUI 展示）。`subsystem` 是 `PluginDefinition` 上的展示字段，写在 `definePlugin({ subsystem })`。

本包不向 `@aalis/schema-config` 的 `SchemaField` 注入属性：`secret`（值是凭据，宿主存进密钥存储、WebUI 不回显）与影响取值判定的 `dynamicOptions` / `allowCustom` 都由 `@aalis/schema-config` 声明，插件用它们不必引入本包。

页面与页面动作**不是**静态模块字段：在 `apply` 里经 `webui.registerPage` / `webui.registerAction` 登记。

`POST /api/page-action/:plugin/:method` 在身份闸放行后调用已登记的 handler，并把 `caller` 作为第二参传入（`packages/plugin-webui-server/src/routes/plugins.ts`）。单 owner 终态下该路由要求 owner 身份。

action 的业务失败**返回** `{ ok: false, error: '原因' }`，HTTP 仍是 200——路由只把 handler 的抛错转成 5xx；前端 form / actions / table 三种组件都据此显示原因，返回其它任何值（含 `undefined`）视为成功；table 的非 danger / confirm 操作若返回不带 `ok` 的普通对象，会被当作详情弹窗内容展示，只想刷新表格就返回 `undefined` 或 `{ ok: true }`。成功回执 `{ ok: true, message }` 带非空 `message` 时前端显示它：form 用它代替「已保存」，actions 用它代替「完成」，table 行内操作先弹窗告知再刷新表格——「已保存，但仅本次运行生效」这类附注放在这里。

## 页面登记

```ts
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

const page: WebuiPage = {
  key: 'shell',
  label: 'Shell',
  content: [{ type: 'stat', label: '条目数', source: 'stats' }],
};

export default definePlugin({
  name: '@acme/plugin-example-webui',
  subsystem: 'tools',
  uses: { webui: optional(webuiServer) },
  apply({ webui }) {
    webui.registerPage(page);
    webui.registerAction('stats', async () => ({ value: 42 }));
  },
});
```

`webui-server` 未就绪时登记排队，就绪后挂上，缺失时页面不显示。不必把 `webuiServer` 标成 required，除非还要读 `getPort` / `getPages`。

## 声明式页面组件

```ts
type WebuiComponent =
  | WebuiStatComponent
  | WebuiTableComponent
  | WebuiFormComponent
  | WebuiActionsComponent
  | WebuiInfoComponent
  | WebuiMarkdownComponent
  | WebuiTabsComponent
  | WebuiGraphComponent;
```

每种组件都有：

- `source` —— 拉数据的 action 方法名（不是 HTTP 路径；前端调 `POST /api/page-action/:plugin/:method`）
- `save` / `method` —— 提交动作的 action 方法名，同上
- `confirm` —— 行内/按钮确认提示
- `danger` —— 红色样式标记

### 示例：表格 + 操作

```ts
{
  type: 'table',
  label: '后台进程',
  source: 'listProcesses',
  columns: [
    { key: 'pid', label: 'PID' },
    { key: 'cmd', label: '命令' },
    { key: 'startedAt', label: '启动时间', render: 'date' },
  ],
  actions: [
    { label: '终止', method: 'killProcess', confirm: '确定？', danger: true },
  ],
  refresh: 5,
}
```

### 文件单元格

表格列写 `render: 'file'` 与 `method` 时，单元格把值作为文件名显示，配「查看」「下载」两个按钮。点击时以整行为参数调这一列的 `method`，页面动作返回：

```ts
interface WebuiFilePayload {
  name: string;    // 保存时的文件名；客户端去掉其中的 / 与 \
  mime: string;
  base64: string;  // 文件内容
}
```

- 「查看」只在 `mime` 为 `image/png`、`image/jpeg`、`image/gif`、`image/webp` 时生成同类型的 Blob，用 `<img>` 显示在弹窗里；其他类型（含 HTML、SVG）只提示「此类型只能下载」，不在 WebUI 源里渲染。
- 「下载」一律生成 `application/octet-stream` 的 Blob 保存，与返回的 `mime` 无关。对象 URL 用完即回收。
- 业务失败返回 `{ ok: false, error }`，抛错或返回的结构不对时，原因显示在单元格旁边。写了 `render: 'file'` 但没写 `method` 的列按文本显示。

页面动作只回 JSON，不会被浏览器当页面渲染；插件不能登记自己的 HTTP 文件路由，需要让 owner 取文件时用这种单元格。

### 图片单元格与刷新

列写 `render: 'image'` 和 `method` 时，挂载后以整行为参数调用动作，接收相同的 `WebuiFilePayload` 并在表格内显示缩略图。只接受 PNG、JPEG、GIF、WebP，并核对文件签名；HTML 和 SVG 不在 WebUI 的源下内联执行。替代文字取该列的值；卸载或更新时释放对象 URL。

列写 `render: 'time'` 时，值是毫秒时间戳或 ISO 字符串，显示为本地日期时间（当年的省去年份），悬停显示完整时间；解析不了的值原样显示，空值不显示。列写 `render: 'link'` 时，只有 `http://`、`https://` 开头的值显示为在新标签页打开的链接（不带 opener 与 referrer），其他值按文本显示。

`stat` 的动作返回 `{ value: number | string }`，`markdown` 的动作返回 `{ content: string }`。表格操作成功会刷新整页的数据组件，使统计、说明和预览链接与表格保持一致。

页面设 `refresh: 30` 可每 30 秒刷新当前页的数据组件；切页与卸载后定时器关闭，表单未保存的编辑不被重置。页面级刷新覆盖统计、说明、信息和当前可见表格，不必在每张表重复声明。表格自己的 `refresh` 仍只刷新本表。

### 示例：表单复用 ConfigSchema

```ts
{
  type: 'form',
  label: '基础配置',
  source: 'getConfig',
  save: 'saveConfig',
  schema: configSchema,
}
```

## WebuiPage 完整结构

```ts
interface WebuiPage {
  key: string;
  label: string;
  icon?: string;
  order?: number;
  renderer?: string;
  refresh?: number; // 全页刷新间隔（秒），0/缺省关闭
  content?: WebuiComponent[];
}
```

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
  | { type: 'app.restarting' }
  | { type: 'client.reload' };
```

| 事件 | 字段 | 推给谁 | 前端怎么办 |
|---|---|---|---|
| `log` | `entry`：`{ seq, timestamp, level, scope, message }`，与 `GET /api/logs/tail` 返回的条目同形 | 订阅了日志的连接 | 追加到日志列表 |
| `plugins.changed` | 无 | 全部连接 | 插件状态可能变了（启停、装卸、激活成败之后），或页面登记表变了（插件登记或撤回页面）：重取 `GET /api/plugins` 与 `GET /api/pages`。一次启停可能连着推几条，服务端不合并，前端合并成一次重取 |
| `app.restarting` | 无 | 全部连接 | 应用即将重启，连接随后断开：提示正在重启，稍后重连 |
| `client.reload` | 无 | 全部连接 | 前端偏好改了，或有前端包被卸载，活跃前端可能换了：整页重新加载 |

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
