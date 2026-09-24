import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import media, { legacyVisionMode } from '../../packages/plugin-media/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// 旧键 vision.mode 的一次性迁移：apply 时按旧语义写入新键、删除旧键并写回配置。
// 不迁移的话：config-sync 每次启动都物化默认值，存量部署里旧键永远有值、永远覆盖新键，
// WebUI 的 select 又清不掉它——新开关成死键。

async function applyWith(vision: Record<string, unknown>) {
  let saves = 0;
  const { app, store } = hostedApp({}, { provider: { save: () => void saves++ } });
  const host = app.bind({ provide });
  // media 的 process / storage 是 required：桩不在场时插件停在 pending，apply 根本不跑，
  // 「配置没被改写」会把未激活伪装成迁移正确。
  host.provide(processService, {} as never);
  host.provide(storage, {} as never);
  await app.plugin(media, { vision });
  await app.plugins.idle();
  const state = app.plugins.getPlugin(media.name)?.state;
  if (state !== 'active') throw new Error(`plugin-media 未激活（state=${state}），断言无效`);
  const stored = store.getPluginConfig<{ vision?: Record<string, unknown> }>('@aalis/plugin-media');
  await app.stop().catch(() => {});
  return { stored, saves };
}

describe('vision.mode 一次性迁移', () => {
  it('passthrough → recognizeOnArrival=false + delivery=passthrough，旧键删除并写回', async () => {
    const { stored, saves } = await applyWith({ mode: 'passthrough', maxTokens: 123 });
    expect(stored.vision).toMatchObject({ recognizeOnArrival: false, delivery: 'passthrough', maxTokens: 123 });
    expect(stored.vision).not.toHaveProperty('mode');
    expect(saves, '迁移后经 host-config 落盘一次').toBe(1);
  });

  it('disabled → 不识别 + 转文字', async () => {
    const { stored } = await applyWith({ mode: 'disabled' });
    expect(stored.vision).toMatchObject({ recognizeOnArrival: false, delivery: 'describe' });
    expect(stored.vision).not.toHaveProperty('mode');
  });

  it('没有旧键（或表单的「未设置」空串）→ 不写回、不动配置', async () => {
    expect(legacyVisionMode('')).toBeNull();
    const { stored, saves } = await applyWith({ mode: '', delivery: 'describe' });
    expect(Object.keys(stored)).toEqual([]); // 未调用 setPluginConfig，config 里没有本插件的段
    expect(saves).toBe(0);
  });
});
