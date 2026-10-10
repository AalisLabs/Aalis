import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostLogs } from '../../packages/api-host-logs/src/index.js';
import { App, DefaultLogger, definePlugin, type LogEntry, LogHub, provide } from '../../packages/core/src/index.js';
import { createHostLogs } from '../../packages/runtime/src/host-logs.js';
import { formatLogLine } from '../../packages/schema-log/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 读日志的宿主服务：订阅先补发最近几条（历史在文件日志里），再接实时，按 seq 递增、不重不漏；订阅归本次激活，
// 关闭后不再收到。文件日志是异步落盘的：读历史之前先等它写完，读的时候又可能已经写进了订阅之后才来的几条
// ════════════════════════════════════════════════════════════

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 中枢、照它写的文件日志与读它的宿主服务。文件日志攒着没写的，flush 时写下：flush 取的是调用那一刻攒下的
 * （`snapshot`），或是放行那一刻攒下的；放行由 `release` 控制
 */
function world(snapshot: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-host-logs-'));
  dirs.push(dir);
  const path = join(dir, 'latest.log');
  const hub = new LogHub();
  const unwritten: LogEntry[] = [];
  hub.onEntry(entry => void unwritten.push(entry));
  const gate = deferred();
  const write = (batch: LogEntry[]) => appendFileSync(path, batch.map(formatLogLine).join(''));
  const flush = async () => {
    const taken = snapshot ? unwritten.splice(0) : undefined;
    await gate.promise;
    write(taken ?? unwritten.splice(0));
  };
  const log = new DefaultLogger('aalis:zz-probe', 'debug', hub);
  const app = new App({ name: 'T', logLevel: 'error', logHub: hub });
  apps.push(app);
  app.bind({ provide }).provide.use(hostLogs, createHostLogs(hub, { path, flush }, app.logger), { exclusive: true });
  return { app, log, release: gate.resolve };
}

/** 订阅者：激活时订阅，补发最近 3 条，紧接着记一条 */
function reader(log: DefaultLogger, seen: number[]) {
  return definePlugin({
    name: 'zz-log-reader',
    uses: { logs: hostLogs },
    apply({ logs }) {
      logs.use.subscribe(entry => void seen.push(entry.seq), { history: 3 });
      log.info('订阅之后');
    },
  });
}

describe('host-logs：先补发最近的，再接实时', () => {
  it.each([
    ['读历史时已写进文件的、订阅之后来的不重发', false, [4, 5, 6, 7]],
    ['只写到订阅那一刻的、之后来的照样送到', true, [2, 3, 4, 5, 6, 7]],
  ])('%s；关闭后不再收到', async (_label, snapshot, expected) => {
    const { app, log, release } = world(snapshot);
    for (let i = 0; i < 5; i++) log.info(`启动期 ${i}`);
    const seen: number[] = [];
    await app.plugin(reader(log, seen));
    await app.plugins.idle();
    log.info('历史还没读到');
    release();
    await vi.waitFor(() => expect(seen.at(-1)).toBe(6));
    log.info('实时');
    expect(seen).toEqual(expected);

    await app.plugins.unload('zz-log-reader');
    log.info('关闭之后');
    expect(seen).toEqual(expected);
  });
});
