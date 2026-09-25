import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import { openBrowser } from '../../packages/plugin-webui-server/src/auth.js';

// ════════════════════════════════════════════════════════════
// 自动打开浏览器的命令不存在（headless Linux、Docker 没有 xdg-open 是常态）时，spawn 失败
// 是子进程句柄上异步 emit 的 'error'，外层 try/catch 接不住。句柄上没有 error 监听就成了
// uncaughtException，runtime 收到即 process.exit(1)。openBrowser 靠「挂上 wait() 并吞掉拒绝」
// 给句柄挂监听；这一行看上去多余，删掉就会打死整个进程。
//
// 用真实的 LocalProcessService，把命令改写成一个不存在的名字，绕开按平台选命令的分支。
// vitest 在进程内接住 uncaughtException 不会让用例失败，所以显式挂监听、断言有没有收到。
// ════════════════════════════════════════════════════════════

const MISSING = 'zz-aalis-no-such-cmd';
const real = new LocalProcessService({} as unknown as StorageService);
const seen: Error[] = [];
const onUncaught = (err: Error) => seen.push(err);

afterEach(() => {
  process.off('uncaughtException', onUncaught);
  seen.length = 0;
});

const settle = () => new Promise(r => setTimeout(r, 150));

describe('openBrowser：打开浏览器的命令不存在', () => {
  it('spawn 失败不变成 uncaughtException', async () => {
    const proc = { spawn: (_cmd, args, opts) => real.spawn(MISSING, args, opts) } as Pick<ProcessService, 'spawn'>;
    process.on('uncaughtException', onUncaught);
    openBrowser('http://127.0.0.1:1/', proc as ProcessService);
    await settle();
    expect(seen).toEqual([]);
  });

  it('反证：同样的 spawn 不挂 wait()，错误就成了 uncaughtException', async () => {
    process.on('uncaughtException', onUncaught);
    real.spawn(MISSING, [], { detached: true, stdio: 'ignore' }).unref();
    await settle();
    expect(seen.map(e => (e as NodeJS.ErrnoException).code)).toEqual(['ENOENT']);
  });
});
