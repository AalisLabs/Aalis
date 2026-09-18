import { describe, expect, it } from 'vitest';
import { App, type PluginDescriptor, type PluginModule } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 管理动作返回值的统一口径（PluginManagerService 的 JSDoc）：
//   false = 主体不在注册表，或本次动作被状态 / 政策规则挡下；true = 其余，含幂等。
// 六个动作里 enable / disable / updateConfig / bounce 早已如此，本文件钉住新并入的
// register / unload 与 App.plugin / rescanPlugins 的转发。
// ════════════════════════════════════════════════════════════

function silentApp(): App {
  return new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
}

const plugin = (name: string, extra: Partial<PluginModule> = {}): PluginModule => ({ name, apply() {}, ...extra });

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
      plugin('p', {
        apply(ctx) {
          ctx.onDispose(() => gate);
        },
      }),
    );
    await app.plugins.idle();

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
      async load(desc: PluginDescriptor): Promise<PluginModule> {
        return plugin(desc.name === 'alias-of-real' ? 'real' : desc.name);
      },
    };
    expect(await app.rescanPlugins()).toEqual(['fresh']);
    await app.stop();
  });
});
