import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool, ToolCallContext, ToolOutputMessage } from '../../packages/api-tools/src/index.js';
import type { Events, LifecycleCap } from '../../packages/core/src/index.js';
import { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';
import { registerShellTools } from '../../packages/plugin-tool-system/src/tools/shell.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// exec 的输出边跑边推：agent 回合里的调用（带 turnId 与 callId）把 stdout 与 stderr 按到达顺序经 tool:output
// 推给界面；推送总量不超过结果里保留的输出上限；不在回合里的调用不推。工具结果照旧在命令结束后一次给出。
// 起真实进程，只在 POSIX 跑。
// ════════════════════════════════════════════════════════════

const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-exec-output-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function register(maxOutputSize = 65536) {
  const outputs: ToolOutputMessage[] = [];
  let exec: RegisteredTool['handler'] | undefined;
  registerShellTools(
    stubBoundTools({
      onRegister: t => {
        if (t.definition.function.name === 'exec') exec = t.handler;
      },
    }),
    {
      logger: silentLogger(),
      lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} } as unknown as LifecycleCap,
      events: {
        on: () => () => {},
        emit: async (name: string, chunk: ToolOutputMessage) => {
          if (name === 'tool:output') outputs.push(chunk);
        },
      } as unknown as Events,
      isOwner: () => false,
      cwdUri: 'workspace:/',
      proc: new LocalProcessService({} as unknown as StorageService),
      storage: { resolveLocalPath: async () => dir } as unknown as StorageService,
      defaultTimeout: 30000,
      maxTimeout: 300000,
      maxOutputSize,
    },
  );
  if (!exec) throw new Error('exec 没有登记');
  const run = async (command: string, ctx: Partial<ToolCallContext> = {}) => {
    const out = await exec?.({ command }, { sessionId: 's-exec', ...ctx });
    return JSON.parse(typeof out === 'string' ? out : String(out?.content)) as Record<string, unknown>;
  };
  return { run, outputs };
}

const inTurn = { turnId: 'turn-1', callId: 'call-1' };

describe('exec 的流式输出', () => {
  it.skipIf(!posix)('回合里的调用：stdout 与 stderr 按到达顺序推出，带这次调用的 id；结果照旧', async () => {
    const { run, outputs } = register();
    const result = await run("printf 'out-1 '; sleep 0.2; printf 'err-1 ' >&2; sleep 0.2; printf 'out-2'", inTurn);
    expect(result).toEqual({ exitCode: 0, stdout: 'out-1 out-2', stderr: 'err-1 ' });
    expect(outputs.every(o => o.sessionId === 's-exec' && o.turnId === 'turn-1' && o.callId === 'call-1')).toBe(true);
    expect(outputs.map(o => o.text).join('')).toBe('out-1 err-1 out-2');
    expect(outputs.length, '分几次推出，不是结束时一次给').toBeGreaterThan(1);
  });

  it.skipIf(!posix)('多字节字符被拆在两次读取之间也不出乱码', async () => {
    const { run, outputs } = register();
    // 「好」的 UTF-8 是 e5 a5 bd，前两个字节先写，停一下再写最后一个
    await run("printf '\\345\\245'; sleep 0.2; printf '\\275'", inTurn);
    expect(outputs.map(o => o.text).join('')).toBe('好');
  });

  it.skipIf(!posix)('推出的总量不超过输出上限', async () => {
    const { run, outputs } = register(10);
    await run("printf '0123456789abcdefghij'", inTurn);
    expect(outputs.map(o => o.text).join('')).toBe('0123456789');
  });

  it.skipIf(!posix)('不在回合里的调用（编排节点、mcp 等）不推', async () => {
    const { run, outputs } = register();
    const result = await run('echo hi');
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hi\n' });
    expect(outputs).toEqual([]);
  });
});
