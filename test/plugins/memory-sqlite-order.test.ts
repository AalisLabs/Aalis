import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// getHistory/getFullHistory 排序回归：同毫秒消息必须按插入序稳定返回。
// timestamp 只有毫秒精度，同一轮的 assistant(toolCalls)+tool 合成对（如
// subtask 汇报组连续两次 Date.now()）常落同一毫秒；纯 timestamp 排序对
// 平票顺序不做承诺，实测会把 tool 排到 assistant 前面，随后被
// sanitizeToolCallHistory 当孤儿+不完整组整组丢弃。id 次键杜绝此事。
// ════════════════════════════════════════════════════════════

const SESSION = 'test:order:session';

function makeService(): SQLiteMemoryService {
  return new SQLiteMemoryService(new Database(':memory:'));
}

async function seedSameMsToolPair(svc: SQLiteMemoryService): Promise<void> {
  await svc.saveMessage(SESSION, { role: 'user', content: '帮我查下天气', timestamp: 1000 });
  await svc.saveMessage(SESSION, {
    role: 'assistant',
    content: null,
    toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{}' } },
    ],
    timestamp: 2000,
  });
  await svc.saveMessage(SESSION, { role: 'tool', content: '晴', toolCallId: 'call-1', timestamp: 2000 });
  await svc.saveMessage(SESSION, { role: 'user', content: '谢谢', timestamp: 3000 });
}

describe('SQLiteMemoryService 同毫秒排序稳定性', () => {
  let svc: SQLiteMemoryService;

  beforeEach(async () => {
    svc = makeService();
    await seedSameMsToolPair(svc);
  });

  it('getHistory：同毫秒的 assistant 与 tool 保持插入序（assistant 在前）', async () => {
    const history = await svc.getHistory(SESSION, 50);
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(history[1].toolCalls?.[0]?.id).toBe('call-1');
    expect(history[2].toolCallId).toBe('call-1');
  });

  it('getFullHistory：同上', async () => {
    const full = await svc.getFullHistory(SESSION, 50);
    expect(full.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  });

  it('多组同毫秒平票下顺序整体等于插入序', async () => {
    const svc2 = makeService();
    for (let i = 0; i < 6; i++) {
      await svc2.saveMessage(SESSION, { role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`, timestamp: 5000 });
    }
    const history = await svc2.getHistory(SESSION, 50);
    expect(history.map(m => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });
});
