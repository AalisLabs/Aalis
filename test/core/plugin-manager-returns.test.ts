import { describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  LogHub,
  lifecycle,
  type PluginDefinition,
  type PluginDescriptor,
} from '../../packages/core/src/index.js';

// 管理动作返回值的统一口径（PluginManagerService 的 JSDoc）：
//   false = 主体不在注册表，或本次动作被状态 / 政策规则挡下；true = 其余，含幂等。
// 六个动作里 enable / disable / updateConfig / bounce 早已如此，本文件钉住
// register / unload 与 App.plugin / rescanPlugins 的转发。

function silentApp(): App {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

const plugin = (name: string, extra: Partial<Pick<PluginDefinition, 'reusable'>> = {}): PluginDefinition =>
  definePlugin({ name, apply() {}, ...extra });

describe('register 的返回值', () => {
  it('落账为 true；重名与未声明 reusable 的多实例为 false', async () => {
    const app = silentApp();
    expect(await app.plugins.register(plugin('p'))).toBe(true);
    expect(await app.plugins.register(plugin('p')), '重名').toBe(false);
    expect(await app.plugins.register(plugin('p'), {}, 'p:second'), '未声明 reusable').toBe(false);
    expect(await app.plugins.register(plugin('q', { reusable: true }), {}, 'q:second'), 'reusable 多实例').toBe(true);
    await app.stop();
  });

  it('注册为 disabled 态也是落账（true）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {}, disabledPlugins: ['p'] } });
    expect(await app.plugins.register(plugin('p'))).toBe(true);
    expect(app.plugins.getPlugin('p')?.state).toBe('disabled');
    await app.stop();
  });

  it('App.plugin 透传 register 的结果', async () => {
    const app = silentApp();
    expect(await app.plugin(plugin('p'))).toBe(true);
    expect(await app.plugin(plugin('p'))).toBe(false);
    await app.stop();
  });

  it('手写缺 name / 空串 / 非法分隔符：false + warn 一次 + 不落账', async () => {
    const hub = new LogHub();
    const lines: string[] = [];
    hub.onEntry(e => lines.push(`${e.level}:${e.message}`));
    const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });

    // 手写对象绕过 definePlugin：类型上缺 name，运行期必须拒落账
    expect(await app.plugins.register({ apply() {} } as unknown as PluginDefinition)).toBe(false);
    expect(await app.plugins.register({ name: '', apply() {} })).toBe(false);
    expect(await app.plugins.register({ name: 'a#b', apply() {} })).toBe(false);
    expect(await app.plugins.register({ name: 'a:b', apply() {} })).toBe(false);

    await app.plugins.idle();
    expect(app.plugins.getStatus()).toEqual([]);
    expect(JSON.parse(JSON.stringify(app.plugins.getStatus()))).toEqual([]);

    const warns = lines.filter(l => l.startsWith('warn:') && l.includes('拒绝注册'));
    expect(warns, '每个非法定义恰好 warn 一次').toHaveLength(4);
    await app.stop();
  });

  it('App.plugin 对手写缺 name 同样返回 false、不落账', async () => {
    const app = silentApp();
    expect(await app.plugin({ apply() {} } as unknown as PluginDefinition)).toBe(false);
    await app.plugins.idle();
    expect(app.plugins.getStatus()).toEqual([]);
    await app.stop();
  });

  it('非法 instanceId：false + warn；合法多实例仍 true', async () => {
    const hub = new LogHub();
    const lines: string[] = [];
    hub.onEntry(e => lines.push(`${e.level}:${e.message}`));
    const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });
    const reusable = plugin('q', { reusable: true });

    expect(await app.plugins.register(reusable, {}, '')).toBe(false);
    expect(await app.plugins.register(reusable, {}, 'q#x')).toBe(false);
    expect(await app.plugins.register(reusable, {}, 'q:second')).toBe(true);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('q:second')?.state).toBe('active');
    expect(app.plugins.getPlugin('')).toBeUndefined();
    expect(app.plugins.getPlugin('q#x')).toBeUndefined();

    const warns = lines.filter(l => l.startsWith('warn:') && l.includes('拒绝注册'));
    expect(warns, '空串与 # 各 warn 一次').toHaveLength(2);
    expect(warns.some(l => l.includes('缺少合法 instanceId'))).toBe(true);
    expect(warns.some(l => l.includes('#') && l.includes('instanceId'))).toBe(true);
    await app.stop();
  });

  it('手写 uses 非描述符：false + warn，不落账', async () => {
    const hub = new LogHub();
    const lines: string[] = [];
    hub.onEntry(e => lines.push(`${e.level}:${e.message}`));
    const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });

    expect(
      await app.plugins.register({
        name: 'bad-uses',
        uses: { x: 'not-a-descriptor' },
        apply() {},
      } as unknown as PluginDefinition),
    ).toBe(false);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('bad-uses')).toBeUndefined();
    expect(
      lines.filter(l => l.startsWith('warn:') && l.includes('拒绝注册') && l.includes('不是服务描述符')),
    ).toHaveLength(1);
    await app.stop();
  });
});

describe('unload 的返回值', () => {
  it('不在注册表为 false；卸载完成为 true；join 在途卸载也是 true', async () => {
    const app = silentApp();
    expect(await app.plugins.unload('nobody')).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    await app.plugins.register(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDispose(() => gate);
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');

    const first = app.plugins.unload('p'); // 卡在 onDispose 上，state 已是 'disposed'
    await new Promise<void>(r => setTimeout(r, 0));
    expect(app.plugins.getPlugin('p')?.state).toBe('disposed');
    const second = app.plugins.unload('p'); // 撞上在途卸载：join，不是拒绝
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(app.plugins.getPlugin('p')).toBeUndefined();
    await app.stop();
  });
});

describe('rescanPlugins 只报真正落账的插件', () => {
  it('描述符名与模块自报名不同、而自报名已注册时，不计入热加载名单', async () => {
    const app = silentApp();
    await app.plugin(plugin('real'));
    (app as unknown as { pluginLoader: unknown }).pluginLoader = {
      async discover(): Promise<PluginDescriptor[]> {
        return [
          { name: 'alias-of-real', source: 'stub', metadata: {} },
          { name: 'fresh', source: 'stub', metadata: {} },
        ];
      },
      async load(desc: PluginDescriptor): Promise<PluginDefinition> {
        return plugin(desc.name === 'alias-of-real' ? 'real' : desc.name);
      },
    };
    expect(await app.rescanPlugins()).toEqual(['fresh']);
    await app.stop();
  });
});

describe('enable / disable / bounce 的 false 分支（口径句里点名的「主体不在注册表」与「被规则挡下」）', () => {
  it('主体不在注册表：三个动作都是 false，且各记一条 debug 而非静默', async () => {
    const hub = new LogHub();
    const lines: string[] = [];
    hub.onEntry(e => lines.push(`${e.level}:${e.message}`));
    const app = new App({ config: { name: 'T', logLevel: 'debug', plugins: {} }, logHub: hub });
    expect(await app.plugins.enable('nobody')).toBe(false);
    expect(await app.plugins.disable('nobody')).toBe(false);
    expect(await app.plugins.bounce('nobody')).toBe(false);
    expect(lines.filter(l => l.startsWith('debug:') && l.includes('"nobody" 不在注册表'))).toHaveLength(3);
    await app.stop();
  });

  it('被规则挡下：disabled 态 bounce 为 false', async () => {
    const app = silentApp();
    await app.plugins.register(plugin('p'));
    await app.plugins.idle();
    expect(await app.plugins.disable('p')).toBe(true);
    expect(await app.plugins.bounce('p'), 'disabled 态 bounce').toBe(false);
    await app.stop();
  });

  it("'disposed' 在途：enable / disable 为 false（终态对管理路径单向）", async () => {
    const app = silentApp();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    await app.plugins.register(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.onDispose(() => gate);
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('p')?.state).toBe('active');
    const unloading = app.plugins.unload('p');
    await new Promise<void>(r => setTimeout(r, 0));
    expect(app.plugins.getPlugin('p')?.state).toBe('disposed');
    expect(await app.plugins.enable('p')).toBe(false);
    expect(await app.plugins.disable('p')).toBe(false);
    release();
    await unloading;
    await app.stop();
  });
});
