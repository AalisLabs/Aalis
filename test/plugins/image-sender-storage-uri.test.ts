import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGateway } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as imageSender from '../../packages/plugin-image-sender/src/index.js';
import * as storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// send_attachment 的 storage_uri 归一化——「图明明在却报找不到」回归。
//
// 事故（真机 2026-08-18）：归档给 agent 看的 ref 是历史相对路径 data/images/...
// （无冒号），agent 照 ref 填 send_attachment 的 storage_uri，但 resolveStorageUri
// 漏了 toStorageUri 归一化、直接拿相对路径 stat（storage 需要 data:/images/... 带
// 冒号的 URI），必然 stat 失败 → "存储资源不存在" → agent 6 次全挂、群里回"找不到了"，
// 而文件其实好好在盘上。契约的 toStorageUri 本就该被复用（"勿各自重抄"）。
// ════════════════════════════════════════════════════════════

describe('send_attachment storage_uri 归一化', () => {
  let base: string;
  let app: App;
  let handlers: Record<string, (a: Record<string, unknown>, c: { sessionId: string }) => Promise<string>>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-imgsend-'));
    mkdirSync(join(base, 'data', 'images', 'onebot_x_group_1'), { recursive: true });
    // 落一张真图（内容随意，只验证路径解析）
    writeFileSync(join(base, 'data', 'images', 'onebot_x_group_1', 'abcd1234.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0]));
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocal as unknown as Parameters<typeof app.ctx.useModule>[0], {
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
      ],
    });
    handlers = {};
    app.ctx.provide('tools', {
      register: (t: { definition: { function: { name: string } }; handler: (typeof handlers)[string] }) => {
        handlers[t.definition.function.name] = t.handler;
        return () => {};
      },
      registerGroup: () => {},
    } as never);
    imageSender.apply(app.ctx);
    createStorageGateway(app.ctx); // 确保 gateway 就绪
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('历史相对路径（data/images/...，无冒号）→ 成功发送（删归一化即红）', async () => {
    const outbound: unknown[] = [];
    app.ctx.on('outbound:message', m => {
      outbound.push(m); // 花括号吞掉 push 的返回值：监听器签名要求 void | Promise<void>
    });
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data/images/onebot_x_group_1/abcd1234.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(outbound).toHaveLength(1);
  });

  it('storage URI（data:/images/...，带冒号）→ 同样成功（归一化对已是 URI 幂等）', async () => {
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data:/images/onebot_x_group_1/abcd1234.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.ok).toBe(true);
  });

  it('真不存在的图 → 如实报错（归一化不掩盖真缺失）', async () => {
    const out = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', storage_uri: 'data/images/onebot_x_group_1/nonexistent.jpg' },
        { sessionId: 'onebot:x:group:1' },
      ),
    );
    expect(out.error).toMatch(/存储资源不存在/);
  });
});
