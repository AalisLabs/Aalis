// ----- WebUI 服务接口 -----
//
// WebUI 服务契约、页面与提示的登记门面（页面契约见 page.ts，插件前端的消息通道见 frame.ts）、管理面推送（/admin）的
// 事件类型、主题的令牌表与文件格式（theme.ts），以及服务描述符。

import type { LogEntry, ServiceRef } from '@aalis/core';
import { defineService, serviceRef } from '@aalis/core';
import type { Notice, NoticeHandle, PageDefinition, PageHandle, PagePlacement } from './page.js';

/**
 * WebUI 服务 —— Web 管理后台
 *
 * 负责启动 HTTP 服务器，提供 REST API（插件管理、配置、页面等）与 WebSocket（会话协议、管理面推送），
 * 同时托管前端静态文件。
 *
 * 默认由 plugin-webui-server 提供，第三方可替换整个实现或仅替换前端部分。插件不直接调登记方法，经绑定接口
 * {@link BoundWebui} 的 definePage 与 notify 登记，归属与撤回由门面管。
 */
export interface WebUIService {
  /** 获取 HTTP 服务监听端口 */
  getPort(): number;
  /** 获取 HTTP 服务监听地址 */
  getHost(): string;
  /**
   * 登记一个页面，归属插件实例 instance；同一实例同一 key 再登记就是替换。按质量门槛校验（见 PageDefinition），
   * 不过就不登记并记一条错误日志。返回撤回，只撤这一次登记
   */
  addPage(page: PageDefinition, instance: string): () => void;
  /** 页面数据变了：推给打开着它的界面，按实例、页面、组件与会话合并短时间内的连发 */
  invalidate(instance: string, pageKey: string, componentId?: string, sessionId?: string): void;
  /**
   * 登记一条提示，归属插件实例 instance；同一实例同一 id 再登记就是替换。open 指向的不是本实例位置为 plugin 或
   * settings 的页面时不登记并记一条错误日志。返回撤回，只撤这一次登记
   */
  addNotice(notice: Notice, instance: string): () => void;
}

/**
 * 通过 declaration merging 向插件定义注入展示元数据 extends。
 * 页面与提示不是静态字段：在 apply 里经 webuiServer 的 definePage 与 notify 登记。
 */
declare module '@aalis/core' {
  interface PluginMeta {
    /** 声明该插件对 core 的扩展（新增事件、钩子），仅用于前端展示。 */
    extends?: ExtendDeclaration;
  }
}

/**
 * 插件可以声明它对 core 做了哪些扩展，用于前端展示和文档生成。
 *
 * 仅是元数据描述，core 不会读取也不会校验，仅透传给 WebUI 展示。写在 definePlugin 的 `extends` 字段里：
 *
 * @example
 * definePlugin({
 *   name: '@aalis/plugin-scheduler',
 *   extends: { events: ['scheduler:tick', 'scheduler:error'], hooks: ['schedule:before'] },
 *   …
 * });
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
 * - 这是 **WebUI 展示层契约**：插件列表（`GET /api/plugins`）给出每个插件声明的 `subsystem`，界面的插件区按它分组，
 *   组名与顺序取本表。
 * - `core` 不解释 subsystem 的取值，插件定义上只有一个透传的字符串字段
 *   `subsystem?: string`（不读不解释，纯粹搬运给 WebUI）。
 * - 本表只描述 **展示元数据**（中文 label / 排序），**不写死插件归属**。
 *   归属由每个插件在 `definePlugin({ subsystem: 'llm' })` 中声明。
 *
 * 解耦收益：
 *   - 新增插件不需要改 api-webui（只改插件自身）
 *   - 新增子系统：只在本表加一行元数据即可（id 未匹配时回退为 id 直接展示）
 *   - api-webui 不再反向耦合具体插件 npm 名
 */
export interface SubsystemMetadata {
  /** subsystem id（与插件定义的 subsystem 字段对应） */
  id: string;
  /** 显示名（中文 label） */
  label: string;
  /** 排序权重，越小越靠前 */
  order: number;
}

/**
 * 默认子系统元数据。
 *
 * 仅提供常用 id 的中文 label 与排序；插件可任意自定义 subsystem id，未命中本表的按 id 原样显示、排在表里的之后，
 * 没声明的排在最后。
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

/**
 * 前端提供者（忒修斯之船「换前端」契约）：把一份已构建的前端静态目录交给
 * webui-server 托管。第三方前端两条接入：
 * - **纯静态包**：package.json 标 `aalis.client: true` + 含 `dist/index.html`，被
 *   webui-server 自动发现挂载（无需 `apply`，runtime 不会把它当插件加载）。
 * - **主动覆盖**：插件 `apply` 里 `provide(webuiClient, impl, { label })`，优先于自动发现；
 *   多前端切换时显示的名字优先取提供方插件的 `displayName`，没有时取 provide 的 `label` 选项。
 */
export interface WebuiClientProvider {
  /** 返回含 index.html 的前端静态目录绝对路径 */
  getClientDir(): string;
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const webuiClient = defineService<WebuiClientProvider>('webui-client');

// ===== 服务描述符（按激活绑定）=====

/** `webui-server` 的绑定接口：页面与提示的登记归属这次激活，提供者换人自动重挂，停用时同一拍撤回 */
export interface BoundWebui extends ServiceRef<WebUIService> {
  /**
   * 登记一个页面：声明式页面的组件、数据源、动作与处理函数一次给出，返回形状按组件种类推出，引用了没声明的动作在编译期
   * 报错；插件前端页面给出框架所在的模块、数据源与动作，输入按声明推出。要在引用它的 notify 之前登记
   */
  definePage<
    const P extends PagePlacement = 'plugin',
    const S extends Record<string, unknown> = Record<never, never>,
    const R extends Record<string, unknown> = Record<never, never>,
  >(page: PageDefinition<P, S, NoInfer<keyof S & string>, R>): PageHandle;
  /** 发一条提示；同一个 id 再发一次就是替换 */
  notify(notice: Notice): NoticeHandle;
}

export const webuiServer = defineService<WebUIService, BoundWebui>('webui-server', port => {
  // 先建页面的账本：提供者换人时按创建次序重挂，提示的 open 要在它指向的页面挂上之后才核得过
  const pages = port.registrar<PageDefinition>({
    key: page => page.key,
    register: (service, page) => service.addPage(page, port.id),
  });
  const notices = port.registrar<Notice>({
    key: notice => notice.id,
    register: (service, notice) => service.addNotice(notice, port.id),
  });
  const facade: Pick<BoundWebui, 'definePage' | 'notify'> = {
    definePage(page) {
      pages.add(page as PageDefinition);
      return {
        invalidate: (componentId, sessionId) => port.current()?.invalidate(port.id, page.key, componentId, sessionId),
      };
    },
    notify: notice => ({ clear: notices.add(notice) }),
  };
  return serviceRef(port, facade);
});

// ----- 管理面推送 -----
//
// 会话之外的推送走 WebUI 的 WebSocket 端点 `/admin`，与会话协议的 `/session` 分开，认证相同（cookie 里的 token）。
// 每个文本帧是一个 JSON 对象，`type` 区分种类。这里只给类型：服务端不校验自己发出的帧，前端照它实现。

/** 前端发往 `/admin` 的消息：日志页打开时订阅实时日志，离开时退订。认不出的消息服务端忽略，连接照常 */
export type WebuiAdminClientMessage = { type: 'log.subscribe' } | { type: 'log.unsubscribe' };

/**
 * `/admin` 推给前端的事件：
 * - `log`：一条新日志，只推给订阅了的连接。先订阅、再取 `GET /api/logs/tail`，两边按 `seq` 去重；
 * - `plugins.changed`：插件状态可能变了，或页面登记表变了，前端重取插件与页面（`GET /api/plugins`、`GET /api/pages`）。
 *   一次启停可能连着推几条，服务端不合并；
 * - `page.invalidate`：插件说这一页的数据变了。带 componentId 时只重取这个组件；带 sessionId 时只有打开着这个会话的面板重取。
 *   服务端按这四项合并短时间内的连发；
 * - `layout.changed`：owner 的布局记录（固定的页面、会话面板的标签）变了，前端重取 `GET /api/layout`；
 * - `app.restarting`：应用即将重启，连接随后断开；
 * - `client.reload`：前端偏好改了或有前端包被卸载，活跃前端可能换了，前端整页重新加载。
 */
export type WebuiAdminEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'plugins.changed' }
  | { type: 'page.invalidate'; instance: string; pageKey: string; componentId?: string; sessionId?: string }
  | { type: 'layout.changed' }
  | { type: 'app.restarting' }
  | { type: 'client.reload' };

// ----- 页面与提示，见 page.ts；插件前端的消息通道，见 frame.ts；主题的令牌表、文件格式与内置主题，见 theme.ts -----

export * from './frame.js';
export * from './page.js';
export * from './theme.js';
