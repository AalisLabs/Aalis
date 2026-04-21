// 验证 Phase A / B / D 的核心能力：
// - Phase A: 能力声明框架常量/注册；provide 接受合法能力
// - Phase B: dev 模式下 probe 校验；缺失方法时 provide 抛错
// - Phase D: LLMRouter 聚合 listModels、supportsModel 快路径、cache 失效
//
// 运行: node --import tsx packages/core/tests/phase-abd.test.ts
// (或直接 node packages/core/tests/phase-abd.test.mjs 若已编译)

import {
  Context,
  EventBus,
  ServiceContainer,
  HookRegistry,
  ConfigManager,
  Logger,
  LLMCapabilities,
  MemoryCapabilities,
  ImageRecognitionCapabilities,
  WebSearchCapabilities,
  LLMRouter,
  registerCapabilityProbe,
  probeCapability,
} from '../dist/index.js';

// ---- 极简 assert ----
let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') {
      return ret.then(
        () => { console.log(`✓ ${name}`); pass++; },
        err => { console.error(`✗ ${name}\n   ${err.message}`); fail++; },
      );
    }
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`✗ ${name}\n   ${err.message}`);
    fail++;
  }
}
function eq(a, b, msg = '') {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}
function ok(v, msg = '') {
  if (!v) throw new Error(`${msg} expected truthy, got ${JSON.stringify(v)}`);
}
async function throws(fn, pattern, msg = '') {
  try {
    await fn();
  } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new Error(`${msg} error message mismatch: ${err.message}`);
    return;
  }
  throw new Error(`${msg} expected throw`);
}

function mkCtx() {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const config = new ConfigManager();
  const logger = new Logger('test', 'error');
  return new Context({ id: 'test', events, services, hooks, logger, config });
}

// ==================== Phase A ====================

await test('A: LLMCapabilities 常量值正确', () => {
  eq(LLMCapabilities.Chat, 'chat');
  eq(LLMCapabilities.ToolCalling, 'tool_calling');
  eq(LLMCapabilities.Streaming, 'streaming');
});

await test('A: MemoryCapabilities / ImageRecognition / WebSearch 常量可用', () => {
  eq(MemoryCapabilities.History, 'history');
  eq(MemoryCapabilities.TurnArchive, 'turn-archive');
  eq(ImageRecognitionCapabilities.Describe, 'describe');
  eq(WebSearchCapabilities.Web, 'web');
});

await test('A: provide() 合法 LLM 能力注册成功', () => {
  const ctx = mkCtx();
  const service = {
    chat: async () => ({ content: 'hi' }),
    chatStream: async function* () {},
    getTemperature: () => 0.7,
    getMaxTokens: () => 1000,
    getContextLength: () => 4000,
  };
  const dispose = ctx.provide('llm', service, {
    capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming],
  });
  ok(ctx.hasService('llm'));
  const got = ctx.getService('llm');
  eq(got, service);
  dispose();
  ok(!ctx.hasService('llm'));
});

await test('A: provide() 未注册服务名回退到 string（动态服务）', () => {
  const ctx = mkCtx();
  ctx.provide('my-custom-service', { do() {} }, { capabilities: ['anything-goes'] });
  ok(ctx.hasService('my-custom-service'));
});

// ==================== Phase B ====================

await test('B: probe 已就位 - LLM Chat 探测器存在', () => {
  const r = probeCapability('llm', 'chat', { chat: () => {} });
  eq(r, true);
  const r2 = probeCapability('llm', 'chat', {});
  ok(typeof r2 === 'string', 'should fail');
});

await test('B: probe 已就位 - memory History 要求两个方法', () => {
  const r = probeCapability('memory', 'history', { saveMessage: () => {}, getHistory: () => {} });
  eq(r, true);
  const r2 = probeCapability('memory', 'history', { saveMessage: () => {} });
  ok(typeof r2 === 'string');
});

await test('B: 未注册 (service, capability) 返回 null（跳过校验）', () => {
  const r = probeCapability('unknown-svc', 'unknown-cap', {});
  eq(r, null);
});

await test('B: dev 模式 provide() 声明 streaming 但缺 chatStream 时抛错', () => {
  const ctx = mkCtx();
  const bad = { chat: async () => ({ content: '' }) }; // 缺 chatStream
  let err;
  try {
    ctx.provide('llm', bad, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming] });
  } catch (e) {
    err = e;
  }
  ok(err, 'should throw');
  ok(/chatStream/.test(err.message), `error mentions chatStream: ${err.message}`);
});

await test('B: dev 模式 provide() memory 声明 TurnArchive 但缺 saveTurn 抛错', () => {
  const ctx = mkCtx();
  const bad = { saveMessage: () => {}, getHistory: () => {}, clearSession: () => {} };
  let err;
  try {
    ctx.provide('memory', bad, {
      capabilities: [MemoryCapabilities.History, MemoryCapabilities.TurnArchive],
    });
  } catch (e) {
    err = e;
  }
  ok(err);
  ok(/saveTurn/.test(err.message), `error mentions saveTurn: ${err.message}`);
});

await test('B: registerCapabilityProbe 可扩展第三方能力', () => {
  registerCapabilityProbe('my-svc', 'my-cap', inst =>
    typeof inst.doStuff === 'function' ? true : 'needs doStuff()');
  const ctx = mkCtx();
  let err;
  try {
    ctx.provide('my-svc', {}, { capabilities: ['my-cap'] });
  } catch (e) { err = e; }
  ok(err && /doStuff/.test(err.message));
  // 通过方法后可注册
  ctx.provide('my-svc', { doStuff: () => {} }, { capabilities: ['my-cap'] });
  ok(ctx.hasService('my-svc'));
});

// ==================== Phase D ====================

await test('D: LLMRouter.listAllModels 聚合多提供者', async () => {
  const ctx = mkCtx();
  const p1 = {
    chat: async () => ({ content: '' }),
    chatStream: async function* () {},
    getTemperature: () => 0,
    getMaxTokens: () => 0,
    getContextLength: () => 0,
    listModels: async () => [{ id: 'gpt-4', capabilities: ['chat'] }],
  };
  const p2 = {
    chat: async () => ({ content: '' }),
    chatStream: async function* () {},
    getTemperature: () => 0,
    getMaxTokens: () => 0,
    getContextLength: () => 0,
    listModels: async () => [{ id: 'claude-3', capabilities: ['chat'] }],
  };
  ctx.provide('llm', p1, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming], label: 'P1' });
  // 第二个 provider 需要 child context (same service name, multiple providers)
  const child = ctx.serviceContainer;
  child.register('llm', p2, ['chat', 'streaming'], 0, 'child-ctx', 'P2');

  const models = await ctx.listAllModels();
  eq(models.length, 2);
  const ids = models.map(m => m.id).sort();
  eq(ids[0], 'claude-3');
  eq(ids[1], 'gpt-4');
  ok(models.every(m => m.provider && m.contextId));
});

await test('D: resolveModelProvider 通过 supportsModel 快路径命中', async () => {
  const ctx = mkCtx();
  const listCalls = { n: 0 };
  const p = {
    chat: async () => ({ content: '' }),
    chatStream: async function* () {},
    getTemperature: () => 0,
    getMaxTokens: () => 0,
    getContextLength: () => 0,
    supportsModel: (id) => id === 'fast-model',
    listModels: async () => { listCalls.n++; return []; },
  };
  ctx.provide('llm', p, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming] });

  const r = await ctx.resolveModelProvider('fast-model');
  ok(r);
  eq(r.model, 'fast-model');
  eq(r.instance, p);
  eq(listCalls.n, 0, 'listModels 不应被调用');
});

await test('D: resolveModelProvider 回退到 listModels 枚举', async () => {
  const ctx = mkCtx();
  const p = {
    chat: async () => ({ content: '' }),
    chatStream: async function* () {},
    getTemperature: () => 0,
    getMaxTokens: () => 0,
    getContextLength: () => 0,
    listModels: async () => [{ id: 'slow-model', capabilities: ['chat'] }],
  };
  ctx.provide('llm', p, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming] });

  const r = await ctx.resolveModelProvider('slow-model');
  ok(r);
  eq(r.model, 'slow-model');

  const none = await ctx.resolveModelProvider('nonexistent');
  eq(none, undefined);
});

await test('D: LLMRouter 缓存在服务注销后自动失效', async () => {
  const ctx = mkCtx();
  const p = {
    chat: async () => ({ content: '' }),
    chatStream: async function* () {},
    getTemperature: () => 0,
    getMaxTokens: () => 0,
    getContextLength: () => 0,
    listModels: async () => [{ id: 'abc', capabilities: ['chat'] }],
  };
  const dispose = ctx.provide('llm', p, { capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming] });

  let map = await ctx.getModelProviderMap();
  ok(map.has('abc'));

  dispose(); // 触发 service:unregistered → invalidate

  // 等事件队列处理
  await new Promise(r => setTimeout(r, 10));

  map = await ctx.getModelProviderMap();
  eq(map.size, 0, '注销后应返回空映射');
});

await test('D: ctx.llm 与旧 API 一致', async () => {
  const ctx = mkCtx();
  ok(ctx.llm instanceof LLMRouter);
  const models = await ctx.llm.listAllModels();
  eq(models.length, 0);
});

// ==================== 总结 ====================

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
