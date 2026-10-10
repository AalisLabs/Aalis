import { hostLogs } from '../../packages/api-host-logs/src/index.js';
import { type App, LogHub, provide } from '../../packages/core/src/index.js';
import { createHostLogs } from '../../packages/runtime/src/host-logs.js';

/**
 * 像 runtime 一样在根上提供 host-logs：实时接 `hub`（缺省是进程级的默认中枢，runtime 接的也是它），历史读 `file`
 * （测试事先写好，读之前没有要等的写入；不给时没有历史）。要在登记读日志的插件之前调用
 */
export function provideHostLogs(app: App, { hub = LogHub.default, file }: { hub?: LogHub; file?: string } = {}): void {
  const written = file === undefined ? undefined : { path: file, flush: async () => {} };
  app.bind({ provide }).provide.use(hostLogs, createHostLogs(hub, written, app.logger), { exclusive: true });
}
