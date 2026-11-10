import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import type { LifecycleCap } from '../../packages/core/src/index.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 绘图是否带 Chromium 沙箱由配置 sandbox 决定：
// - 不配（默认 false）：带 --no-sandbox --disable-setuid-sandbox 启动。
// - 配 true：不带这两项启动；启动失败就回工具错误，写明可以在配置里关掉沙箱，不加 --no-sandbox 再启动，
//   下次调用照样带沙箱启动（不记住失败）。
// puppeteer 换成替身（按 util-chromium 的依赖路径 mock）：每次启动都失败，只记下参数，不启动真浏览器。
// ════════════════════════════════════════════════════════════

const probe = vi.hoisted(() => ({ launches: [] as string[][], loadFails: false }));
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => {
  const launch = async (options: { args: string[] }) => {
    probe.launches.push(options.args);
    throw new Error('No usable sandbox!（模拟）');
  };
  return {
    // loadFails 时取默认导出就抛：模拟 puppeteer 本身加载失败，Chromium 还未启动过
    get default() {
      if (probe.loadFails) throw new Error('zz-puppeteer 装坏了');
      return { launch };
    },
    launch,
  };
});

afterEach(() => {
  probe.launches.length = 0;
  probe.loadFails = false;
});

const SVG = '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

async function drawImage(config: Record<string, unknown>): Promise<() => Promise<{ error?: string }>> {
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
    hooks: fixedRef({ middleware: () => () => {} } as never),
    contributions: fixedRef({ contribute: () => () => {} } as never),
    logger: fixedRef(silentLogger()),
    lifecycle: fixedRef({ signal: new AbortController().signal, onDispose: () => () => {} } as unknown as LifecycleCap),
    config: fixedRef(config),
  });
  return async () => {
    const out = await registered.draw_image.handler({ source: SVG }, toolContext({ sessionId: 's' }));
    return JSON.parse(typeof out === 'string' ? out : out.content);
  };
}

/** 每次启动的参数里有没有 --no-sandbox 与 --disable-setuid-sandbox */
const noSandboxFlags = () =>
  probe.launches.map(args => [args.includes('--no-sandbox'), args.includes('--disable-setuid-sandbox')]);

describe('绘图的 Chromium 沙箱', () => {
  it('不配：带 --no-sandbox --disable-setuid-sandbox 启动；启动失败时报错不提沙箱', async () => {
    const call = await drawImage({});
    const failed = await call();
    expect(failed.error).toContain('Chromium 启动失败（No usable sandbox!（模拟））');
    expect(failed.error).not.toContain('沙箱');
    expect(noSandboxFlags()).toEqual([[true, true]]);
  });

  it('配 true 启动失败：不带这两项启动，回错写明可在配置里关掉沙箱，不回落；下次调用照样带沙箱启动', async () => {
    const call = await drawImage({ sandbox: true });
    const failed = await call();
    expect(failed.error).toContain('Chromium 带沙箱启动失败（No usable sandbox!（模拟））');
    expect(failed.error).toContain('可在绘图的配置里关掉「Chromium 沙箱」（sandbox）');
    expect(noSandboxFlags()).toEqual([[false, false]]);

    await call();
    expect(noSandboxFlags()).toEqual([
      [false, false],
      [false, false],
    ]);
  });

  it('配 true、puppeteer 本身加载失败：报加载失败，不说成启动失败，不提沙箱', async () => {
    probe.loadFails = true;
    const call = await drawImage({ sandbox: true });
    const failed = await call();
    expect(failed.error).toContain('加载 puppeteer 失败');
    expect(failed.error).not.toContain('沙箱');
    expect(probe.launches).toEqual([]);
  });
});
