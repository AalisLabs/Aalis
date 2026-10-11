// 重测试：起真浏览器、起构建、中止真实子进程断言时限，或起真实子进程与联网的集成测试。推送前的快测试（AALIS_TEST_SCOPE=quick）不跑它们，
// 合进 dev 与发布之前手动跑全量时才跑，见 CONTRIBUTING.md 第 2 节。新加这类测试要登记在这里，
// test/architecture/heavy-tests.test.ts 守着直接导入 puppeteer 或用 e2e 夹具的文件都在名单里。

/** 启动真浏览器的测试：在单线程池里依次跑，几个 Chrome 同时开、再叠上全量测试的负载，会轮流超时 */
export const BROWSER_TESTS = [
  '**/test/plugins/draw-render.test.ts',
  '**/test/plugins/draw-animation.test.ts',
  '**/test/plugins/draw-delivery-chain.test.ts',
  '**/test/plugins/tool-browser-ssrf-gate.test.ts',
  '**/test/plugins/tool-browser-background-page.test.ts',
  '**/test/plugins/tool-browser-screenshot.test.ts',
  '**/test/plugins/tool-browser-screenshot-timeout.test.ts',
  '**/test/utils/offline-render-*.test.ts',
  '**/test/plugins/works-site-isolation.test.ts',
  '**/test/plugins/works-site-layout.test.ts',
  '**/test/plugins/publish-preview-isolation.test.ts',
  '**/test/smoke/**',
  '**/test/e2e-webui/**',
];

/** 中止真实子进程、断言几秒内落定的测试：结果取决于机器当时的负载 */
const PROCESS_TIMING_TESTS = [
  '**/test/plugins/process-local-abort.test.ts',
  '**/test/plugins/process-local-lifetime.test.ts',
  '**/test/plugins/process-local-maxbuffer.test.ts',
  '**/test/plugins/tool-system-exec-abort.test.ts',
  '**/test/plugins/code-runner-abort.test.ts',
  '**/test/plugins/code-sandbox-os-probe-abort.test.ts',
];

/** 推送前不跑的全部重测试：浏览器测试、中止真实子进程的测试，加上起真实子进程与联网的集成测试 */
export const HEAVY_TESTS = [...BROWSER_TESTS, ...PROCESS_TIMING_TESTS, '**/test/integration/**'];
