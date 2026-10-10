import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 的日志根 logs 是内置根，指向 host-paths 的 logs（runtime 写 latest.log 的地方），
// WebUI 与 CLI 的日志页经 logs:/latest.log 读它。老配置里持久化过 { name: logs, path: data }：
// 它若照旧生效，日志页会一直读升级前那份不再更新的 data/latest.log。现在这一项被跳过并告警。
// ════════════════════════════════════════════════════════════

function recordingLogger(sink: string[]): Logger {
  const logger = {
    debug() {},
    info() {},
    warn: (message: string) => void sink.push(message),
    error() {},
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

describe('storage-local 日志根 logs', () => {
  let home: string;
  let app: App;
  let warns: string[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aalis-logs-root-'));
    warns = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(warns) });
    provideHostPaths(app, home);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('老配置里的 logs 项被跳过，logs:/ 读的是家目录 logs/ 下 runtime 正在写的那份', async () => {
    mkdirSync(join(home, 'data'));
    writeFileSync(join(home, 'data', 'latest.log'), 'stale\n');
    mkdirSync(join(home, 'logs'));
    writeFileSync(join(home, 'logs', 'latest.log'), 'current\n');
    await app.plugin(storageLocal, {
      roots: [
        { name: 'data', path: 'data', kind: 'data', readable: true, writable: true },
        { name: 'logs', path: 'data', kind: 'logs', readable: true, writable: false },
      ],
    });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocal.name)?.state).toBe('active');
    const storage = app.bind({ storage: storageService }).storage.use;
    expect(new TextDecoder().decode((await storage.readFile('logs:/latest.log')) as Uint8Array)).toBe('current\n');
    expect(warns.some(w => w.includes('roots 跳过 logs'))).toBe(true);
    const info = storage.listRoots().find(r => r.name === 'logs');
    expect(info?.writable).toBe(false);
  });
});
