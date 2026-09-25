import { describe, expect, it } from 'vitest';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';

// ════════════════════════════════════════════════════════════
// getHistory/getFullHistory 排序回归（与 memory-sqlite-order 同形）：同毫秒消息必须按插入序稳定返回。
// 纯 timestamp 排序对平票顺序不做承诺，同一轮的 assistant(toolCalls)+tool 合成对读回会倒序，
// 随后被 sanitizeToolCallHistory 整组丢弃。_id 次键杜绝此事。
//
// 集合用内存替身，不经 apply、不 mock mongodb：test/ 下的 mock 拦不住插件目录里解析到的 mongodb，
// 走 MongoClient 会直连本机真实的 mongod。替身在排序键全部平票时按 _id 升序排——这是对抗方向：
// 去掉 _id 次键后读回恰好是 tool 在前；若平票写成 _id 降序，结果与 _id:-1 相同，断言就恒真了。
// ════════════════════════════════════════════════════════════

const SESSION = 'test:order:session';

type Doc = Record<string, unknown> & { _id: number };

function fakeCollection() {
  const docs: Doc[] = [];
  return {
    insertOne: async (doc: Record<string, unknown>) => {
      docs.push({ ...doc, _id: docs.length + 1 });
      return { acknowledged: true };
    },
    find: (filter: { sessionId: string; archived?: unknown }) => {
      let rows = docs.filter(d => d.sessionId === filter.sessionId && !(filter.archived && d.archived === true));
      const cursor = {
        sort: (spec: Record<string, 1 | -1>) => {
          rows = [...rows].sort((a, b) => {
            for (const [key, dir] of Object.entries(spec)) {
              const diff = (a[key] as number) - (b[key] as number);
              if (diff !== 0) return diff * dir;
            }
            return a._id - b._id;
          });
          return cursor;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
  };
}

async function seededService(): Promise<MongoMemoryService> {
  type Col = ConstructorParameters<typeof MongoMemoryService>[0];
  const svc = new MongoMemoryService(fakeCollection() as unknown as Col, {} as never);
  await svc.saveMessage(SESSION, { role: 'user', content: '帮我查下天气', timestamp: 1000 });
  await svc.saveMessage(SESSION, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
    timestamp: 2000,
  });
  await svc.saveMessage(SESSION, { role: 'tool', content: '晴', toolCallId: 'call-1', timestamp: 2000 });
  await svc.saveMessage(SESSION, { role: 'user', content: '谢谢', timestamp: 3000 });
  return svc;
}

describe('MongoMemoryService 同毫秒排序稳定性', () => {
  it('getHistory：同毫秒的 assistant 与 tool 保持插入序（assistant 在前）', async () => {
    const history = await (await seededService()).getHistory(SESSION, 50);
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  });

  it('getFullHistory：同上', async () => {
    const full = await (await seededService()).getFullHistory(SESSION, 50);
    expect(full.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  });
});
