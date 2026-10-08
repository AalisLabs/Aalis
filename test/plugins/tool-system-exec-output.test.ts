import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import { registerShellTools } from '../../packages/plugin-tool-system/src/tools/shell.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// exec 的输出边跑边写：stdout 与 stderr 按到达顺序写进执行器给这次调用的输出口（ToolCallContext.output），
// 推给界面、留进后台任务的输出缓冲都由执行器做。工具结果照旧在命令结束后一次给出。起真实进程，只在 POSIX 跑。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-exec-output-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function register() {
  let exec: RegisteredTool['handler'] | undefined;
  registerShellTools(
    stubBoundTools({
      onRegister: t => {
        if (t.definition.function.name === 'exec') exec = t.handler;
      },
    }),
    {
      logger: silentLogger(),
      cwdUri: 'workspace:/',
      proc: new LocalProcessService({} as unknown as StorageService),
      storage: { resolveLocalPath: async () => dir } as unknown as StorageService,
      maxOutputSize: 65536,
    },
  );
  if (!exec) throw new Error('exec 没有登记');
  const written: string[] = [];
  const run = async (command: string) => {
    const out = await exec?.({ command }, { sessionId: 's-exec', output: text => void written.push(text) });
    return JSON.parse(typeof out === 'string' ? out : String(out?.content)) as Record<string, unknown>;
  };
  return { run, written };
}

describe('exec 的输出口', () => {
  it.skipIf(!posix)('stdout 与 stderr 按到达顺序写进输出口，分几次写，不是结束时一次给；结果照旧', async () => {
    const { run, written } = register();
    const result = await run("printf 'out-1 '; sleep 0.2; printf 'err-1 ' >&2; sleep 0.2; printf 'out-2'");
    expect(result).toEqual({ exitCode: 0, stdout: 'out-1 out-2', stderr: 'err-1 ' });
    expect(written.join('')).toBe('out-1 err-1 out-2');
    expect(written.length).toBeGreaterThan(1);
  });

  it.skipIf(!posix)('多字节字符被拆在两次读取之间也不出乱码', async () => {
    const { run, written } = register();
    // 「好」的 UTF-8 是 e5 a5 bd，前两个字节先写，停一下再写最后一个
    await run("printf '\\345\\245'; sleep 0.2; printf '\\275'");
    expect(written.join('')).toBe('好');
  });
});
