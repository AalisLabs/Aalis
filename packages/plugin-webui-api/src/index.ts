// ----- WebUI 服务接口与声明式页面组件 -----
//
// 此包提供 @aalis/core 中 WebuiPage skeleton 的完整扩展，
// 以及所有声明式页面组件类型。
// 任何需要声明 webuiPages 的插件应从本包导入相关类型。

import type { ConfigSchema, Context } from '@aalis/core';

/**
 * WebUI 服务 —— Web 管理后台
 *
 * 负责启动 HTTP 服务器，提供 REST API（插件管理、配置、权限等）
 * 和 WebSocket（消息/日志推送），同时托管前端静态文件。
 *
 * 核心要求此服务必须运行。
 * 默认由 plugin-webui-server 提供，第三方可替换整个实现或仅替换前端部分。
 */
export interface WebUIService {
  /** 获取 HTTP 服务监听端口 */
  getPort(): number;
  /** 获取 HTTP 服务监听地址 */
  getHost(): string;
  /**
   * 设置前端静态文件目录
   * 允许外部插件在运行时替换前端
   */
  setClientDir?(dir: string): void;
  /** 注册一个 WebUI 页面；返回 dispose */
  registerPage(page: WebuiPage, pluginName: string): () => void;
  /** 列出当前所有已注册的页面（含插件归属） */
  getPages(): Array<WebuiPage & { pluginName: string }>;
  /** 按插件名批量清除（供插件卸载时调用） */
  unregisterByPlugin(pluginName: string): void;
}

// -- 声明式页面组件类型 --

/** 统计卡片 */
export interface WebuiStatComponent {
  type: 'stat';
  label: string;
  source: string;
  icon?: string;
}

/** 数据表格 */
export interface WebuiTableComponent {
  type: 'table';
  label?: string;
  source: string;
  columns: Array<{
    key: string;
    label: string;
    render?: string;
    nowrap?: boolean;
    minWidth?: number;
    maxWidth?: number;
  }>;
  actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean }>;
  refresh?: number;
  /** 启用前端本地文本搜索（空格分隔多关键词，AND 语义，对所有列值做不区分大小写子串匹配） */
  searchable?: boolean;
  /** 搜索框 placeholder（searchable=true 时生效） */
  searchPlaceholder?: string;
}

/** 配置表单（复用 ConfigSchema） */
export interface WebuiFormComponent {
  type: 'form';
  label?: string;
  source: string;
  save: string;
  schema: ConfigSchema;
}

/** 操作按钮组 */
export interface WebuiActionsComponent {
  type: 'actions';
  label?: string;
  items: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }>;
}

/** 键值信息面板 */
export interface WebuiInfoComponent {
  type: 'info';
  label?: string;
  source: string;
}

/** Markdown 内容 */
export interface WebuiMarkdownComponent {
  type: 'markdown';
  label?: string;
  source: string;
}

/** 子标签页容器 */
export interface WebuiTabsComponent {
  type: 'tabs';
  label?: string;
  items: Array<{ key: string; label: string; content: WebuiComponent[] }>;
}

/**
 * 交互式关系图组件（基于 Cytoscape）。
 *
 * `source` 后端方法签名: `(args: { focusId?: string; maxDepth?: number; maxBreadth?: number; filters?: Record<string, unknown> })`
 * 返回 cytoscape 风格的 elements：
 * ```ts
 * {
 *   nodes: Array<{ data: { id: string; label: string; kind: 'person' | 'event' | string; [k: string]: unknown } }>;
 *   edges: Array<{ data: { id: string; source: string; target: string; label?: string; relationType?: string; [k: string]: unknown } }>;
 *   focusId?: string;
 *   stats?: Record<string, number | string>;
 * }
 * ```
 *
 * `detailSource` 可选：节点被点击时调用，签名 `(args: { nodeId: string; kind: string })`，返回任意键值对 → 右侧 Drawer 渲染。
 */
export interface WebuiGraphComponent {
  type: 'graph';
  label?: string;
  source: string;
  detailSource?: string;
  /** 节点最大深度/宽度默认值（前端展示初值） */
  defaultMaxDepth?: number;
  defaultMaxBreadth?: number;
  /** 自动刷新（毫秒），0 / undefined = 关闭 */
  refresh?: number;
  /** 顶部右上角额外按钮 */
  actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }>;
}

/** 所有声明式页面组件的联合类型 */
export type WebuiComponent =
  | WebuiStatComponent
  | WebuiTableComponent
  | WebuiFormComponent
  | WebuiActionsComponent
  | WebuiInfoComponent
  | WebuiMarkdownComponent
  | WebuiTabsComponent
  | WebuiGraphComponent;

/**
 * 插件可声明的 WebUI 页面 —— 完整定义。
 *
 * 由本包直接导出（core 不再持有 WebuiPage 骨架）。
 */
export interface WebuiPage {
  /** 页面唯一标识（对应前端路由/标签 key） */
  key: string;
  /** 页面显示名称 */
  label: string;
  /** 图标标识（命名标识或内联 SVG） */
  icon?: string;
  /** 排序权重（越小越靠前，默认 99） */
  order?: number;
  /** 自定义渲染器标识（非声明式 content 场景） */
  renderer?: string;
  /** 声明式页面内容（不提供则使用客户端内置页面） */
  content?: WebuiComponent[];
}

/**
 * 通过 declaration merging 向 core 的 PluginModule 注入
 * 纯展示元数据字段（subsystem / extends）。
 *
 * WebuiPage 注册路径为运行时 `useWebuiService(ctx).registerPage(...)`，
 * 不作为静态 module 字段存在。
 */
declare module '@aalis/core' {
  interface PluginModule {
    /**
     * 子系统归属，仅用于 WebUI 分组展示。
     *
     * 可用 id 与中文 label 由本包的 `DEFAULT_SUBSYSTEM_METADATA` 提供，
     * 但允许使用任意自定义字符串（未匹配 metadata 时直接以 id 作为 label 显示）。
     */
    subsystem?: string;
    /** 声明该插件对 core 的扩展（新增事件、钩子），仅用于前端展示。 */
    extends?: ExtendDeclaration;
  }
}

// ----- 领域 helper -----

/**
 * Scoped WebUI 服务：在插件 apply() 中注册页面，自动绑定到当前 ctx 生命周期。
 */
export interface ScopedWebuiService {
  /** 注册页面；返回 dispose（与 ctx 生命周期绑定）。 */
  registerPage(page: WebuiPage): () => void;
  /** 获取底层 service（未就绪时为 undefined）。 */
  readonly raw: WebUIService | undefined;
}

/**
 * 获取 ScopedWebuiService。
 *
 * 关键：`registerPage` 必须在 webui-server **每一次** provide 时都重新注册，
 * 而不是只在调用时刻注册一次：
 *
 * - 旧实现：fast-path 直接 `svc.registerPage(...)`，回退时用一次性的
 *   `whenService`。webui-server bounce/reload 后，新 service 实例的 pages 表
 *   是空的，导致页面"消失"。
 * - 新实现：保留 fast-path（首次注册无延迟），同时**始终**订阅
 *   `service:registered`，每次新实例上线都重新调用 registerPage 把页面挂回去。
 *
 * 调用者拿到的 dispose 会同时撤销监听与当前 service 上的注册。
 */
export function useWebuiService(ctx: Context): ScopedWebuiService {
  const pluginName = ctx.id || 'unknown';
  return {
    registerPage(page: WebuiPage): () => void {
      let disposed = false;
      let disposeInner: (() => void) | undefined;

      const attach = (svc: WebUIService): void => {
        if (disposed) return;
        disposeInner?.();
        disposeInner = svc.registerPage(page, pluginName);
      };

      // 跨 bounce 重新挂载：webui-server 每次 provide 都触发
      const offSub = ctx.on('service:registered', (svcName: string) => {
        if (svcName !== 'webui-server') return;
        const svc = ctx.getService<WebUIService>('webui-server');
        if (svc) attach(svc);
      });

      // 立即注册（如果当前已就绪）
      const current = ctx.getService<WebUIService>('webui-server');
      if (current) attach(current);

      return () => {
        disposed = true;
        offSub();
        disposeInner?.();
        disposeInner = undefined;
      };
    },
    get raw() {
      return ctx.getService<WebUIService>('webui-server');
    },
  };
}

/**
 * 插件可以声明它对 core 做了哪些扩展，用于前端展示和文档生成。
 *
 * 仅是元数据描述，core 不会读取也不会校验，仅透传给 WebUI 展示。
 *
 * @example
 * export const extends_: ExtendDeclaration = {
 *   events: ['scheduler:tick', 'scheduler:error'],
 *   hooks: ['schedule:before'],
 * };
 */
export interface ExtendDeclaration {
  /** 该插件新增的自定义事件名 */
  events?: string[];
  /** 该插件新增的自定义钩子名 */
  hooks?: string[];
}

// ----- 子系统展示目录 -----

/**
 * 子系统展示目录条目。
 *
 * **职责边界**：
 * - 这是 **WebUI 展示层契约**，唯一消费者是 webui-server 的 `/api/service-groups` 路由。
 * - `core` 完全不知道 subsystem 概念，仅在 PluginModule 上保留一个透传字段
 *   `subsystem?: string`（不读不解释，纯粹搬运给 WebUI）。
 * - 本表只描述 **展示元数据**（中文 label / 排序 / icon），**不再写死插件归属**。
 *   归属由每个插件自己在 index.ts 中声明：`export const subsystem = 'llm';`
 *
 * 解耦收益：
 *   - 新增插件不需要改 webui-api（只改插件自身）
 *   - 新增子系统：只在本表加一行元数据即可（id 未匹配时回退为 id 直接展示）
 *   - webui-api 不再反向耦合具体插件 npm 名
 */
export interface SubsystemMetadata {
  /** subsystem id（与 PluginModule.subsystem 对应） */
  id: string;
  /** 显示名（中文 label） */
  label: string;
  /** 排序权重，越小越靠前 */
  order: number;
}

/**
 * 默认子系统元数据。
 *
 * 仅提供常用 id 的中文 label 与排序；插件可任意自定义 subsystem id，
 * 未命中本表时 WebUI 会回退到「id 原样展示，order=9999」。
 */
export const DEFAULT_SUBSYSTEM_METADATA: readonly SubsystemMetadata[] = Object.freeze([
  { id: 'system', label: '系统', order: 0 },
  { id: 'core', label: '核心', order: 10 },
  { id: 'platform', label: '平台', order: 20 },
  { id: 'agent', label: 'Agent', order: 30 },
  { id: 'llm', label: 'LLM', order: 40 },
  { id: 'embedding', label: 'Embedding', order: 50 },
  { id: 'memory', label: '记忆', order: 60 },
  { id: 'persona', label: '人格', order: 70 },
  { id: 'tools', label: '工具', order: 80 },
  { id: 'storage', label: '存储', order: 85 },
  { id: 'message', label: '消息', order: 90 },
  { id: 'session', label: '会话', order: 100 },
  { id: 'skills', label: '技能', order: 110 },
  { id: 'scheduler', label: '调度', order: 120 },
  { id: 'authority', label: '权限', order: 130 },
  { id: 'user', label: '用户', order: 140 },
  { id: 'external', label: '外部', order: 160 },
]);

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'webui-server': WebUIService;
  }
}
