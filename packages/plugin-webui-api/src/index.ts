// ----- WebUI 服务接口与声明式页面组件 -----
//
// 此包提供 @aalis/core 中 WebuiPage skeleton 的完整扩展，
// 以及所有声明式页面组件类型。
// 任何需要声明 webuiPages 的插件应从本包导入相关类型。

import type { ConfigSchema } from '@aalis/core';

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
  columns: Array<{ key: string; label: string; render?: string }>;
  actions?: Array<{ label: string; method: string; confirm?: string; danger?: boolean }>;
  refresh?: number;
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

/** 所有声明式页面组件的联合类型 */
export type WebuiComponent =
  | WebuiStatComponent
  | WebuiTableComponent
  | WebuiFormComponent
  | WebuiActionsComponent
  | WebuiInfoComponent
  | WebuiMarkdownComponent
  | WebuiTabsComponent;

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
 * 通过 declaration merging 向 core 的 PluginModule 注入 webuiPages 字段。
 *
 * 这样 core 不需要知道 WebuiPage 的存在，但任何 import 本包的插件都能在 PluginModule 上看到该字段。
 */
declare module '@aalis/core' {
  interface PluginModule {
    /** 插件声明的 WebUI 页面列表 */
    webuiPages?: WebuiPage[];
    /** 声明该插件对 core 的扩展（新增事件、钩子），仅用于前端展示。 */
    extends?: ExtendDeclaration;
  }
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
