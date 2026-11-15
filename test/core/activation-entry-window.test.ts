import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  config,
  definePlugin,
  defineService,
  type Logger,
  logger as loggerService,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 激活开头：建激活记录、把条目写成 activating、挂上记录在同一个同步段里做完，中间不执行外来代码。
// 这一段附近的外来代码有两处：每次激活拷一份配置时，按引用透传的叶子上的 Proxy 陷阱；宿主日志器的 child。
// 前者排在挂上记录之后：陷阱里发起的管理动作接手的是本次激活，动作返回 true 时结果与返回值一致，
// 不留下注册表之外的活实例，也不拿着旧配置上线。后者在登记时派生：每次登记一次，激活时不调用。
// 调 apply 之前已被接手的（拷配置的陷阱里、装配函数里），不再调 apply；拷配置的陷阱里被接手的连装配也不做。
// 登记时派生的子日志器，每次激活交给插件的是包在它外面的新的一层：插件就地改它、改它再派生出的子日志器，都只影响这一次激活。
//
// 陷阱只在「武装」之后的第一次触发时动手：先以禁用态登记，再武装、启用，动手的那一次就是激活时的那一次拷贝。

const svc = defineService<{ tag: string }>('aew:svc');

const apps: App[] = [];
/** provider 的 apply 被调用的次数 */
let applies = 0;
afterEach(async () => {
  applies = 0;
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function makeApp(logger?: Logger): App {
  const app = logger ? new App({ logger }) : new App({ logLevel: 'error' });
  apps.push(app);
  return app;
}

/** 按引用透传的叶子（原型不是 Object.prototype）：拷配置时读它的原型，武装后的第一次读取执行 act */
function armedLeaf(act: () => void): { leaf: object; arm: () => void } {
  let armed = false;
  const leaf = new Proxy(
    {},
    {
      getPrototypeOf() {
        if (armed) {
          armed = false;
          act();
        }
        return Date.prototype;
      },
    },
  );
  return {
    leaf,
    arm: () => {
      armed = true;
    },
  };
}

const provider = () =>
  definePlugin({
    name: 'p',
    uses: { provide, config },
    provides: [svc],
    apply({ provide, config }) {
      applies++;
      provide.use(svc, { tag: String(config.use.v) });
    },
  });

const providersOf = (app: App): string[] =>
  app
    .bind({ services })
    .services.use.inspect(svc)
    .map(item => item.contextId);

/** 记下每次 child 调用的作用域 */
function countingLogger(): { logger: Logger; scopes: string[] } {
  const scopes: string[] = [];
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child(scope) {
      scopes.push(scope);
      return logger;
    },
  };
  return { logger, scopes };
}

describe('激活开头不夹外来代码', () => {
  it('拷配置的陷阱里卸载本插件：返回 true，注册表里没有它，它的服务不在线', async () => {
    const app = makeApp();
    let unloading: Promise<boolean> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      unloading = app.plugins.unload('p');
    });
    await app.plugin(provider(), { v: 1, leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('p');
    expect(await unloading).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => item.instanceId)).toEqual([]);
    expect(providersOf(app)).toEqual([]);
    expect(applies).toBe(0);
  });

  it('拷配置的陷阱里停用本插件：返回 true，状态是 disabled，它的服务不在线', async () => {
    const app = makeApp();
    let disabling: Promise<boolean> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      disabling = app.plugins.disable('p');
    });
    await app.plugin(provider(), { v: 1, leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('p');
    expect(await disabling).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => item.state)).toEqual(['disabled']);
    expect(providersOf(app)).toEqual([]);
    expect(applies).toBe(0);
  });

  it('拷配置的陷阱里改本插件的配置：返回 true，在线的那一个实例拿的是新配置', async () => {
    const app = makeApp();
    let updating: Promise<boolean> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      updating = app.plugins.updateConfig('p', { v: 2 });
    });
    await app.plugin(provider(), { v: 1, leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('p');
    expect(await updating).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => item.state)).toEqual(['active']);
    expect(providersOf(app)).toEqual(['p']);
    expect(app.bind({ svc }).svc.use.tag).toBe('2');
    expect(applies).toBe(1);
  });

  it('拷配置的陷阱里停机：stop 落定，条目由停机接手（disposed），不是激活失败', async () => {
    const app = makeApp();
    let stopping: Promise<void> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      stopping = app.stop();
    });
    await app.plugin(provider(), { v: 1, leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('p');
    await stopping;
    expect(app.plugins.getStatus().map(item => [item.state, item.error])).toEqual([['disposed', undefined]]);
    expect(applies).toBe(0);
  });

  it('拷配置的陷阱里卸载它 required 依赖的提供者：依赖方回到 pending，apply 没有被调用', async () => {
    const app = makeApp();
    const dep = defineService<{ ping(): string }>('aew:dep');
    await app.plugin(
      definePlugin({
        name: 'u',
        uses: { provide },
        provides: [dep],
        apply({ provide }) {
          provide.use(dep, { ping: () => 'pong' });
        },
      }),
    );
    await app.plugins.idle();
    let unloading: Promise<boolean> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      unloading = app.plugins.unload('u');
    });
    let applied = 0;
    const consumer = definePlugin({
      name: 'c',
      uses: { dep },
      apply() {
        applied++;
      },
    });
    await app.plugin(consumer, { leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('c');
    expect(await unloading).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => [item.instanceId, item.state])).toEqual([['c', 'pending']]);
    expect(applied).toBe(0);
  });

  it('装配函数里卸载本插件：返回 true，注册表里没有它，apply 没有被调用', async () => {
    const app = makeApp();
    let unloading: Promise<boolean> | undefined;
    const hooked = defineService<object, object>('aew:hooked', port => {
      unloading ??= app.plugins.unload('b');
      return port.provider;
    });
    app.bind({ provide }).provide.use(hooked, {});
    await app.plugins.idle();
    let applied = 0;
    await app.plugin(
      definePlugin({
        name: 'b',
        uses: { hooked },
        apply() {
          applied++;
        },
      }),
    );
    expect(await unloading).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => item.instanceId)).toEqual([]);
    expect(applied).toBe(0);
  });

  it('拷配置的陷阱里卸载本插件：它声明的服务的装配函数没有被调用', async () => {
    const app = makeApp();
    let binds = 0;
    const hooked = defineService<object, object>('aew:counted', port => {
      binds++;
      return port.provider;
    });
    app.bind({ provide }).provide.use(hooked, {});
    await app.plugins.idle();
    expect(binds).toBe(0);
    let unloading: Promise<boolean> | undefined;
    const { leaf, arm } = armedLeaf(() => {
      unloading = app.plugins.unload('k');
    });
    const quiet = definePlugin({ name: 'k', uses: { hooked }, apply() {} });
    await app.plugin(quiet, { leaf }, undefined, { disabled: true });
    arm();
    await app.plugins.enable('k');
    expect(await unloading).toBe(true);
    await app.plugins.idle();
    expect(binds).toBe(0);
  });

  it('插件就地改自己的日志器：只影响这一次激活，重启后拿到的是没改过的另一份', async () => {
    const app = makeApp();
    const seen: Logger[] = [];
    const patched: boolean[] = [];
    await app.plugin(
      definePlugin({
        name: 'lg',
        uses: { logger: loggerService },
        apply({ logger }) {
          seen.push(logger.use);
          patched.push(Object.hasOwn(logger.use, 'mark'));
          Object.assign(logger.use, { mark: true });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.bounce('lg');
    await app.plugins.idle();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(patched).toEqual([false, false]);
  });

  it('宿主日志器往下一级派生不出来时，插件改 child 交回的那个日志器也只影响这一次激活', async () => {
    // 只有根上能派生：派生出的子日志器再 child 就抛错，内核沿用上一层
    const noop = (): void => {};
    const leafLogger: Logger = {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child() {
        throw new Error('只支持一级作用域');
      },
    };
    const app = makeApp({ debug: noop, info: noop, warn: noop, error: noop, child: () => leafLogger });
    const patched: boolean[] = [];
    await app.plugin(
      definePlugin({
        name: 'lg2',
        uses: { logger: loggerService },
        apply({ logger }) {
          const sub = logger.use.child('db');
          patched.push(Object.hasOwn(sub, 'mark'));
          Object.assign(sub, { mark: true });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.bounce('lg2');
    await app.plugins.idle();
    expect(patched).toEqual([false, false]);
  });

  it('宿主根上派生不出子日志器时，插件就地改自己的日志器不影响宿主的 app.logger 与下一次激活', async () => {
    const noop = (): void => {};
    const app = makeApp({
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      child() {
        throw new Error('不支持作用域');
      },
    });
    const patched: boolean[] = [];
    await app.plugin(
      definePlugin({
        name: 'lg3',
        uses: { logger: loggerService },
        apply({ logger }) {
          patched.push(Object.hasOwn(logger.use, 'mark'));
          Object.assign(logger.use, { mark: true });
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.bounce('lg3');
    await app.plugins.idle();
    expect(patched).toEqual([false, false]);
    expect(Object.hasOwn(app.logger, 'mark')).toBe(false);
  });

  it('子日志器在登记时派生一次：启用、重启、改配置都不调用宿主日志器的 child', async () => {
    const { logger, scopes } = countingLogger();
    const app = makeApp(logger);
    const derived = (): number => scopes.filter(scope => scope === 'p').length;
    await app.plugin(provider(), { v: 1 }, undefined, { disabled: true });
    expect(derived()).toBe(1);
    await app.plugins.enable('p');
    await app.plugins.bounce('p');
    await app.plugins.updateConfig('p', { v: 2 });
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(item => item.state)).toEqual(['active']);
    expect(derived()).toBe(1);
  });
});
