# util-chromium — 启动 Chromium

`@aalis/util-chromium` 是浏览器工具（[plugin-tool-browser](../plugins/plugin-tool-browser.md)）与绘图（[plugin-draw](../plugins/plugin-draw.md)）共用的 Chromium 启动器，另提供绘图用的离线渲染 `OfflineRenderer`。它直接调用或构造，不登记服务。puppeteer 只由本包依赖，且在真要启动浏览器时才加载。

## 启动器

`launchChromium` 启动一个 Chromium，两边相同的启动参数只在这里给：

- `sandbox` 为真时带 Chromium 沙箱启动，起不来就报错，不回落到不带沙箱；为假时以 `--no-sandbox --disable-setuid-sandbox` 启动。Chromium 本身起不来时抛 `ChromiumLaunchError`（消息是 puppeteer 的原话），puppeteer 加载失败原样抛出，调用方据此只在真是启动失败时提沙箱。
- 带 `--disable-dev-shm-usage`：共享内存改用临时目录，容器里的 `/dev/shm` 常常很小。
- SIGINT、SIGTERM、SIGHUP 不交给 puppeteer 处理，浏览器由调用方的生命周期关。
- 经管道连接：宿主不经停机退出（崩溃、被 SIGKILL、未捕获异常）时管道由系统关掉，浏览器随之退出。

调用方给无头模式、浏览器路径、自己的启动参数（浏览器工具的网络闸、离线渲染的封网）、单条 CDP 命令的时限，以及可选的缺省视口。`bundledChromePath` 给出 puppeteer 自带 Chrome 的路径，`puppeteerEntry` 给出 puppeteer 包入口的地址，浏览器工具据此判断 Chrome 装没装、用包里的命令行下载它。

## 离线渲染

`OfflineRenderer` 供绘图使用。构造时给 `sandbox`：为真时带 Chromium 沙箱启动，起不来就报错，不回落到不带沙箱；为假时以 `--no-sandbox --disable-setuid-sandbox` 启动。绘图按自己的配置 `sandbox` 传，默认为假。浏览器起不来时抛 `RenderUnavailableError`（Chromium 本身起不来时 `cause` 是 `ChromiumLaunchError`；puppeteer 加载失败时消息写「加载 puppeteer 失败」）。可设置浏览器路径、无头模式、并发数、空闲关停时间和步骤超时。

`renderPng` 接收入口 URL、精确的资源映射、视口、截图区域和取消信号。JavaScript 关闭，每次建立独立浏览器上下文；资源映射之外的网络请求被拦截，启动参数再把漏过的连接送往本机死端口。`renderFrames` 用于受控动画采样。使用结束须调用 `dispose()`；步骤超时会淘汰可能卡住的浏览器实例。

这是一项渲染能力，不是对任意 HTML 的安全证明。渲染失败不能视为“文件没有内容”。
