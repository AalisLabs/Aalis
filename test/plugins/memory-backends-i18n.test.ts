import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckResult,
  type CheckSpec,
  type DoctorService,
  doctor,
  failureText,
} from '../../packages/api-doctor/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type LifecycleCap, type Logger, type Provide, provide } from '../../packages/core/src/index.js';
import embeddingOllama from '../../packages/plugin-embedding-ollama/src/index.js';
import { openAndProvide } from '../../packages/plugin-memory-mongodb/src/index.js';
import memorySqlite from '../../packages/plugin-memory-sqlite/src/index.js';
import { isTextError } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 记忆后端与嵌入服务给人看的报错按读者的语言：MongoDB 连接失败、库名超长与 SQLite 两个实例共用一个库是插件失败原因，
// 挂着文字对象、按配置错误的照旧是 ConfigError；Ollama 嵌入的诊断项端点回 404 时，诊断项的包装句按读者的
// 语言，上游原话原样在里面。中文与改动前逐字相同。MongoDB 用替身客户端直接调 openAndProvide（经 apply 会连真实的
// mongod），SQLite 开在临时目录里，fetch 用替身。
// ════════════════════════════════════════════════════════════

const SQLITE_DIR = mkdtempSync(join(tmpdir(), 'zz-memory-backends-i18n-'));
const SQLITE_DB = join(SQLITE_DIR, 'aalis.db');
afterAll(() => rmSync(SQLITE_DIR, { recursive: true, force: true }));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  vi.unstubAllGlobals();
});

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

/** openAndProvide 要的一次激活：onDispose 不执行，同一个 id 的两次激活互不相干 */
function mongoCaps(id: string) {
  const noop = () => {};
  const lifecycle: LifecycleCap = {
    id,
    signal: new AbortController().signal,
    onDrain: () => noop,
    onDispose: () => noop,
  };
  return {
    logger: fixedRef(silent),
    lifecycle: fixedRef(lifecycle),
    provide: fixedRef((() => noop) as unknown as Provide),
  };
}

type MongoClient = Parameters<typeof openAndProvide>[0];
const mongoClient = (connect: () => Promise<void> = async () => {}) =>
  ({
    connect,
    db: () => ({ collection: () => ({ createIndex: async () => {} }) }),
    close: async () => {},
  }) as unknown as MongoClient;

const MONGO = '@aalis/plugin-memory-mongodb';
const SQLITE = '@aalis/plugin-memory-sqlite';

/** 两个 SQLite 实例开同一个文件，交出后激活那个的失败 */
async function sqliteClash() {
  const app = new App({ name: 'T', logger: silent });
  apps.push(app);
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  app.bind({ provide }).provide.use(storage, {
    listRoots: () => roots,
    resolveLocalPath: async () => SQLITE_DB,
  } as unknown as StorageService);
  for (const id of [SQLITE, `${SQLITE}:c`]) {
    await app.plugins.register(memorySqlite, {}, id);
    await app.plugins.idle();
  }
  return app.plugins.getStatus().find(e => e.instanceId === `${SQLITE}:c`)?.failure;
}

/** openAndProvide 的失败 */
const mongoFailure = (run: Promise<void>) =>
  run.then(
    () => undefined,
    (failure: unknown) => failure,
  );

describe('记忆后端的插件失败原因：带文字对象，en 是英文，zh-CN 与改动前逐字相同', () => {
  it.each([
    {
      name: 'MongoDB 连接失败',
      fail: () =>
        mongoFailure(
          openAndProvide(
            mongoClient(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'))),
            { uri: 'mongodb://zz.invalid', database: '', collection: 'messages' },
            mongoCaps(MONGO),
          ),
        ),
      errorName: 'TextError',
      en: 'MongoDB connection failed (make sure MongoDB is running and the uri config item is right): connect ECONNREFUSED 127.0.0.1:1',
      zh: 'MongoDB 连接失败（确认 MongoDB 在运行、配置项 uri 写对）: connect ECONNREFUSED 127.0.0.1:1',
    },
    {
      name: 'MongoDB 库名超长',
      fail: () =>
        mongoFailure(
          openAndProvide(
            mongoClient(),
            { uri: 'mongodb://zz.invalid', database: 'z'.repeat(64), collection: 'messages' },
            mongoCaps(MONGO),
          ),
        ),
      errorName: 'ConfigError',
      en: `MongoDB database name ${'z'.repeat(64)} exceeds the 63-byte limit: give ${MONGO} a shorter database`,
      zh: `MongoDB 库名 ${'z'.repeat(64)} 超过 63 字节的上限：请给 ${MONGO} 另配一个短些的 database`,
    },
    {
      name: 'SQLite 两个实例共用一个库',
      fail: sqliteClash,
      errorName: 'ConfigError',
      en: `Database file ${SQLITE_DB} is already used by instance ${SQLITE}; two instances cannot share a database: give ${SQLITE}:c another path`,
      zh: `数据库文件 ${SQLITE_DB} 已被实例 ${SQLITE} 使用，两个实例不能共用一个库：请给 ${SQLITE}:c 另配 path`,
    },
  ])('$name', async ({ fail, errorName, en, zh }) => {
    const failure = await fail();
    if (!isTextError(failure)) throw new Error(`失败原因没有文字对象：${String(failure)}`);
    expect(failure.name).toBe(errorName);
    expect(renderIn(failureText({ failure }), 'en')).toBe(en);
    expect(renderIn(failureText({ failure }), 'zh-CN')).toBe(zh);
  });
});

describe('Ollama 嵌入的诊断项：包装句按读者的语言，上游原话原样在里面', () => {
  type Mode = 'missing' | 'bare';

  /** 嵌入端点回 404：missing 带模型没 pull 时 Ollama 的说明，bare 不带响应体 */
  function stubFetch(mode: Mode) {
    const body = mode === 'missing' ? JSON.stringify({ error: 'model "zz" not found, try pulling it first' }) : '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 404, statusText: 'Not Found' })),
    );
  }

  async function check(mode: Mode): Promise<CheckResult> {
    stubFetch(mode);
    const specs: CheckSpec[] = [];
    const app = new App({ name: 'T', logger: silent });
    apps.push(app);
    app.bind({ provide }).provide.use(doctor, {
      registerCheck: (spec: CheckSpec) => {
        specs.push(spec);
        return () => {};
      },
    } as unknown as DoctorService);
    await app.plugins.register(embeddingOllama, { baseUrl: 'http://gw.invalid:11434', model: 'zz', retries: 0 });
    await app.plugins.idle();
    const spec = specs[0];
    if (!spec) throw new Error('没有登记诊断项');
    return (await spec.run()) as CheckResult;
  }

  const FIX = {
    en: 'Make sure Ollama is running and you have run ollama pull zz (or change the model config item to an embedding model this machine has)',
    zh: '确认 Ollama 在运行，并已执行 ollama pull zz（或把配置项 model 改成本机已有的嵌入模型）',
  };

  it.each([
    {
      mode: 'missing' as const,
      en: `Ollama embedding request failed (/api/embeddings): 404 Not Found — model "zz" not found, try pulling it first\n${FIX.en}`,
      zh: `Ollama embedding 请求失败 (/api/embeddings): 404 Not Found —— model "zz" not found, try pulling it first\n${FIX.zh}`,
    },
    {
      mode: 'bare' as const,
      en: `Ollama embedding request failed (/api/embeddings): 404 Not Found\n${FIX.en}`,
      zh: `Ollama embedding 请求失败 (/api/embeddings): 404 Not Found\n${FIX.zh}`,
    },
  ])('$mode', async ({ mode, en, zh }) => {
    const result = await check(mode);
    expect(result.level).toBe('error');
    expect(renderIn(result.message, 'en')).toBe(
      'Ollama Embedding unavailable (zz @ http://gw.invalid:11434) — vector memory is not working',
    );
    expect(renderIn(result.message, 'zh-CN')).toBe(
      'Ollama Embedding 不可用 (zz @ http://gw.invalid:11434)——向量记忆不工作',
    );
    expect(renderIn(result.detail, 'en')).toBe(en);
    expect(renderIn(result.detail, 'zh-CN')).toBe(zh);
  });
});
