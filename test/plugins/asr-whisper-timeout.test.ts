import { afterEach, describe, expect, it } from 'vitest';
import { asr } from '../../packages/api-asr/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import whisper from '../../packages/plugin-asr-whisper-cpp/src/index.js';

// ════════════════════════════════════════════════════════════
// 两处 execFile 必须带 timeout：LocalProcessService.spawn 只在 opts.timeout>0 时才武装
// killTree，否则子进程不退就永不 settle——一条构造的音频挂住整轮 agent（abort 也停不掉
// 子进程），whisper/ffmpeg 还会逐条堆积。
// ════════════════════════════════════════════════════════════

interface Call {
  cmd: string;
  timeout: unknown;
}

function makeApp(calls: Call[]) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // 宿主侧按根激活取绑定接口：桩服务与真实插件经同一条发布门面进容器
  const host = app.bind({ provide, asr });
  host.provide(processService, {
    execFile: async (cmd: string, _args: readonly string[], opts?: { timeout?: number }) => {
      calls.push({ cmd, timeout: opts?.timeout });
      return { stdout: '识别结果', stderr: '', code: 0 };
    },
    makeTempDir: async () => ({ path: '/tmp/whisper-test', uri: 'tmp:/whisper-test', cleanup: async () => {} }),
    spawn: () => {
      throw new Error('未使用');
    },
    readExternalFile: async () => new Uint8Array(),
  } as never);
  host.provide(storage, {
    listRoots: () => [{ name: 'tmp', readable: true, writable: true, deletable: true }],
    writeFile: async () => {},
    readFile: async () => {
      throw new Error('无 txt 产物，回退 stdout');
    },
  } as never);
  return { app, host };
}

describe('plugin-asr-whisper-cpp: 子进程必须带超时', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) {
      try {
        await a.stop();
      } catch {
        /* 停不掉也继续 */
      }
    }
  });

  it('ffmpeg 与 whisper-cli 两处 execFile 都带正数 timeout', async () => {
    const calls: Call[] = [];
    const { app, host } = makeApp(calls);
    apps.push(app);
    await app.plugin(whisper, { modelPath: '/models/ggml.bin', timeoutMs: 30_000 });
    await app.plugins.idle();
    // 插件停在 pending（required 的 process / storage 没提供者）时 asr 也不会注册，
    // 下面的断言会退化成「没人调 execFile」而恒真，故先核激活状态
    expect(app.plugins.getPlugin(whisper.name)?.state, 'whisper 插件未激活').toBe('active');

    const service = host.asr.current;
    expect(service, 'asr 服务应已注册').toBeDefined();

    await service!.transcribe({ attachment: { kind: 'audio', data: 'data:audio/wav;base64,AAAA' } });

    expect(calls.length, '应各调一次 ffmpeg 与 whisper-cli').toBe(2);
    for (const c of calls) {
      expect(typeof c.timeout, `${c.cmd} 没拿到 timeout —— 子进程不退就永不 settle`).toBe('number');
      expect(c.timeout as number, `${c.cmd} 的 timeout 必须为正，否则 spawn 不武装 killTree`).toBeGreaterThan(0);
    }
  });
});
