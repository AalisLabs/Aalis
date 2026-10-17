import { describe, expect, it } from 'vitest';
import { MEMORY_RECALL_SCOPE_SETTING } from '../../packages/api-memory/src/index.js';
import { localize, resolveText } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 几个记忆插件共用的会话设置项「记忆召回范围」：给人看的文字取自 api-memory 的库字典，读者按自己的语言读到。
// ════════════════════════════════════════════════════════════

describe('记忆召回范围的文字', () => {
  it('标签、说明、选项名与没设时的说明：en 读者读到英文，原文是中文', () => {
    const english = localize(MEMORY_RECALL_SCOPE_SETTING, text => resolveText(text, ['en']));
    expect(english).toMatchObject({
      field: {
        label: 'Memory recall scope',
        description:
          "Where cross-session memory and history are drawn from; it can only be narrower than each memory plugin's own configuration, and a wider value falls back to the plugin configuration",
        options: [
          { label: 'This session only', value: 'session' },
          { label: 'Same platform', value: 'platform' },
          { label: 'All', value: 'all' },
        ],
      },
      unset: 'As each memory plugin is configured',
    });
    expect(localize(MEMORY_RECALL_SCOPE_SETTING, text => text.source)).toMatchObject({
      field: { label: '记忆召回范围' },
      unset: '按各记忆插件的配置',
    });
  });
});
