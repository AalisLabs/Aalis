import { describe, expect, it } from 'vitest';
import { CLEAR_TYPES } from '../../packages/plugin-commands/src/index.js';

// ════════════════════════════════════════════════════════════
// /clear 附件类型回归：附件由写入它的插件各自清（见 session-media），四类都要在 CLEAR_TYPES 里注册，
// 否则 /clear -t video 报「未知类型」。历史上只清图片，视频/语音/文件是缺口。
// ════════════════════════════════════════════════════════════

describe('/clear 附件类型', () => {
  it('四类附件(image/video/audio/file)都注册进 CLEAR_TYPES', () => {
    const ids = new Set<string>(CLEAR_TYPES.map(t => t.id));
    for (const kind of ['image', 'video', 'audio', 'file']) {
      expect(ids.has(kind), `CLEAR_TYPES 缺 ${kind} → /clear -t ${kind} 会报未知类型`).toBe(true);
    }
  });
});
