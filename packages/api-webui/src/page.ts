// ----- 页面 -----
//
// 页面默认声明式，需要自绘时用插件前端。声明式页面只交声明：组件与它们的数据源、动作与它们的处理函数在 definePage 里
// 一次给出，返回形状按组件种类推出；样式、窄屏变形、确认框与输入表单都由宿主统一画。组件只有表格、关系图、键值、文字、
// 按钮组五样，另有标签页这一种排法。插件前端是插件包里的一份静态网页，在宿主画的隔离框架里运行，只放在插件页面与
// 会话面板，经消息通道调这一页声明过的数据源与动作（frame.ts）。
// 界面经 REST 取页面的声明（函数去掉，见 PageView）、取数、调动作；路由与返回形状见 rest.ts。

import type { UserIdentity } from '@aalis/api-authority';
import type { SessionKind } from '@aalis/api-session-manager';
import type { ConfigOf, SchemaField } from '@aalis/schema-config';
import type { FrameHostCapability } from './frame.js';

/** 一屏（页面最外层、一个标签、一个详情）最多几个组件；webui-server 登记时校验，超了不登记 */
export const MAX_SCREEN_COMPONENTS = 6;
/** 一页最多几个标签 */
export const MAX_PAGE_TABS = 6;

/**
 * 页面放在哪：
 * - `plugin`（默认）：本插件详情的页面区块，地址 `/p/:instance/:pageKey`，占整个主区；用户可以把它固定到图标栏；
 * - `settings`：设置里的一节；
 * - `session`：会话右侧面板的一个标签，从面板标签栏的「+」按需打开。
 */
export type PagePlacement = 'plugin' | 'settings' | 'session';

/** 数据源与动作收到的调用上下文 */
export interface PageContext {
  /** 调用者：认证出的身份。只有 owner 能调用页面 */
  caller: UserIdentity;
}

/** 会话面板的调用上下文：会话 id 由宿主单独给出，不从参数里取；调用前宿主核过会话存在，给的是规范化后的 id */
export interface SessionPageContext extends PageContext {
  sessionId: string;
}

/** 按位置取调用上下文 */
export type PageContextOf<P extends PagePlacement> = P extends 'session' ? SessionPageContext : PageContext;

/** 会话面板的 applies 收到的会话 */
export interface PanelSession {
  sessionId: string;
  kind: SessionKind;
}

// ----- 单元格 -----

/**
 * 单元格的显示种类，封闭集合，不写为 `text`：
 * - `time`：毫秒时间戳或 ISO 字符串，显示为本地时间；`countdown`：毫秒时间戳，显示剩余时间，到零不重取；
 * - `link`：只认 http、https，新标签打开，其余按文本；`status`：{@link StatusValue}；`code`：等宽；
 *   `long-text`：单行省略，可以展开；
 * - `image`：值是存储地址，宿主换成 `/api/media` 地址，按需懒加载；
 * - `file`：值是存储地址，宿主换成下载句柄（{@link FileCell}）。插件私有数据的根（data、pluginData）里的文件不签发，只显示名字。
 */
export type CellKind = 'text' | 'time' | 'countdown' | 'link' | 'status' | 'code' | 'long-text' | 'image' | 'file';

/** 状态单元格的值：一句话，正常时不写 state、不上色 */
export interface StatusValue {
  text: string;
  /** attention 需要处理，error 出错，running 进行中，inactive 停用或弱化 */
  state?: 'attention' | 'error' | 'running' | 'inactive';
}

/** 数据源给出的单元格值 */
export type CellValue = string | number | boolean | null | undefined | StatusValue;

/** 数据源返回的一行：rowKey 指名的字段是这一行的非空字符串标识，visibleWhen 指名的字段是布尔值 */
export type TableRow = Record<string, CellValue>;

export interface TableColumn {
  key: string;
  label: string;
  kind?: CellKind;
  /** 窄时（手机、会话面板）只显示标了的列；都没标时显示第一列，带详情的表格另留选中用的那一列 */
  primary?: boolean;
}

/** 表格行上的按钮：引用 actions 里的行动作；visibleWhen 指名的行字段为真时才显示 */
export interface RowAction<A extends string = string> {
  action: A;
  visibleWhen?: string;
}

/** 键值组件的一项；数字用等宽数字 */
export interface InfoItem {
  label: string;
  value: CellValue;
  /** 显示种类，同表格的单元格，不收 image、file */
  kind?: Exclude<CellKind, 'image' | 'file'>;
}

/** 关系图的分类色：1 到 6 对应 `--color-chart-1` 到 `-6`，随主题变，不收颜色值 */
export type ChartTone = 1 | 2 | 3 | 4 | 5 | 6;

/** 关系图里的一类节点或边：取色与图例 */
export interface GraphKind {
  kind: string;
  label: string;
  tone: ChartTone;
}

/** 关系图的数据：节点 id 唯一，边的两端都是节点 id */
export interface GraphData {
  nodes: Array<{ id: string; label: string; kind?: string }>;
  edges: Array<{ source: string; target: string; label?: string; kind?: string }>;
}

// ----- 组件 -----

/** 页面最外层与标签里的数据源只收上下文 */
export interface DataArgs<C> {
  ctx: C;
}

/** 详情里的数据源另收选中行的 rowKey（关系图是选中节点的 id），插件按它重新查 */
export interface DetailDataArgs<C> extends DataArgs<C> {
  rowKey: string;
}

/** 组件共有的小标题与一句说明 */
interface ComponentBase {
  label?: string;
  description?: string;
}

/** 表格与关系图可带详情：选中一行（一个节点）后显示的组件，宽时在右边、窄时进下一级。详情里的组件不再带详情 */
type WithDetail<D> = [D] extends [never] ? { detail?: never } : { detail?: D[] };

/** 表格：数据源返回全部行，排序、搜索与分页由宿主在界面上做，行数超过一页才出现搜索框与分页 */
export type TableDefinition<A extends string, X, D> = ComponentBase &
  WithDetail<D> & {
    type: 'table';
    /** 页面内唯一：取数与 invalidate 都按它 */
    id: string;
    rowKey: string;
    columns: TableColumn[];
    /** 没有行时的一句话 */
    empty?: string;
    rowActions?: RowAction<A>[];
    data(args: X): TableRow[] | Promise<TableRow[]>;
  };

/** 关系图：节点与边按类别取色，可以缩放查看 */
export type GraphDefinition<X, D> = ComponentBase &
  WithDetail<D> & {
    type: 'graph';
    id: string;
    empty?: string;
    nodeKinds?: GraphKind[];
    edgeKinds?: GraphKind[];
    /** 布局疏密：理想边长，单位像素；不写时宿主取默认 */
    spacing?: number;
    data(args: X): GraphData | Promise<GraphData>;
  };

/** 键值：一组「名称 → 值」 */
export interface InfoDefinition<X> extends ComponentBase {
  type: 'info';
  id: string;
  data(args: X): InfoItem[] | Promise<InfoItem[]>;
}

/** 只读文字（Markdown）：不渲染原始 HTML，图片只认 `/api/media` 地址，链接只许 http、https、mailto */
export interface MarkdownDefinition<X> extends ComponentBase {
  type: 'markdown';
  id: string;
  data(args: X): string | Promise<string>;
}

/**
 * 把一段原文包成 Markdown 代码块，给文字组件显示 YAML、JSON 这类原文：围栏比原文里最长的一串反引号多一个，
 * 原文里的反引号与 Markdown 记号都原样显示
 */
export function markdownCode(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/** 一组按钮，每个按钮对应一个动作。页面最外层与标签里的只收页面动作，详情里的只收行动作（作用于选中的那一行） */
export interface ActionsDefinition<A extends string> extends ComponentBase {
  type: 'actions';
  actions: A[];
}

export type ComponentDefinition<A extends string, X, D> =
  | TableDefinition<A, X, D>
  | GraphDefinition<X, D>
  | InfoDefinition<X>
  | MarkdownDefinition<X>
  | ActionsDefinition<A>;

/** 详情里的组件 */
export type DetailComponentDefinition<A extends string, C> = ComponentDefinition<A, DetailDataArgs<C>, never>;

/** 页面最外层与标签里的组件 */
export type PageComponentDefinition<A extends string, C> = ComponentDefinition<
  A,
  DataArgs<C>,
  DetailComponentDefinition<A, C>
>;

export interface PageTab<T> {
  /** 页面内唯一 */
  key: string;
  title: string;
  content: T[];
}

/** 页面内容：竖排的组件，或者标签页（只在页面最外层，标签里不再套标签） */
export type PageContent<T> = T[] | { tabs: PageTab<T>[] };

// ----- 动作 -----

/**
 * 动作的效果：read 只读，write 改数据，destructive 不可撤销。按钮样式与确认由它推出：插件页面里的按钮一律是次要或文字按钮，
 * destructive 用危险色字，由宿主弹确认框；插件不能自己画确认框。write 与 destructive 的调用宿主记一行 info 日志
 */
export type ActionEffect = 'read' | 'write' | 'destructive';

/** 动作的输入：一组 schema-config 字段。点了按钮弹一个小表单；行动作的表单里，与行字段同名的输入项用这一行的值预填 */
export type ActionInputFields = Record<string, SchemaField>;

/**
 * 处理函数的返回：成功时可以给一句结果，宿主用 Toast 显示；失败就抛错，原因显示给操作的人。
 * 用 void 而非 undefined：没有结果的处理函数不必写 `return undefined`
 */
// biome-ignore lint/suspicious/noConfusingVoidType: 见上——这里要的正是「可以不返回」
export type ActionResult = string | void | Promise<string | void>;

/** definePage 推断输入时得到的是只读字面量，ConfigOf 要的是可写的字段表 */
type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
type InputSchema<I> = Writable<Exclude<I, undefined>>;

/** 处理函数收到的输入：按声明的字段推出；宿主已按字段校验类型、必填与可选项，拒收多余的键，并补上默认值 */
export type ActionInput<I> = unknown extends I
  ? undefined
  : [InputSchema<I>] extends [ActionInputFields]
    ? ConfigOf<InputSchema<I>>
    : undefined;

/** 写错的输入字段在 input 上报错 */
type CheckedInput<I> = unknown extends I
  ? unknown
  : [InputSchema<I>] extends [ActionInputFields]
    ? unknown
    : ActionInputFields;

/** 动作共有的字段 */
type ActionFields<I> = {
  /** 按钮上的字：两到四个字的动词 */
  label: string;
  effect: ActionEffect;
  /** 只给 destructive：确认框（带输入的是表单）里的警示，非空；不写时宿主写「这个操作不能撤销。」 */
  confirm?: string;
  input?: I & CheckedInput<I>;
};

export type ActionDefinition<I, C> = ActionFields<I> &
  (
    | {
        /** 行动作：放在表格行上或详情里，处理函数收到那一行的 rowKey，按它重新查，不信任界面回传的整行 */
        row: true;
        handler(args: { rowKey: string; input: ActionInput<I>; ctx: C }): ActionResult;
      }
    | { row?: false; handler(args: { input: ActionInput<I>; ctx: C }): ActionResult }
  );

/**
 * 插件前端的动作：与声明式的同一个定义，只是不收 row。插件前端里没有宿主画的表格行，要指定对象就放进 input；
 * destructive 的由宿主弹确认框，框里按输入字段列出这次的值
 */
export type FrameActionDefinition<I, C> = ActionFields<I> & {
  row?: never;
  handler(args: { input: ActionInput<I>; ctx: C }): ActionResult;
};

// ----- 页面 -----

/** 两种页面共有的字段 */
interface PageDefinitionBase {
  /** 本插件实例内唯一 */
  key: string;
  title: string;
  /** lucide 图标名（kebab-case）；界面不认识的名字换成通用图标 */
  icon?: string;
  /** 同一位置里的先后，小的在前 */
  order?: number;
  /** 只给会话面板：这个会话用不用得上本页，不写就适用于全部会话。抛错或超时按不适用处理 */
  applies?(session: PanelSession): boolean | Promise<boolean>;
}

/**
 * 声明式页面。P 是位置，S 是各动作的输入字段（由 definePage 推断），A 是可以引用的动作名。
 * 登记时 webui-server 按质量门槛校验：一屏最多 {@link MAX_SCREEN_COMPONENTS} 个组件、最多 {@link MAX_PAGE_TABS} 个标签、
 * 嵌套最多一层、组件 id 唯一、引用的动作都存在且放对了地方、不认识的字段一律拒收；不过就不登记并记一条错误日志
 */
export interface DeclarativePageDefinition<
  P extends PagePlacement = PagePlacement,
  S extends Record<string, unknown> = Record<string, unknown>,
  A extends string = keyof S & string,
> extends PageDefinitionBase {
  placement?: P;
  content: PageContent<PageComponentDefinition<A, PageContextOf<P>>>;
  actions?: { [K in keyof S]: ActionDefinition<S[K], PageContextOf<P>> };
  frame?: never;
  sources?: never;
}

/** 插件前端只放在这两个位置：插件页面与会话面板 */
export type FramePlacement = Exclude<PagePlacement, 'settings'>;

/**
 * 插件前端在插件包里的位置。webui-server 从 module 所在目录往上找最近一个带 name 字段的 package.json（只写 type 的
 * 跳过），它的 name 要等于插件名，那一层就是插件包根；只托管包根下 webui/ 目录里的文件。包的 files 里要带上 webui
 */
export interface FrameDefinition {
  /** 声明这个页面的模块地址：写 import.meta.url */
  module: string;
  /** webui/ 下的入口：以 .html 结尾的相对路径，不以 / 开头、各段不以点开头；不写为 index.html */
  entry?: string;
  /** 申请的宿主数据能力，从词表（frame.ts 的 FRAME_HOST_CAPABILITIES）里选、不重复；不写就没有 */
  host?: FrameHostCapability[];
}

/** 插件前端的一个数据源：输入的写法与校验同动作的 input，data 返回可以 JSON 化的值 */
export interface FrameSourceDefinition<I, C> {
  input?: I & CheckedInput<I>;
  data(args: { input: ActionInput<I>; ctx: C }): unknown;
}

/**
 * 插件前端页面。P 是位置，S 是各动作的输入字段，R 是各数据源的输入字段（都由 definePage 推断）。
 * 框架经消息通道按名字取数据源、调动作，数据源的名字与输入、动作的声明都由服务端核；登记时另核插件包根、webui/ 与入口
 */
export interface FramePageDefinition<
  P extends PagePlacement = PagePlacement,
  S extends Record<string, unknown> = Record<string, unknown>,
  R extends Record<string, unknown> = Record<string, unknown>,
> extends PageDefinitionBase {
  placement?: P & FramePlacement;
  frame: FrameDefinition;
  sources?: { [K in keyof R]: FrameSourceDefinition<R[K], PageContextOf<P>> };
  actions?: { [K in keyof S]: FrameActionDefinition<S[K], PageContextOf<P>> };
  content?: never;
}

/** 一个页面的声明：声明式（写 content）与插件前端（写 frame）二选一 */
export type PageDefinition<
  P extends PagePlacement = PagePlacement,
  S extends Record<string, unknown> = Record<string, unknown>,
  A extends string = keyof S & string,
  R extends Record<string, unknown> = Record<string, unknown>,
> = DeclarativePageDefinition<P, S, A> | FramePageDefinition<P, S, R>;

/** definePage 的返回 */
export interface PageHandle {
  /**
   * 这一页的数据变了：打开着它的界面重取。componentId 只重取这个组件（插件前端是数据源名），不写为整页；sessionId 只让
   * 打开着这个会话的面板重取。宿主按这四项合并短时间内的连发
   */
  invalidate(componentId?: string, sessionId?: string): void;
}

// ----- 提示 -----

/** 一条提示：需要处理的事或出了故障，出现在「需要处理」与插件详情。归属这次激活，插件停用就撤回 */
export interface Notice {
  /** 本插件实例内唯一；同一个 id 再发一次就是替换 */
  id: string;
  /** action 需要你处理，error 出错 */
  level: 'action' | 'error';
  /** 出了什么事；数量写进标题，例如「3 件作品待裁决」 */
  title: string;
  /** 用户该做什么，具体到配置项、命令或页面 */
  detail?: string;
  /** 跳转：去本插件的配置，或打开本插件位置为 plugin 或 settings 的页面（按页面的 key）；按钮上的字由宿主推出 */
  open?: 'config' | { page: string };
}

/** notify 的返回：只有插件自己能撤回，问题没解决就一直在 */
export interface NoticeHandle {
  clear(): void;
}

// ----- 界面收到的形状 -----

// biome-ignore lint/suspicious/noExplicitAny: 只用来认出函数字段
type AnyFunction = (...args: any[]) => unknown;

/** 声明经 JSON 下发给界面时的样子：数据源、处理函数与 applies 去掉，其余原样 */
export type Serialized<T> = T extends AnyFunction
  ? never
  : T extends readonly (infer E)[]
    ? Serialized<E>[]
    : T extends object
      ? { [K in keyof T as NonNullable<T[K]> extends AnyFunction ? never : K]: Serialized<T[K]> }
      : T;

/** 界面拿到的组件（含详情里的） */
export type ComponentView = Serialized<PageComponentDefinition<string, PageContext>>;

/** 界面拿到的动作：按钮上的字、效果、确认文案、输入字段，以及是不是行动作 */
export interface ActionView {
  label: string;
  effect: ActionEffect;
  confirm?: string;
  input?: ActionInputFields;
  row?: boolean;
}

/** 两种页面在界面上共有的字段：所属的插件实例与 placement 总是给出 */
interface PageViewBase {
  instance: string;
  key: string;
  title: string;
  icon?: string;
  placement: PagePlacement;
  order?: number;
  actions?: Record<string, ActionView>;
}

/** 声明式页面：声明去掉函数 */
export interface DeclarativePageView extends PageViewBase {
  content: PageContent<ComponentView>;
  frame?: never;
}

/**
 * 插件前端页面：不带 content 与数据源，带宿主签发的框架地址与申请的能力；actions 供宿主决定确认框。
 * 不下发插件包的本机路径（module）与单独的 entry 字段，入口已含在 src 里
 */
export interface FramePageView extends PageViewBase {
  frame: {
    /** 框架地址 `/frames/<token>/<入口>`：页面撤回或重新登记后换新的 */
    src: string;
    host: FrameHostCapability[];
  };
  content?: never;
}

/** GET /api/pages 的一项 */
export type PageView = DeclarativePageView | FramePageView;

/** 界面收到的文件单元格：宿主签发的下载句柄（`GET /api/page-file?handle=`）与文件名；不能签发时只有名字 */
export interface FileCell {
  name: string;
  handle?: string;
}

/** 界面收到的一行：image 列已换成 `/api/media` 地址，file 列已换成 {@link FileCell} */
export type PageRow = Record<string, CellValue | FileCell>;

/** 各种组件的数据源取回的数据 */
export interface PageDataByType {
  table: PageRow[];
  graph: GraphData;
  info: InfoItem[];
  markdown: string;
}

/** 一个页面的位置标识：插件实例与页面 key */
export interface PageRef {
  instance: string;
  pageKey: string;
}

/**
 * 会话右侧面板里宿主自己的标签，按宿主的顺序：计划、设置、用量、后台（子会话与后台任务）。每个对应会话协议里的一类
 * 数据，由宿主按数据画，不走页面登记；照同一套协议实现的前端也有同样的标签。封闭集合，以后按加法加
 */
export const HOST_PANEL_TABS = ['plan', 'settings', 'usage', 'background'] as const;

export type HostPanelTab = (typeof HOST_PANEL_TABS)[number];

/** 会话面板一个标签的引用：宿主的标签，或一个位置为 session 的页面 */
export type PanelTabRef = { host: HostPanelTab } | PageRef;

/** owner 的界面布局，在所有会话、所有设备上一致 */
export interface LayoutRecords {
  /** 图标栏上固定的页面，按 owner 排的顺序 */
  pinned: PageRef[];
  /**
   * 会话面板的标签，按 owner 排的顺序：开着的在标签栏里，关着的在「+」里，都只在此刻可用时出现。
   * 宿主标签总在表里；插件标签第一次打开时追加在末尾，关了位置保留
   */
  panelTabs: Array<{ tab: PanelTabRef; open: boolean }>;
}

/**
 * 布局记录的一个操作。固定只收此刻登记着、位置为 plugin 的页面；打开插件标签只收此刻登记着、位置为 session 的页面。
 * 移出（remove-tab）只收插件标签，把它从表里删掉：关闭只设为关、位置保留，插件标签累计到上限后，移出用不着的才能打开新的；
 * 宿主标签只能关、不能移出。其余只动记录，所属插件停用时也能做
 */
export type LayoutOperation =
  | { op: 'pin' | 'unpin' | 'move-up' | 'move-down'; page: PageRef }
  | { op: 'open-tab' | 'close-tab' | 'tab-up' | 'tab-down'; tab: PanelTabRef }
  | { op: 'remove-tab'; tab: PageRef };

/** 布局记录各自最多几条；会话面板的标签连同宿主标签算 */
export const MAX_LAYOUT_ENTRIES = 50;
