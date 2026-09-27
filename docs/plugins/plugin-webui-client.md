# plugin-webui-client — WebUI 前端

**包名**: `@aalis/plugin-webui-client`  
**源码**: `packages/plugin-webui-client/src/main.tsx`（前端入口；托管方见 `packages/plugin-webui-server/src/client-discovery.ts`）

## 概述

Aalis 默认 WebUI 前端：React SPA 的**纯静态资源包**。它**不是插件**——没有 `apply`、没有 `meta`，
runtime 不加载它；打包产物由 `@aalis/plugin-webui-server` 托管。

## 包声明

```jsonc
// package.json
{
  "aalis": { "client": true },   // 前端标记：webui-server 据此发现
  "keywords": ["aalis", "aalis-interface"],
  "files": ["dist"]              // 构建产物 dist/index.html + 静态资源
}
```

## 配置

无配置项。

## 工作方式

1. 构建脚本 `tsc --noEmit && vite build` 先做类型检查，再产出 `dist/index.html` 及静态资源
2. webui-server 在 `app:ready` 时由 `client-discovery.ts` 扫描：`package.json` 标了
   `aalis.client: true` 且存在 `dist/index.html` 的包即为前端候选（不认任何具体包名）
3. webui-server 把每个候选注册成一条 `webui-client` 服务 provider（`getClientDir()`）
4. 活跃前端 = `webui-client` 的服务解析结果（`servicePreferences['webui-client']` 偏好 >
   provider 优先级 > 注册顺序），由 webui-server 挂成 Express 静态目录；在 WebUI「服务」页
   切换偏好即实时重挂 + 广播 `reload`，无需重启

第三方要换前端，正解就是照上面打 `aalis.client` 标记（详见 `docs/services/webui.md` 第 4b 节），
不需要写插件。

## 前端技术栈

前端源码位于 `packages/plugin-webui-client/src/`：
- React + TypeScript
- Vite 构建
- WebSocket 实时通信（useWebSocket hook）

## 前端页面

| 页面 | 说明 |
|---|---|
| Chat | 实时对话、流式输出、内联工具调用展示、待办事项面板 |
| Plugins | 插件列表、启用/禁用、配置编辑 |
| Platforms | 平台连接状态监控 |
| Files | 文件管理器（浏览、重命名、下载、详情、删除） |
| Logs | 实时日志流 |
| Sessions | 会话管理（session-manager 登记的页面，由内置页面渲染，见下文） |
| DynamicPage | 插件注册的动态页面（技能库、白纸页等） |

会话页配置编辑器的「白纸与远端」一组编辑白纸与远端代理的房间键与记忆召回范围：`paperEnabled` 是开关，写法与另外两个开关相同：未覆盖时显示继承值，点一下即写成显式的开或关；`paperName` 留空即继承；`remoteAgentTypes` 以逗号分隔输入、保存为数组，留空即继承；三项上限留空即继承；`memoryRecallScope` 可选继承、仅本会话、同平台、全部。`remoteAgentTypes` 来自平台档时显示告警「平台档里写了远端类型，这个平台所有房间都会继承」，来自受众条目时「所有房间」换成「的所有群」或「的所有私聊」。

DynamicPage 的表格支持文件单元格（`render: 'file'`，契约见 [api-webui](../api/api-webui.md)）：只有 PNG、JPEG、GIF、WebP 位图能在弹窗里查看，其他类型（含 HTML、SVG）只能下载，下载的 Blob 一律为 `application/octet-stream`，保存的文件名去掉路径分隔符，对象 URL 用完即回收。

## 会话管理页

session-manager 登记的「会话管理」页（`renderer: 'sessions'`）由内置的会话页渲染，数据经 session-manager 的页面动作取得：

- **分区**：列表取页面动作 `getSessionTree`，按服务端分好的区画出「我的会话」（owner 的 WebUI、CLI 会话等没有出生平台的会话）与「IM 房间」（群与私聊），空区不显示。分区在服务端判定，客户端只负责画。
- **子会话**：只挂在发起它的会话下面，默认收起，点开才显示。
- **批量操作**：批量模式下每个分区标题旁各有一个「全选」，只选中本区的会话（含收起的子会话），不动其他区的选中项；页头只保留「取消」与批量归档、批量删除。
- **继承来源**：配置编辑器里未覆盖的字段显示继承值与来源（页面动作 `getInheritance`），IM 房间按出生平台显示；值来自受众条目时标为「平台档 `<平台>`（私聊）」或「平台档 `<平台>`（群）」。
- **删除确认**：删除会经会话级 `memory:clear` 清空会话的消息历史与长期记忆（摘要、向量记忆等），确认框写明这一点，并说明子会话一并删除、无法撤销，会话里（含子会话）用 `exec_background` 起、仍在运行的后台进程一并终止（plugin-tool-system 收听 `session:deleted`）。删除 IM 房间（「IM 房间」区的根会话）时另写明聊天平台里的消息不受影响，房间之后再来消息会重新出现在列表里、记忆从零开始。批量删除的选中项含 IM 房间时，确认框先写出其中 IM 房间的个数，再接 IM 房间的说明。

## 流恢复 (Stream Resume)

前端通过 `stream_resume` WebSocket 消息类型支持页面刷新后的流恢复。当用户刷新页面时，服务端将已缓冲的流式内容一次性推送，实现无缝续流体验。

## 动效系统

前端内置多种 CSS 动画：
- `msg-in` — 消息入场（fade + 向上滑入）
- `page-fade` — 页面切换过渡
- `modal-scale` — 弹窗缩放入场
- `fade-in` — 通用淡入
- `typingBounce` — 打字指示器跳动
- `cursor-blink` — 光标闪烁
- `pulse` — 脉冲效果
- 按钮 `:active` 按压反馈（scale 0.97）
