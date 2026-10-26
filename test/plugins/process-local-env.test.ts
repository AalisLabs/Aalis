import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoundStorage, StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import codeRunner from '../../packages/plugin-tool-code-runner/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 进程服务的 env 是替换语义：给了就只用给的，不叠加在守护进程的环境上（code-runner 的白名单靠它生效）；
// 不给时子进程继承守护进程的环境。code-runner 设成 sandbox.mode=none 时脚本经进程服务跑，同样只拿到白名单里的变量。
// ════════════════════════════════════════════════════════════

// execFile 不用 storage（仅 makeTempDir 用）；测试传空桩。
const proc = new LocalProcessService({} as unknown as StorageService);
const PRINT = ['-e', 'process.stdout.write(String(process.env.ZZ_DAEMON_ONLY))'];

const roots: string[] = [];
afterEach(() => {
  delete process.env.ZZ_DAEMON_ONLY;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LocalProcessService 的 env', () => {
  it('给了 env：子进程只拿到给的，守护进程独有的变量不在', async () => {
    process.env.ZZ_DAEMON_ONLY = '1';
    const { stdout } = await proc.execFile(process.execPath, PRINT, { env: { PATH: process.env.PATH } });
    expect(stdout).toBe('undefined');
  });

  it('没给 env：子进程继承守护进程的环境', async () => {
    process.env.ZZ_DAEMON_ONLY = '1';
    const { stdout } = await proc.execFile(process.execPath, PRINT);
    expect(stdout).toBe('1');
  });
});

/** workspace:/、tmp:/ 两个根映射到临时目录的本地 storage 替身，只实现 code-runner 与 makeTempDir 用到的方法 */
function localStorage(root: string): StorageService {
  const toLocal = (uri: string): string => {
    const m = /^(workspace|tmp):\/(.*)$/.exec(uri);
    if (!m) throw new Error(`替身不认识的 URI: ${uri}`);
    return join(root, m[1], m[2]);
  };
  const rootInfo = (name: string) => ({
    name,
    kind: name,
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  });
  return {
    listRoots: () => [rootInfo('workspace'), rootInfo('tmp')],
    resolveLocalPath: async (uri: string) => toLocal(uri),
    writeFile: async (uri: string, data: string | Buffer) => {
      const file = toLocal(uri);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    },
    delete: async (uri: string) => {
      rmSync(toLocal(uri), { recursive: true, force: true });
    },
  } as unknown as StorageService;
}

describe('code-runner 的 sandbox.mode=none', () => {
  it('脚本只拿到白名单里的环境变量：守护进程独有的变量不在，PATH 还在', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'zz-code-env-')));
    roots.push(root);
    mkdirSync(join(root, 'workspace'));
    const storage = localStorage(root);
    const handlers: Record<string, RegisteredTool['handler']> = {};
    await codeRunner.apply({
      tools: fixedRef(
        stubBoundTools({
          onRegister: t => {
            handlers[t.definition.function.name] = t.handler;
          },
        }),
      ),
      storage: ref([{ instance: storage as BoundStorage, contextId: 'zz-code-env', priority: 0 }]),
      proc: ref([{ instance: new LocalProcessService(storage), contextId: 'zz-code-env', priority: 0 }]),
      codeSandbox: ref([]),
      logger: fixedRef(silentLogger()),
      config: fixedRef({
        javascript: { enabled: true, interpreter: process.execPath },
        workingDirectory: 'workspace:/',
        sandbox: { mode: 'none' },
      }),
    });
    process.env.ZZ_DAEMON_ONLY = '1';
    const out = await handlers.run_javascript(
      { code: 'console.log(JSON.stringify([process.env.ZZ_DAEMON_ONLY ?? null, typeof process.env.PATH]))' },
      toolContext({ sessionId: 'zz-code-env' }),
    );
    const { stdout } = JSON.parse(String(out)) as { stdout: string };
    expect(JSON.parse(stdout)).toEqual([null, 'string']);
  });
});
