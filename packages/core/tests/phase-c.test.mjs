// Phase C 回归：Context 拆分后各子模块的功能
// - DisposableChain: push/remove/dispose 语义与异常吞咽
// - MixinRegistry: 代理方法、重复注册、dispose 清理
// - PlatformRegistry: 聚合适配器、去重命名
// - PendingRegistrationBuffer: 延迟注册 + 服务就绪自动 flush
//
// 运行: node packages/core/tests/phase-c.test.mjs

import {
  Context,
  EventBus,
  ServiceContainer,
  HookRegistry,
  ConfigManager,
  Logger,
  DisposableChain,
  MixinRegistry,
  PlatformRegistry,
} from '../dist/index.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') await ret;
    console.log(`✓ ${name}`); pass++;
  } catch (err) {
    console.error(`✗ ${name}\n   ${err.message || err}`); fail++;
  }
}
function eq(a, b, m = '') { if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(v, m = '') { if (!v) throw new Error(`${m} expected truthy, got ${JSON.stringify(v)}`); }

function mkCtx(id = 'test') {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const config = new ConfigManager();
  const logger = new Logger('test', 'error');
  return new Context({ id, events, services, hooks, logger, config });
}

// ==================== DisposableChain ====================

await test('DisposableChain: push 后 dispose 按逆序执行', () => {
  const chain = new DisposableChain();
  const order = [];
  chain.push(() => order.push('a'));
  chain.push(() => order.push('b'));
  chain.push(() => order.push('c'));
  chain.dispose();
  eq(order.join(','), 'c,b,a');
  ok(chain.disposed);
});

await test('DisposableChain: remove 能精确移除且不执行', () => {
  const chain = new DisposableChain();
  let called = false;
  const fn = () => { called = true; };
  chain.push(fn);
  eq(chain.size, 1);
  eq(chain.remove(fn), true);
  eq(chain.size, 0);
  chain.dispose();
  eq(called, false);
});

await test('DisposableChain: dispose 中单个抛错不影响其他', () => {
  const chain = new DisposableChain();
  let last = false;
  chain.push(() => { last = true; });
  chain.push(() => { throw new Error('boom'); });
  chain.dispose();
  eq(last, true);
});

await test('DisposableChain: dispose 后 push 立即执行', () => {
  const chain = new DisposableChain();
  chain.dispose();
  let called = false;
  chain.push(() => { called = true; });
  eq(called, true);
});

// ==================== MixinRegistry ====================

await test('MixinRegistry: mixin 将服务方法代理到 Context', () => {
  const ctx = mkCtx();
  const svc = { add(a, b) { return a + b; }, name: 'svc' };
  ctx.provide('calc', svc);
  ctx.mixin('calc', ['add']);
  eq(ctx.add(2, 3), 5);
  eq(Context.getMixins().some(m => m.service === 'calc' && m.methods.includes('add')), true);
});

await test('MixinRegistry: dispose 后方法被从 prototype 清除', () => {
  const ctx = mkCtx();
  const svc = { greet() { return 'hi'; } };
  ctx.provide('greeter', svc);
  const undo = ctx.mixin('greeter', ['greet']);
  eq(ctx.greet(), 'hi');
  undo();
  eq('greet' in Context.prototype, false);
});

await test('MixinRegistry: 重复方法名跳过、不报错', () => {
  const ctx = mkCtx();
  ctx.provide('svcA', { shared: () => 'A' });
  ctx.provide('svcB', { shared: () => 'B' });
  ctx.mixin('svcA', ['shared']);
  // 第二次 mixin 同名方法应被跳过（走 warn 但不抛）
  ctx.mixin('svcB', ['shared']);
  eq(ctx.shared(), 'A'); // 仍然是 A
  // 清理
  delete Context.prototype.shared;
});

// ==================== PlatformRegistry ====================

await test('PlatformRegistry: 聚合多平台 + 去重 capability', () => {
  const ctx = mkCtx();
  const adapter1 = {
    adapterName: 'onebot-main',
    platform: 'onebot',
    getConnections: () => [{ id: 'c1', status: 'connected' }],
  };
  const adapter2 = {
    adapterName: 'cli-term',
    platform: 'cli',
    getConnections: () => [],
  };
  ctx.provide('platform', adapter1, { capabilities: ['onebot'] });
  ctx.provide('platform', adapter2, { capabilities: ['cli'] });

  const registry = ctx.platforms;
  ok(registry instanceof PlatformRegistry);
  const names = registry.listPlatformNames().sort();
  eq(names.join(','), 'cli,onebot');
  const adapters = registry.listAdapters();
  eq(adapters.length, 2);
  const details = registry.listDetails();
  eq(details.length, 2);
  const onebot = details.find(d => d.platform === 'onebot');
  eq(onebot.connections.length, 1);
  eq(onebot.connections[0].id, 'c1');
});

await test('PlatformRegistry: 旧 Context API 通过委托仍可用', () => {
  const ctx = mkCtx();
  const adapter = {
    adapterName: 'test',
    platform: 'test-p',
    getConnections: () => [],
  };
  ctx.provide('platform', adapter, { capabilities: ['test-p'] });
  eq(ctx.getPlatforms().length, 1);
  eq(ctx.getPlatformNames()[0], 'test-p');
  eq(ctx.getPlatformDetails()[0].adapterName, 'test');
});

// ==================== PendingRegistrationBuffer ====================

await test('PendingRegistrationBuffer: tools 未就绪时缓冲、就绪后自动 flush', async () => {
  const ctx = mkCtx();
  const registered = [];

  // 先注册工具（此时 tools 服务还不存在，应该进入缓冲）
  ctx.registerTool({
    definition: { type: 'function', function: { name: 'foo', description: '', parameters: {} } },
    handler: async () => 'foo-result',
  });

  // 后注册 tools 服务
  const fakeTools = {
    register(tool, ctxId) {
      registered.push({ name: tool.definition.function.name, ctxId });
      return () => {};
    },
    registerGroup() { return () => {}; },
    unregisterByPlugin() {},
  };
  ctx.provide('tools', fakeTools);

  // 等事件驱动
  await new Promise(r => setTimeout(r, 20));

  eq(registered.length, 1, 'tool flushed');
  eq(registered[0].name, 'foo');
});

await test('PendingRegistrationBuffer: tools 已就绪时直接注册不缓冲', async () => {
  const ctx = mkCtx();
  const registered = [];
  const fakeTools = {
    register(tool) { registered.push(tool.definition.function.name); return () => {}; },
    registerGroup() { return () => {}; },
    unregisterByPlugin() {},
  };
  ctx.provide('tools', fakeTools);

  ctx.registerTool({
    definition: { type: 'function', function: { name: 'bar', description: '', parameters: {} } },
    handler: async () => {},
  });
  eq(registered.length, 1);
  eq(registered[0], 'bar');
});

await test('PendingRegistrationBuffer: commands 缓冲 + 刷入', async () => {
  const ctx = mkCtx();
  const registered = [];
  ctx.command('ping', 'pong', async () => 'pong');
  const fakeCmds = {
    register(def, ctxId) { registered.push({ name: def.name, ctxId }); return () => {}; },
    unregisterByPlugin() {},
  };
  ctx.provide('commands', fakeCmds);
  await new Promise(r => setTimeout(r, 20));
  eq(registered.length, 1);
  eq(registered[0].name, 'ping');
});

await test('PendingRegistrationBuffer: dispose 清理缓冲', () => {
  const ctx = mkCtx();
  ctx.registerTool({
    definition: { type: 'function', function: { name: 'x', description: '', parameters: {} } },
    handler: async () => {},
  });
  ctx.dispose();
  // 不抛错即可；缓冲已清空
  ok(ctx.disposed);
});

// ==================== 端到端：Context.dispose 统一清理 ====================

await test('Context.dispose: provide + mixin + registerTool 全部清理', async () => {
  const ctx = mkCtx();
  const fakeTools = {
    register() { return () => {}; },
    registerGroup() { return () => {}; },
    unregisterByPlugin() {},
  };
  ctx.provide('tools', fakeTools);
  ctx.provide('m-svc', { hi() { return 'hi'; } });
  ctx.mixin('m-svc', ['hi']);
  ctx.registerTool({
    definition: { type: 'function', function: { name: 't', description: '', parameters: {} } },
    handler: async () => {},
  });

  eq(ctx.hasService('m-svc'), true);
  eq(typeof ctx.hi, 'function');
  ctx.dispose();
  eq(ctx.disposed, true);
  // mixin 方法应被清除
  eq('hi' in Context.prototype, false);
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail > 0 ? 1 : 0);
