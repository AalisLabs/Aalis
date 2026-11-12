// 没变就不通知：同值设偏好、清一个本来没有的偏好、重复退订同一条登记都是空操作，不发服务变更通知。
// 监听者里无条件重做这些（插件集合一变就把配置里的偏好再套一遍）不会自己喂自己、在微任务里空转。
import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  LogHub,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';

const store = defineService<{ id: string }>('zz-pref-store');
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world() {
  const app = new App({ name: 'preference-unchanged', logLevel: 'error', logHub: new LogHub() });
  apps.push(app);
  const host = app.bind({ provide, services, store: optional(store) });
  await app.plugins.idle();
  host.provide.use(store, { id: 'a' }, { entryId: 'root/a' });
  host.provide.use(store, { id: 'b' }, { entryId: 'root/b' });
  await macrotask();
  const changes: string[] = [];
  host.store.watch(() => void changes.push(store.name));
  return { app, host, changes };
}

describe('没变就不通知', () => {
  it('同一个偏好再设一次、清一个本来没有的偏好（含从没设过偏好的服务）：都不通知', async () => {
    const { host, changes } = await world();
    host.services.use.unprefer(store);
    await macrotask();
    expect(changes).toHaveLength(0);
    host.services.use.prefer(store, 'root/b');
    await macrotask();
    expect(changes).toHaveLength(1);
    host.services.use.prefer(store, 'root/b');
    host.services.use.unprefer(store, { for: 'zz-nobody' });
    await macrotask();
    expect(changes).toHaveLength(1);
    host.services.use.unprefer(store);
    await macrotask();
    expect(changes).toHaveLength(2);
    expect(host.services.use.get(store)?.id).toBe('a');
  });

  it('provide 的退订重复调用、激活关闭之后再调：都不再通知', async () => {
    const { app, changes } = await world();
    let off!: () => void;
    await app.plugin(
      definePlugin({
        name: 'zz-pref-provider',
        uses: { provide },
        apply({ provide }) {
          off = provide.use(store, { id: 'c' });
        },
      }),
    );
    await app.plugins.idle();
    await macrotask();
    const before = changes.length;
    off();
    off();
    await macrotask();
    expect(changes.length - before).toBe(1);
    await app.plugins.unload('zz-pref-provider');
    await macrotask();
    const afterUnload = changes.length;
    off();
    await macrotask();
    expect(changes.length).toBe(afterUnload);
  });
});
