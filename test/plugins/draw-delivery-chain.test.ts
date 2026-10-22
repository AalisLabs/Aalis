import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';
import { materializeAttachments } from '../../packages/plugin-adapter-onebot/src/attachments.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import imageSender from '../../packages/plugin-image-sender/src/index.js';
import processLocal from '../../packages/plugin-process-local/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// 画→出站请求→编码 链路测试（真 App/storage/process/Chromium/ffmpeg）：
//   draw_animation 出 GIF storage_uri
//   → send_attachment(storage_uri) 解析并 emit outbound:message（平台确认由 fixture 模拟）
//   → adapter 出站两步（cacheOneAttachment 落盘改写 + 物化成 base64:// 内联的消息段）
//   → 消息段里的 base64 解出来是合法 GIF89a。
// 这是进入 OneBot WebSocket 之前的本地编码链路，不验证实际平台送达。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger } as never;

type ToolHandler = (args: Record<string, unknown>, callCtx: { sessionId: string }) => Promise<string>;

const SPIN_SVG =
  '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" rx="10" fill="#0f172a"/>' +
  '<g transform="translate(60,60)"><circle r="8" fill="#38bdf8">' +
  '<animateMotion dur="1s" repeatCount="indefinite" path="M 30 0 A 30 30 0 1 1 29.99 0"/></circle></g></svg>';

describe('绘图产物 → OneBot WebSocket 前的出站编码链路', () => {
  let base: string;
  let app: App;
  let files: StorageService;
  let handlers: Record<string, ToolHandler>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-draw-chain-'));
    for (const d of ['state', 'tmp']) mkdirSync(join(base, d), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    provideHostPaths(app, base);
    await app.plugin(storageLocal, {});
    await app.plugin(processLocal);
    files = app.bind({ storage }).storage.use;

    // 宿主侧最小 tools 提供者：把两个插件登记的 handler 交到测试手上
    handlers = {};
    app.bind({ provide }).provide.use(tools, {
      register(tool: { definition: { function: { name: string } }; handler: ToolHandler }) {
        const name = tool.definition.function.name;
        handlers[name] = tool.handler;
        return () => void delete handlers[name];
      },
      registerGroup: () => () => {},
    } as never);
    await app.plugin(drawPlugin, { idleShutdownSec: 0 });
    await app.plugin(imageSender);
    await app.plugins.idle();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('draw_animation → send_attachment → 出站附件编码为 base64:// 内联 GIF', async () => {
    const session = 'onebot:t:group:7';

    // 1. 画
    const drawn = JSON.parse(
      await handlers.draw_animation({ source: SPIN_SVG, fps: 8, duration_seconds: 1 }, { sessionId: session }),
    );
    expect(drawn.error).toBeUndefined();
    expect(drawn.uri).toMatch(/^data:\/images\/onebot_t_group_7\/draw\//);

    // 2. 捕获出站请求；模拟适配器确认，让本测试继续验证后续本地编码。
    const outbound: Array<{ sessionId: string; attachments?: Array<{ kind: string; data: string }> }> = [];
    app.bind({ events }).events.use.on('outbound:message', msg => {
      outbound.push(msg as (typeof outbound)[number]);
      msg.delivery = Promise.resolve({ ok: true });
    });
    const sent = JSON.parse(
      await handlers.send_attachment({ kind: 'image', storage_uri: drawn.uri }, { sessionId: session }),
    );
    expect(sent.ok).toBe(true);
    expect(outbound).toHaveLength(1);
    const att = outbound[0].attachments?.[0];
    expect(att?.kind).toBe('image');

    // 3. adapter 出站两步：落盘改写 → 物化成内联的消息段（与 index.ts 出站监听同一套调用）
    const proc = app.bind({ processService }).processService.use;
    const local = await cacheOneAttachment(files, proc, 'image', att?.data ?? '', session, 10 * 1024 * 1024, {
      warn: () => {},
    });
    expect(local).toMatch(/^data:\/images\/onebot_t_group_7\/onebot\//);
    const { segments } = await materializeAttachments([{ kind: 'image', data: local ?? '' }], files, logger);
    expect(segments.map(s => s.type)).toEqual(['image']);
    const file = String(segments[0]?.data.url);
    expect(file.startsWith('base64://'), `出站消息段形态不符: ${file.slice(0, 120)}`).toBe(true);

    // 4. 内联字节 = 合法 GIF
    const bytes = Buffer.from(file.slice('base64://'.length), 'base64');
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(bytes.byteLength).toBeGreaterThan(2000);
  }, 60_000);
});
