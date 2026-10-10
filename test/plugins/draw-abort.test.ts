import { describe, expect, it, vi } from 'vitest';
import type { ExecResult, ProcessService, SpawnOptions } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { LifecycleCap } from '../../packages/core/src/index.js';
import { framesToGif } from '../../packages/plugin-draw/src/gif.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import type { RenderRequest } from '../../packages/util-offline-render/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// draw_image、draw_animation 声明可转后台，只认执行器给这次调用的中止信号：渲染请求带上它，动图的两遍 ffmpeg 编码
// 同样带上它、不另设超时（渲染每一步的卡住检测另算，不在这里）。离线渲染是替身：一直不出图，中止后以中止原因拒绝。
// ════════════════════════════════════════════════════════════

const renders = vi.hoisted(() => ({ requests: [] as RenderRequest[] }));
vi.mock(import('../../packages/util-offline-render/src/index.js'), async importOriginal => {
  const hang = (req: RenderRequest) => {
    renders.requests.push(req);
    return new Promise<never>((_, reject) => {
      req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
    });
  };
  return {
    ...(await importOriginal()),
    OfflineRenderer: class {
      renderPng = hang;
      renderFrames = hang;
      dispose = async () => {};
    } as never,
  };
});

async function apply() {
  const registered: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  await drawPlugin.apply({
    tools: fixedRef(
      stubBoundTools({
        onRegister: t => {
          registered[t.definition.function.name] = t;
        },
      }),
    ),
    storage: ref(),
    processService: ref(),
    logger: fixedRef(silentLogger()),
    lifecycle: fixedRef({ signal: new AbortController().signal, onDispose: () => () => {} } as unknown as LifecycleCap),
    config: fixedRef({}),
  });
  return registered;
}

const SVG = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

describe('绘图可转后台', () => {
  it('draw_image、draw_animation 声明可转后台（让出时限用执行器的默认）', async () => {
    const registered = await apply();
    expect(registered.draw_image.background).toEqual({});
    expect(registered.draw_animation.background).toEqual({});
  });

  it.each(['draw_image', 'draw_animation'])('%s：渲染请求带上调用的中止信号，中止时停住、回错', async name => {
    renders.requests.length = 0;
    const tool = (await apply())[name];
    const ac = new AbortController();
    const pending = tool.handler({ source: SVG }, { sessionId: 's', signal: ac.signal });
    await vi.waitFor(() => expect(renders.requests).toHaveLength(1));
    expect(renders.requests[0].signal).toBe(ac.signal);
    ac.abort();
    const out = await pending;
    expect(JSON.parse(typeof out === 'string' ? out : out.content).error).toBeDefined();
  });

  it('动图的两遍 ffmpeg 编码带上中止信号，不带超时', async () => {
    const execOpts: Array<SpawnOptions | undefined> = [];
    const proc = {
      makeTempDir: async () => ({ uri: 'tmp:/zz', path: '/zz-tmp', cleanup: async () => {} }),
      execFile: async (_cmd: string, _args: readonly string[], opts?: SpawnOptions) => {
        execOpts.push(opts);
        return { code: 0, signal: null, stdout: '', stderr: '' } as ExecResult;
      },
    } as unknown as ProcessService;
    const storage = {
      writeFile: async () => {},
      readFile: async () => new Uint8Array([0x47, 0x49, 0x46]),
    } as unknown as StorageService;
    const ac = new AbortController();
    await framesToGif(proc, storage, [Buffer.from('zz-frame')], 10, ac.signal);
    expect(execOpts).toEqual([{ signal: ac.signal }, { signal: ac.signal }]);
  });
});
