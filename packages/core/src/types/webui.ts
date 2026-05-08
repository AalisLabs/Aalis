// ----- WebUI 服务接口与声明式页面组件 -----

import type { ConfigSchema } from './core.js';

/**
 * WebUI 服务 —— Web 管理后台
 *
 * 负责启动 HTTP 服务器，提供 REST API（插件管理、配置、权限等）
 * 和 WebSocket（消息/日志推送），同时托管前端静态文件。
 *
 * 核心要求此服务必须运行。
 * 默认由 plugin-webui 提供，第三方可替换整个实现或仅替换前端部分。
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
}

// -- 声明式页面组件类型 --

/** 统计卡片 */
export interface WebuiStatComponent {
  type: 'stat';
  /** 卡片标题 */
  label: string;
  /** 获取数据的后端 handler 方法名，返回 { value: string | number } */
  source: string;
  /** 图标标识 */
  icon?: string;
}

/** 数据表格 */
export interface WebuiTableComponent {
  type: 'table';
  /** 表格标题 */
  label?: string;
  /** 获取数据的后端 handler 方法名，返回数组 */
  source: string;
  /** 列定义 */
  columns: Array<{ key: string; label: string; render?: string }>;
  /** 行操作按钮 */
  actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean }>;
  /** 自动刷新间隔（秒），0 或不填则不自动刷新 */
  refresh?: number;
}

/** 配置表单（复用 ConfigSchema） */
export interface WebuiFormComponent {
  type: 'form';
  /** 表单标题 */
  label?: string;
  /** 加载初始值的 handler 方法名 */
  source: string;
  /** 保存时调用的 handler 方法名 */
  save: string;
  /** 表单字段定义，复用 ConfigSchema */
  schema: ConfigSchema;
}

/** 操作按钮组 */
export interface WebuiActionsComponent {
  type: 'actions';
  /** 按钮组标题 */
  label?: string;
  /** 按钮列表 */
  items: Array<{ label: string; method: string; confirm?: string; danger?: boolean; variant?: string }>;
}

/** 键值信息面板 */
export interface WebuiInfoComponent {
  type: 'info';
  /** 面板标题 */
  label?: string;
  /** 获取数据的 handler 方法名，返回 Record<string, unknown> */
  source: string;
}

/** Markdown 内容 */
export interface WebuiMarkdownComponent {
  type: 'markdown';
  /** 标题 */
  label?: string;
  /** 获取 markdown 文本的 handler 方法名，返回 { content: string } */
  source: string;
}

/** 子标签页容器 */
export interface WebuiTabsComponent {
  type: 'tabs';
  /** 容器标题 */
  label?: string;
  /** 子标签页定义 */
  items: Array<{ key: string; label: string; content: WebuiComponent[] }>;
}

/** 所有声明式页面组件的联合类型 */
export type WebuiComponent =
  | WebuiStatComponent
  | WebuiTableComponent
  | WebuiFormComponent
  | WebuiActionsComponent
  | WebuiInfoComponent
  | WebuiMarkdownComponent
  | WebuiTabsComponent;

/** 插件可声明的 WebUI 页面 */
export interface WebuiPage {
  /** 页面唯一标识（对应前端路由/标签 key） */
  key: string;
  /** 页面显示名称 */
  label: string;
  /**
   * 图标标识。支持两种格式：
   * - 命名标识（如 'dashboard'）：前端映射到内置图标组件
   * - 内联 SVG（以 '<svg' 开头）：前端直接渲染为图标
   */
  icon?: string;
  /** 排序权重（越小越靠前，默认 99） */
  order?: number;
  /**
   * 自定义渲染器标识。
   * 当页面需要客户端的专用组件（而非声明式 content）时，插件声明此字段。
   * 客户端根据此标识在自身的渲染器注册表中查找对应组件：
   * - 找到 → 使用自定义组件渲染
   * - 未找到 → 显示「此客户端不支持该页面」的提示
   * 这样不同 webui 客户端可独立决定支持哪些自定义页面。
   */
  renderer?: string;
  /** 声明式页面内容（不提供则使用客户端内置页面） */
  content?: WebuiComponent[];
}
