# util-offline-render — 离线渲染

`@aalis/util-offline-render` 提供 `OfflineRenderer`，现在只有绘图（[plugin-draw](../plugins/plugin-draw.md)）使用。它直接构造，不登记服务。

构造时选择沙箱策略：`required` 在浏览器沙箱不可用时失败；`preferred`（绘图用它）允许明确回落。可设置浏览器路径、无头模式、并发数、空闲关停时间和步骤超时。

`renderPng` 接收入口 URL、精确的资源映射、视口、截图区域和取消信号。JavaScript 关闭，每次建立独立浏览器上下文；资源映射之外的网络请求被拦截。`renderFrames` 用于受控动画采样。使用结束须调用 `dispose()`；步骤超时会淘汰可能卡住的浏览器实例。

这是一项渲染能力，不是对任意 HTML 的安全证明。渲染失败不能视为“文件没有内容”。
