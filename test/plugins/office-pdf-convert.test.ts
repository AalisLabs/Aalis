import { describe, expect, it, vi } from 'vitest';
import type { ExecResult, ProcessService, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerPdfTools } from '../../packages/plugin-office/src/tools/pdf.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// pdf_convert（文档转 PDF）声明可转后台：LibreOffice 的转换只认执行器给这次调用的中止信号，不另设超时；
// 中止时停住、回「已中止」；失败一律以 error 报出，后台任务据此记为失败。进程服务是替身，不起 LibreOffice。
// ════════════════════════════════════════════════════════════

const storage = {
  resolveLocalPath: async (uri: string) => `/zz-host/${uri.replace(':/', '/')}`,
} as unknown as StorageService;

/** 替身进程服务：记下 execFile 的选项；hang 时一直不结束，中止后按中止契约以终止信号拒绝 */
function fakeProcess(mode: 'ok' | 'hang' | 'fail') {
  const calls: Array<{ cmd: string; args: readonly string[]; opts?: SpawnOptions }> = [];
  const proc = {
    execFile: (cmd: string, args: readonly string[], opts?: SpawnOptions) => {
      calls.push({ cmd, args, opts });
      if (mode === 'ok') return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' } as ExecResult);
      if (mode === 'fail') return Promise.reject(new Error('soffice: command not found'));
      return new Promise<ExecResult>((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const result: ExecResult = { code: null, signal: 'SIGTERM', stdout: '', stderr: '' };
          reject(Object.assign(new Error('execFile 退出码 null (signal SIGTERM)'), { result }));
        });
      });
    },
  } as unknown as ProcessService;
  return { proc, calls };
}

function register(proc?: ProcessService) {
  let convert: Omit<RegisteredTool, 'pluginName'> | undefined;
  registerPdfTools(
    stubBoundTools({
      onRegister: t => {
        if (t.definition.function.name === 'pdf_convert') convert = t;
      },
    }),
    {} as never,
    storage,
    'workspace:/office',
    proc,
  );
  if (!convert) throw new Error('pdf_convert 没有登记');
  return convert;
}

const parse = (out: Awaited<ReturnType<RegisteredTool['handler']>>) =>
  JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;

describe('pdf_convert 可转后台', () => {
  it('声明可转后台（让出时限用执行器的默认）；交给 execFile 的是调用的中止信号，不带超时', async () => {
    const { proc, calls } = fakeProcess('ok');
    const convert = register(proc);
    expect(convert.background).toEqual({});
    const ac = new AbortController();
    const out = parse(await convert.handler({ inputPath: 'workspace:/a.docx' }, { sessionId: 's', signal: ac.signal }));
    expect(out).toMatchObject({ success: true, path: 'workspace:/a.pdf' });
    expect(calls.map(c => c.opts)).toEqual([{ signal: ac.signal }]);
  });

  it('转换中中止：停住，回「PDF 转换已中止」', async () => {
    const { proc, calls } = fakeProcess('hang');
    const ac = new AbortController();
    const pending = register(proc).handler({ inputPath: 'workspace:/a.docx' }, { sessionId: 's', signal: ac.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    ac.abort();
    await expect(pending).rejects.toThrow('PDF 转换已中止');
  });

  it('失败以错误报出：转换失败、没有进程服务', async () => {
    await expect(
      register(fakeProcess('fail').proc).handler({ inputPath: 'workspace:/a.docx' }, { sessionId: 's' }),
    ).rejects.toThrow('PDF 转换失败');
    await expect(register().handler({ inputPath: 'workspace:/a.docx' }, { sessionId: 's' })).rejects.toThrow(
      'process 服务',
    );
  });
});
