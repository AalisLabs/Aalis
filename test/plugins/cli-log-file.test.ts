import { formatLogLine, type LogEntry } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import { describe, expect, it } from 'vitest';
import { readLogFileTail } from '../../packages/plugin-cli/src/log-file.js';

// ════════════════════════════════════════════════════════════
// cli 历史日志读取：收口为「走 storage（logs:/latest.log）」后，
// 验证 ① 只用 storage URI 寻址（对宿主目录布局无知）；② 读失败优雅返回空
// （文件未就绪 / storage 暂不可用），不抛错冒泡到 app:started。
// ════════════════════════════════════════════════════════════

function entry(seq: number, message: string): LogEntry {
  return { seq, timestamp: '2026-06-21T00:00:00.000Z', level: 'info', scope: 'test', message };
}

/** 仅实现 readFile 的最小 StorageService 桩。 */
function stubStorage(readFile: StorageService['readFile']): StorageService {
  return { readFile } as unknown as StorageService;
}

describe('cli readLogFileTail（走 storage）', () => {
  const lines = [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')].map(formatLogLine).join('');

  it('从 logs:/latest.log 读取、解析并尾切 limit 条', async () => {
    let calledUri = '';
    const storage = stubStorage(async uri => {
      calledUri = uri;
      return lines;
    });
    const out = await readLogFileTail(storage, 2);
    expect(calledUri).toBe('logs:/latest.log'); // 用 URI 寻址，不碰 cwd/绝对路径
    expect(out.map(e => e.message)).toEqual(['b', 'c']);
  });

  it('storage 读失败（文件未就绪/暂不可用）→ 优雅返回空，不抛', async () => {
    const storage = stubStorage(async () => {
      throw new Error('ENOENT');
    });
    await expect(readLogFileTail(storage, 10)).resolves.toEqual([]);
  });

  it('limit 大于条数时返回全部', async () => {
    const storage = stubStorage(async () => lines);
    const out = await readLogFileTail(storage, 100);
    expect(out.map(e => e.seq)).toEqual([1, 2, 3]);
  });
});
