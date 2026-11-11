# util-chromium — 启动 Chromium

`@aalis/util-chromium` 是浏览器工具（[plugin-tool-browser](../plugins/plugin-tool-browser.md)）与绘图（[plugin-draw](../plugins/plugin-draw.md)）共用的 Chromium 启动器，另提供绘图用的离线渲染 `OfflineRenderer`。它直接调用或构造，不登记服务。puppeteer 只由本包依赖，且在真要启动浏览器时才加载。

## 启动器

`launchChromium` 启动一个 Chromium，两边相同的启动参数只在这里给：

- `sandbox` 为真时带 Chromium 沙箱启动，启动失败就报错，不回落到不带沙箱；为假时以 `--no-sandbox --disable-setuid-sandbox` 启动。Chromium 本身启动失败时抛 `ChromiumLaunchError`（消息是 puppeteer 的原话），puppeteer 加载失败原样抛出、配置用不了抛 `PuppeteerConfigError`（见「只启动 Chrome」一条），调用方据此只在真是启动失败时提沙箱。
- 带 `--disable-dev-shm-usage`：共享内存改用临时目录，容器里的 `/dev/shm` 常常很小。
- SIGINT、SIGTERM、SIGHUP 不交给 puppeteer 处理，浏览器由调用方的生命周期关。
- 经管道连接：宿主不经停机退出（崩溃、被 SIGKILL、未捕获异常）时管道由系统关掉，浏览器随之退出。
- 只启动 Chrome，不随 puppeteer 配置里的默认浏览器（`PUPPETEER_BROWSER`、`.puppeteerrc`）：配成 Firefox 时，Chrome 的命令行参数（沙箱、共享内存，以及调用方给的网络闸、封网参数）它都不认，也不经管道连接。puppeteer 配置里的可执行文件是它默认浏览器的，默认浏览器不是 Chrome 而调用方又没给路径时不启动那个文件（当作 Chrome 启动会一直等到协议超时），抛 `PuppeteerConfigError` 写明原因与改法：在调用方的配置里给 Chrome 的路径，或去掉 puppeteer 配置里的可执行文件（`PUPPETEER_EXECUTABLE_PATH`，或 `.puppeteerrc` 的 `executablePath`）后重新启动 Aalis（puppeteer 只在加载时读一次配置，应用内的重启又沿用原来的环境变量）。

调用方给无头模式、浏览器路径、自己的启动参数（浏览器工具的网络闸、离线渲染的封网）、单条 CDP 命令的时限，以及可选的缺省视口。`bundledChromePath` 给出 puppeteer 自带 Chrome 的路径，浏览器工具据此判断要不要下载；puppeteer 的配置（`PUPPETEER_EXECUTABLE_PATH`、`.puppeteerrc`）指定了可执行文件时交回 `undefined`（自带的用不上）；默认浏览器配成别的（`PUPPETEER_BROWSER`、`.puppeteerrc`）时也交回 `undefined`（puppeteer 在启动之前按默认浏览器的版本算路径，判断不了自带的 Chrome 装没装）；`puppeteerCliPath` 给出 puppeteer 包里命令行脚本的路径。

`installBundledChrome` 下载自带的 Chrome。puppeteer 的命令行把压缩包下到缓存、再直接解到最终目录，被打断时留下的半截压缩包与安装目录会让之后的安装一直失败，或判为已装却无法启动；所以命令行经环境变量 `PUPPETEER_CACHE_DIR` 装进缓存根下本次新建的临时目录，装完整目录改名到 `<缓存根>/chrome/` 下的最终位置，临时目录随后删掉：下载或解压途中被打断不在缓存里留下不完整的安装。
- 缓存根取 puppeteer 配置里的 `cacheDirectory`（命令行与启动时找 Chrome 用的同一个）。
- 最终目录在而可执行文件不在的（此前在原地被打断留下的）换成这次装好的；可执行文件已在的留着。可执行文件已解出、别的文件缺的旧安装判不出来，照常当已装。
- 版本配成别名时，命令行记下的别名并进缓存里的 `.metadata`。
- 安装前删掉宿主中途崩溃留下的临时目录：只删本模块起名（前缀加创建时刻）且创建早于安装时限（5 分钟）加 1 分钟余量的；删不掉的（那次的命令行还占着文件）留到下次，不挡这次安装。
- Windows 上改名与装成之后删临时目录遇 `EPERM`、`EACCES`、`EBUSY`（杀毒软件短暂占住刚解出的文件）时隔一会儿再试，至多 20 次。没装成（命令行失败、被中止）的临时目录只删一次，删不掉的留给之后安装前的过期清理，报的仍是原来的错误。

命令行由调用方经自己的进程服务跑：`installBundledChrome` 交出参数、环境与时限，调用方须在时限到时停掉它，退出码不为 0 时抛错，正常时交回 stdout。

## 离线渲染

`OfflineRenderer` 供绘图使用。构造时给 `sandbox`：为真时带 Chromium 沙箱启动，启动失败就报错，不回落到不带沙箱；为假时以 `--no-sandbox --disable-setuid-sandbox` 启动。绘图按自己的配置 `sandbox` 传，默认为假。浏览器无法启动时抛 `RenderUnavailableError`（Chromium 本身启动失败时 `cause` 是 `ChromiumLaunchError`；puppeteer 加载失败时消息写「加载 puppeteer 失败」，puppeteer 的配置用不了时写「puppeteer 的配置用不了」）。可设置浏览器路径、无头模式、并发数、空闲关停时间和步骤超时。

`renderPng` 接收入口 URL、精确的资源映射、视口、截图区域和取消信号。JavaScript 关闭，每次建立独立浏览器上下文；资源映射之外的网络请求被拦截，启动参数再把漏过的连接送往本机死端口。`renderFrames` 用于受控动画采样。使用结束须调用 `dispose()`；步骤超时会淘汰可能卡住的浏览器实例。

这是一项渲染能力，不是对任意 HTML 的安全证明。渲染失败不能视为“文件没有内容”。
