import { describe, expect, it } from 'vitest';
// onebot 的 KIND_DIR 是附件落盘目录的真相来源;/clear 的目录必须与之对齐,否则清错路径=静默 no-op。
import { KIND_DIR } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';
import { ATTACHMENT_KINDS, CLEAR_TYPES } from '../../packages/plugin-commands/src/index.js';

// ════════════════════════════════════════════════════════════
// /clear 附件类型回归:
//   附件按 data:/{images|videos|audios|files}/{safeSessionId} 落盘(onebot KIND_DIR)。
//   /clear 的 ATTACHMENT_KINDS 目录名必须与 KIND_DIR 逐一对齐,且四类都在 CLEAR_TYPES
//   里注册(否则 /clear -t video 报"未知类型")。历史上只清图片,视频/语音/文件是缺口。
// ════════════════════════════════════════════════════════════

describe('/clear 附件类型 ↔ onebot 落盘目录对齐', () => {
  it('四类附件(image/video/audio/file)都注册进 CLEAR_TYPES', () => {
    const ids = new Set<string>(CLEAR_TYPES.map(t => t.id));
    for (const kind of ['image', 'video', 'audio', 'file']) {
      expect(ids.has(kind), `CLEAR_TYPES 缺 ${kind} → /clear -t ${kind} 会报未知类型`).toBe(true);
    }
  });

  it('ATTACHMENT_KINDS 的 dir 逐一等于 onebot KIND_DIR(清对路径的前提)', () => {
    for (const k of ATTACHMENT_KINDS) {
      expect(k.dir, `${k.type} 的清理目录与 onebot 落盘目录不一致 → 会清错路径、静默清不掉`).toBe(
        KIND_DIR[k.type as keyof typeof KIND_DIR],
      );
    }
    // 反向:onebot 的每种附件都被 /clear 覆盖(无遗漏种类)
    expect(new Set(ATTACHMENT_KINDS.map(k => k.type))).toEqual(new Set(Object.keys(KIND_DIR)));
  });
});
