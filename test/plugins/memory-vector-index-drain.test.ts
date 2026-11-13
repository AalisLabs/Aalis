import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type EmbeddingService, embedding } from '../../packages/api-embedding/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 向量记忆停用时，排着的与在途的收录在收尾段里写完再撤回：这时向量化与向量存储都还在，收录不随停用中止，也不因撤回后
// 取不到服务而丢。超过清理宽限的按 core 的规则处理，这里不涉及。向量化与向量存储是替身，向量化等用例放行才回。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:10000:group:20001';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const archived = (content: string, timestamp: number) => ({
  sessionId: SESSION,
  incoming: { content, sessionId: SESSION, platform: 'onebot', userId: '30001' },
  archivedMessage: { role: 'user', content, timestamp, metadata: { userId: '30001', platform: 'onebot' } } as Message,
});

describe('memory-vector 停用时等排着与在途的收录', () => {
  it('一条在途、一条排着时停用：停用落定时两条都写进了向量库', async () => {
    const app = new App({ logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, events, hooks, contributions });
    // 每条的向量化各等一道闸
    const gates = new Map([
      ['第一条', deferred<void>()],
      ['第二条', deferred<void>()],
    ]);
    const embedded: string[] = [];
    const embedder: EmbeddingService = {
      async embed(text) {
        embedded.push(text);
        await gates.get(text)?.promise;
        return [0.1, 0.2, 0.3];
      },
    };
    host.provide.use(embedding, embedder);
    const written: unknown[] = [];
    const store: VectorStoreService = {
      async add(_vector, metadata) {
        written.push(metadata.content);
      },
      async search() {
        return [];
      },
      async size() {
        return written.length;
      },
      async clear() {
        written.length = 0;
      },
      async save() {},
    };
    host.provide.use(vectorstore, store);
    await app.plugin(memoryVector, { indexing: { concurrency: 1, maxQueueSize: 10 } });
    await app.plugins.idle();
    if (app.plugins.getPlugin(memoryVector.name)?.state !== 'active') throw new Error('向量记忆未激活');

    await host.events.use.emit('inbound:message:archived', archived('第一条', 1));
    await host.events.use.emit('inbound:message:archived', archived('第二条', 2));
    await vi.waitFor(() => expect(embedded).toEqual(['第一条']));
    const disabled = app.plugins.disable(memoryVector.name);
    await new Promise(resolve => setImmediate(resolve));
    gates.get('第一条')?.resolve();
    // 第一条写完后排着的第二条才开始，这时停用还在收尾段里
    await vi.waitFor(() => expect(embedded).toEqual(['第一条', '第二条']));
    await new Promise(resolve => setImmediate(resolve));
    gates.get('第二条')?.resolve();
    await disabled;
    expect(written).toEqual(['第一条', '第二条']);
  });
});
