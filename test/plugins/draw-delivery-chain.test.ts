import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProcessGateway, processService } from '../../packages/api-process/src/index.js';
import { createStorageGateway, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';
import { renderAttachmentsAsContentMarkers } from '../../packages/plugin-adapter-onebot/src/attachments.js';
import drawPlugin from '../../packages/plugin-draw/src/index.js';
import imageSender from '../../packages/plugin-image-sender/src/index.js';
import processLocal from '../../packages/plugin-process-local/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// 画→发→编码 全链交接测试（真 App/storage/process/Chromium/ffmpeg）：
//   draw_animation 出 GIF storage_uri
//   → send_attachment(storage_uri) 解析并 emit outbound:message
//   → adapter 出站两步（cacheOneAttachment 落盘改写 + 渲染 base64:// 内联标记）
//   → 标记里的 base64 解出来是合法 GIF89a。
// 这是投递到 OneBot 之前的最后一段本地链路；WS 之外的每一步都在这里被真实走过。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger } as never;

type ToolHandler = (args: Record<string, unknown>, callCtx: { sessionId: string }) => Promise<string>;

const SPIN_SVG =
  '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="120" rx="10" fill="#0f172a"/>' +
  '<g transform="translate(60,60)"><circle r="8" fill="#38bdf8">' +
  '<animateMotion dur="1s" repeatCount="indefinite" path="M 30 0 A 30 30 0 1 1 29.99 0"/></circle></g></svg>';

describe('绘图产物 → OneBot 出站编码全链', () => {
  let base: string;
  let app: App;
  let storageGateway: StorageService;
  let handlers: Record<string, ToolHandler>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-draw-chain-'));
    for (const d of ['data', 'tmp']) mkdirSync(join(base, d), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    await app.plugin(storageLocal, {
      roots: [
        {
          name: 'data',
          path: join(base, 'data'),
          label: 'data',
          kind: 'data',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
        {
          name: 'tmp',
          path: join(base, 'tmp'),
          label: 'tmp',
          kind: 'tmp',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugin(processLocal);
    storageGateway = createStorageGateway(app.bind({ storage }).storage);

    // 宿主侧最小 tools 提供者：把两个插件登记的 handler 交到测试手上
    handlers = {};
    app.bind({ provide }).provide(tools, {
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
    expect(drawn.uri).toMatch(/^data:\/images\//);

    // 2. 发（捕获 outbound:message）
    const outbound: Array<{ sessionId: string; attachments?: Array<{ kind: string; data: string }> }> = [];
    app.bind({ events }).events.on('outbound:message', msg => {
      outbound.push(msg as (typeof outbound)[number]);
    });
    const sent = JSON.parse(
      await handlers.send_attachment({ kind: 'image', storage_uri: drawn.uri }, { sessionId: session }),
    );
    expect(sent.ok).toBe(true);
    expect(outbound).toHaveLength(1);
    const att = outbound[0].attachments?.[0];
    expect(att?.kind).toBe('image');

    // 3. adapter 出站两步：落盘改写 → 渲染内联标记（与 index.ts 出站监听同一套调用）
    const proc = createProcessGateway(app.bind({ processService }).processService);
    const local = await cacheOneAttachment(storageGateway, proc, 'image', att?.data ?? '', session, 10 * 1024 * 1024, {
      warn: () => {},
    });
    expect(local).toMatch(/^data\/images\//);
    const storageUri = (local ?? '').replace(/^([^/]+)\//, '$1:/');
    const markers = await renderAttachmentsAsContentMarkers(
      [{ kind: 'image', data: storageUri }],
      storageGateway,
      logger,
    );
    const m = markers.match(/<image url="base64:\/\/([A-Za-z0-9+/=]+)"/);
    expect(m, `出站标记形态不符: ${markers.slice(0, 120)}`).toBeTruthy();

    // 4. 内联字节 = 合法 GIF
    const bytes = Buffer.from(m?.[1] ?? '', 'base64');
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(bytes.byteLength).toBeGreaterThan(2000);
  }, 60_000);
});
