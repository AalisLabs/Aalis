import { describe, expect, it } from 'vitest';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import { validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// 静态选项不全的字段声明了 allowCustom：选项外的合法取值不能被校验判成「不是可选值」。
// 去掉这两个字段上的 allowCustom，配置同步启动时会误报，WebUI 会拦，插件解析时会丢掉或回落。
// ════════════════════════════════════════════════════════════

describe('静态选项不全的字段', () => {
  it('checkpoint 的 scopes：任意 platform:sessionType 都合法', () => {
    expect(validateConfig(checkpointPlugin.configSchema, { scopes: ['onebot:*', 'discord:group'] })).toEqual([]);
  });

  it('media 的 audio.prefer：后端名在激活后才补进选项', () => {
    expect(validateConfig(mediaPlugin.configSchema, { audio: { prefer: 'whisper-local' } })).toEqual([]);
  });
});
