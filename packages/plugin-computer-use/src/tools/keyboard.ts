/**
 * 键盘控制工具（仅保留快捷键，文本输入已合并到 interact.ts 的 type_text）
 */

import type { ScopedToolService } from '@aalis/plugin-tools-api';
import type { PlatformAdapter } from '../platform.js';

export function registerKeyboardTools(tools: ScopedToolService, adapter: PlatformAdapter): void {
  // ── keyboard_press ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'keyboard_press',
        description:
          '按下一个或多个组合键。支持修饰键和功能键。' +
          '常用键名: ctrl, alt, shift, meta/cmd/command, enter, tab, space, backspace, delete, escape, ' +
          'up, down, left, right, home, end, pageup, pagedown, f1-f12。' +
          '示例: ["ctrl", "c"] 表示 Ctrl+C; ["enter"] 表示回车; ["alt", "tab"] 表示 Alt+Tab。' +
          '单个字母/数字键直接用字符表示: ["a"], ["1"]。',
        parameters: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'string' },
              description: '按键列表。多个键表示组合键（同时按下），单个键表示单独按下。',
            },
          },
          required: ['keys'],
        },
      },
    },
    handler: async args => {
      try {
        const keys = args.keys as string[];
        if (!Array.isArray(keys) || keys.length === 0) {
          return JSON.stringify({ error: '请提供至少一个按键' });
        }
        await adapter.keyboardPress(keys);
        return JSON.stringify({ ok: true, keys });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}
