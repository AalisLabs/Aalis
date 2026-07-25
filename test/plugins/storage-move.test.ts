import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { createStorageGateway, type StorageService } from '../../packages/plugin-storage-api/src/index.js';
import * as storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// storage.move 真 fs 回归:file_move 工具的底座。
//   补齐历史缺失的"跨目录移动"能力（rename 仅同目录改名、拒路径分隔符）。
//   agent 整理文件曾因无此能力而越狱到 shell + 宿主绝对路径——move 让它有正道可走，
//   且约束在存储根内（拒宿主绝对路径 / .. 逃逸 / 跨根 / 覆盖）。
// ════════════════════════════════════════════════════════════

describe('storage.move (真 fs)', () => {
  let base: string;
  let ws: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-move-'));
    ws = join(base, 'ws'); // 绝对根路径（root.path 相对 cwd 解析，故用绝对避免污染项目）
    mkdirSync(ws, { recursive: true });
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocal as unknown as Parameters<typeof app.ctx.useModule>[0], {
      roots: [
        {
          name: 'ws',
          path: ws,
          label: 'ws',
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    storage = createStorageGateway(app.ctx);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('跨目录移动：自动建目标父目录 + 源消失', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello');
    const result = await storage.move?.('ws:/a.txt', 'ws:/小说/a.txt');
    expect(result).toBe('ws:/小说/a.txt');
    expect(existsSync(join(ws, '小说', 'a.txt'))).toBe(true); // 移到位，父目录自动创建
    expect(existsSync(join(ws, 'a.txt'))).toBe(false); // 源消失
  });

  it('目标已存在 → 拒绝（不覆盖），源未动', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    writeFileSync(join(ws, 'b.txt'), 'y');
    await expect(storage.move?.('ws:/a.txt', 'ws:/b.txt')).rejects.toThrow(/已存在/);
    expect(existsSync(join(ws, 'a.txt'))).toBe(true);
  });

  it('.. 逃逸目标 → 拒绝（约束在根内）', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    await expect(storage.move?.('ws:/a.txt', 'ws:/../escape.txt')).rejects.toThrow();
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  });
});
