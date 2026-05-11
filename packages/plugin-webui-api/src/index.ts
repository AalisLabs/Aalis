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
 * 扩展 core 中 WebuiPage 骨架接口，注入完整字段。
 *
 * 注意：core 中 `WebuiPage` 仅保留 `key`/`label`/`icon`/`order`/`renderer` 五个字段，
 * 这里通过 declaration merging 把 `content` 字段补全为强类型 `WebuiComponent[]`。
 */
declare module '@aalis/core' {
  interface WebuiPage {
    /** 声明式页面内容（不提供则使用客户端内置页面） */
    content?: WebuiComponent[];
  }
}

export {};
