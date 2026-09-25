import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { media } from '../../packages/api-media/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';

// ════════════════════════════════════════════════════════════
// preview_image 随 media 在场注册：识别全靠 media，media 缺席时这个工具只会返回
// 「未启用 media 服务」，挂着只是让 agent 白试一次。media 上线才挂、离场即撤。
// ════════════════════════════════════════════════════════════

const tick = () => new Promise(r => setTimeout(r, 0));

describe('preview_image 跟随 media 在场', () => {
  let app: App;
  let provideMedia: () => () => void;
  const registered = new Set<string>();

  beforeEach(async () => {
    registered.clear();
    app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ provide, events });
    host.provide(tools, {
      register: (t: { definition: { function: { name: string } } }) => {
        const name = t.definition.function.name;
        registered.add(name);
        return () => registered.delete(name);
      },
      registerGroup: () => () => {},
    } as never);
    provideMedia = () => host.provide(media, { describeImage: async () => '一只猫' } as never);
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();
  });

  afterEach(async () => {
    await app.stop();
  });

  it('media 缺席不挂；media 上线补挂；media 下线撤回（send_attachment 始终在）', async () => {
    expect(registered.has('send_attachment')).toBe(true);
    expect(registered.has('preview_image'), 'media 缺席时不该挂 preview_image').toBe(false);

    const withdraw = provideMedia();
    await tick();
    expect(registered.has('preview_image'), 'media 上线后应补挂 preview_image').toBe(true);

    withdraw();
    await tick();
    expect(registered.has('preview_image'), 'media 下线后应撤回 preview_image').toBe(false);
    expect(registered.has('send_attachment')).toBe(true);
  });
});
