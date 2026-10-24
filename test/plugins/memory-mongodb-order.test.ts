import { describe, expect, it } from 'vitest';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';
import { type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// getHistory/getFullHistory 排序回归（与 memory-sqlite-order 同形）：同毫秒消息必须按插入序稳定返回。
// 纯 timestamp 排序对平票顺序不做承诺，同一轮的 assistant(toolCalls)+tool 合成对读回会倒序，
// 随后被 sanitizeToolCallHistory 整组丢弃。_id 次键杜绝此事。
//
// 集合用内存替身，不经 apply、不 mock mongodb：test/ 下的 mock 拦不住插件目录里解析到的 mongodb，
// 走 MongoClient 会直连本机真实的 mongod。替身在排序键全部平票时按 _id 升序排——这是对抗方向：
// 去掉 _id 次键后读回恰好是 tool 在前；若平票写成 _id 降序，结果与 _id:-1 相同，断言就恒真了。getHistory 按条数读时先找
// 分界那一条（第 limit+1 新的对话消息），它的排序同样要带 _id 次键：同毫秒的一组正好落在分界上时，去掉就找错那一条。
// ════════════════════════════════════════════════════════════

const SESSION = 'test:order:session';

type Doc = Record<string, unknown> & { _id: number };

type Filter = Record<string, unknown>;

/** 替身认得的条件只有 getHistory 用到的：相等、$or、$ne、$nin、$gt（没有这个字段的文档不落在 $nin 的列表里） */
function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Filter[]).some(branch => matches(doc, branch));
    const value = doc[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$ne') return value !== arg;
      if (op === '$nin') return !(arg as unknown[]).includes(value);
      if (op === '$gt') return (value as number) > (arg as number);
      throw new Error(`替身不认 ${op}`);
    });
  });
}

function fakeCollection() {
  const docs: Doc[] = [];
  return {
    insertOne: async (doc: Record<string, unknown>) => {
      docs.push({ ...doc, _id: docs.length + 1 });
      return { acknowledged: true };
    },
    find: (filter: Filter) => {
      let rows = docs.filter(d => matches(d, filter));
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
        skip: (n: number) => {
          rows = rows.slice(n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
  };
}

function service(): MongoMemoryService {
  type Col = ConstructorParameters<typeof MongoMemoryService>[0];
  return new MongoMemoryService(fakeCollection() as unknown as Col, {} as never, { logger: { warn() {} } });
}

async function seededService(): Promise<MongoMemoryService> {
  const svc = service();
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

  it('getHistory 按条数读：同毫秒的一组落在分界上时，分界按写入序找，夹在组里的标记与结果照带回', async () => {
    const svc = service();
    const call = { id: 'call-1', type: 'function' as const, function: { name: 'weather', arguments: '{}' } };
    const stored: Message[] = [
      { role: 'user', content: '提问一', timestamp: 1000 },
      { role: 'assistant', content: null, toolCalls: [call], timestamp: 2000 },
      { role: 'system', kind: WellKnownKinds.EventMarker, content: '', timestamp: 2000 },
      { role: 'tool', content: '晴', toolCallId: 'call-1', timestamp: 2000 },
      { role: 'user', content: '提问二', timestamp: 3000 },
    ];
    for (const message of stored) await svc.saveMessage(SESSION, message);
    // 对话消息从新到旧：提问二、结果、调用、提问一；第 3 新的是调用，读它之后的全部
    const history = await svc.getHistory(SESSION, 2);
    expect(history.map(m => m.kind ?? m.role)).toEqual([WellKnownKinds.EventMarker, 'tool', 'user']);
  });
});
