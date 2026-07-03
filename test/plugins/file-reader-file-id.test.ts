import { describe, expect, it } from 'vitest';
import { computeFileId } from '../../packages/plugin-file-reader/src/index.js';

// ════════════════════════════════════════════════════════════
// file-reader 文件 ID：以 sessionId 加盐的内容寻址
//   回归「同内容跨会话撞键、把前一会话的索引条目挤掉」的 bug。
// ════════════════════════════════════════════════════════════

describe('computeFileId', () => {
  const content = Buffer.from('hello world 相同内容');

  it('同会话 + 同内容 → 同 ID（会话内去重仍生效）', async () => {
    const a = await computeFileId('sessionA', content);
    const b = await computeFileId('sessionA', Buffer.from('hello world 相同内容'));
    expect(a).toBe(b);
  });

  it('不同会话 + 同内容 → 不同 ID（避免跨会话撞键）', async () => {
    const a = await computeFileId('sessionA', content);
    const b = await computeFileId('sessionB', content);
    expect(a).not.toBe(b);
  });

  it('同会话 + 不同内容 → 不同 ID', async () => {
    const a = await computeFileId('sessionA', Buffer.from('内容一'));
    const b = await computeFileId('sessionA', Buffer.from('内容二'));
    expect(a).not.toBe(b);
  });

  it('ID 为 16 位十六进制', async () => {
    const id = await computeFileId('s', content);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
