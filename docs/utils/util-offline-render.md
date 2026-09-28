# util-offline-render — 离线渲染

`@aalis/util-offline-render` 提供 `OfflineRenderer`，供绘图和作品审核共用。它直接构造，不登记服务。

构造时选择沙箱策略：审核使用 `required`，浏览器沙箱不可用就失败；绘图的 `preferred` 策略允许明确回落。可设置浏览器路径、无头模式、并发数、空闲关停时间和步骤超时。

`renderPng` 接收入口 URL、精确的资源映射、视口、截图区域和取消信号。JavaScript 关闭，每次建立独立浏览器上下文；资源映射之外的网络请求被拦截。`renderFrames` 用于受控动画采样。使用结束须调用 `dispose()`；步骤超时会淘汰可能卡住的浏览器实例。

这是一项渲染能力，不是对任意 HTML 的安全证明。渲染失败不能视为“文件没有内容”；审核方必须按无法检查处理。
