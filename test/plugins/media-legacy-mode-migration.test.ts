import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import * as mediaModule from '../../packages/plugin-media/src/index.js';
import { legacyVisionMode } from '../../packages/plugin-media/src/index.js';

// 旧键 vision.mode 的一次性迁移：apply 时按旧语义写入新键、删除旧键并写回配置。
// 不迁移的话：config-sync 每次启动都物化默认值，存量部署里旧键永远有值、永远覆盖新键，
// WebUI 的 select 又清不掉它——新开关成死键。

async function applyWith(vision: Record<string, unknown>) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('process', {} as never);
  app.ctx.provide('storage', {} as never);
  await app.ctx.useModule(mediaModule as never, { vision });
  await app.plugins.idle();
  const stored = app.ctx.config.getPluginConfig<{ vision?: Record<string, unknown> }>('@aalis/plugin-media');
  await app.stop().catch(() => {});
  return stored;
}

describe('vision.mode 一次性迁移', () => {
  it('passthrough → recognizeOnArrival=false + delivery=passthrough，旧键删除并写回', async () => {
    const stored = await applyWith({ mode: 'passthrough', maxTokens: 123 });
    expect(stored.vision).toMatchObject({ recognizeOnArrival: false, delivery: 'passthrough', maxTokens: 123 });
    expect(stored.vision).not.toHaveProperty('mode');
  });

  it('disabled → 不识别 + 转文字', async () => {
    const stored = await applyWith({ mode: 'disabled' });
    expect(stored.vision).toMatchObject({ recognizeOnArrival: false, delivery: 'describe' });
    expect(stored.vision).not.toHaveProperty('mode');
  });

  it('没有旧键（或表单的「未设置」空串）→ 不写回、不动配置', async () => {
    expect(legacyVisionMode('')).toBeNull();
    const stored = await applyWith({ mode: '', delivery: 'describe' });
    expect(Object.keys(stored)).toEqual([]); // 未调用 setPluginConfig，config 里没有本插件的段
  });
});
