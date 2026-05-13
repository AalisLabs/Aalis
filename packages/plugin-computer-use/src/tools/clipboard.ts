/**
 * 剪贴板工具
 */

import type { ScopedToolService } from '@aalis/plugin-tools-api';
import type { PlatformAdapter } from '../platform.js';

export function registerClipboardTools(tools: ScopedToolService, adapter: PlatformAdapter): void {
  // ── clipboard_read ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'clipboard_read',
        description: '读取系统剪贴板中的文本内容。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async () => {
      try {
        const text = await adapter.clipboardRead();
        return JSON.stringify({ text, length: text.length });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── clipboard_write ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'clipboard_write',
        description: '将文本内容写入系统剪贴板。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要写入剪贴板的文本' },
          },
          required: ['text'],
        },
      },
    },
    handler: async args => {
      try {
        await adapter.clipboardWrite(args.text as string);
        return JSON.stringify({ ok: true, length: (args.text as string).length });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}
