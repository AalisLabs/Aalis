// ============================================================
// attachment-ref.ts — 跨插件统一的「附件引用」字符串契约
//
// Aalis 在多个地方需要把附件（图片 / 音频 / 视频 / 文件）以可读、可解析的
// 形式塞回 LLM 上下文里。历史上有四个调用点各自硬编码 `[图片: desc | ref:xxx]`
// 这种格式：
//   - plugin-adapter-onebot 入站构造图片占位
//   - plugin-image-sender 出站归档自己刚发的图
//   - plugin-media tools.ts regex 重写历史描述
//   - plugin-image-recognition 解析历史图片引用
// 任何一处格式漂移都会让其它三处的解析悄悄断链。
//
// 本模块提供单一格式来源 + 类型安全的 kind 枚举：
//   formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: '一只猫', ref: 'data/x.png' })
//     === '[图片: 一只猫 | ref:data/x.png]'
//   formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: 'data/x.png' })
//     === '[图片 | ref:data/x.png]'
//   parseAttachmentRefs(text)
//     === [{ kind: '图片', desc?: string, ref: string }, ...]
//
// 设计约束：
//   - 输出必须 byte-for-byte 兼容历史格式（数据库里已有的字符串不重写）。
//   - parser 不消耗 desc 中的转义；上游写入时确保 desc 不含 `]` / `|`。
// ============================================================

/** 附件 kind 显示名（中文，用作占位符前缀）。新增 kind 在此处加常量即可。 */
export const AttachmentRefKind = {
  Image: '图片',
  Audio: '音频',
  Video: '视频',
  File: '文件',
} as const;

export type AttachmentRefKind = (typeof AttachmentRefKind)[keyof typeof AttachmentRefKind];

/** 所有 kind 显示名的联合，供正则构造时迭代。 */
const ALL_KINDS: readonly AttachmentRefKind[] = Object.values(AttachmentRefKind);

export interface AttachmentRef {
  kind: AttachmentRefKind;
  /** 可选语义描述（视觉概要 / 文件备注 / 音频转写片段等） */
  desc?: string;
  /** 引用：本地路径 / file:// / http(s) URL；调用方决定如何解析 */
  ref: string;
}

/**
 * 把 ref 描述对象格式化为统一占位符字符串。
 *
 *   { kind: '图片', desc: 'x', ref: 'p' }  →  '[图片: x | ref:p]'
 *   { kind: '图片',          ref: 'p' }    →  '[图片 | ref:p]'
 *
 * desc 为空字符串视同未提供（与历史行为一致）。
 */
export function formatAttachmentRef(r: AttachmentRef): string {
  const desc = r.desc?.trim();
  if (desc) return `[${r.kind}: ${desc} | ref:${r.ref}]`;
  return `[${r.kind} | ref:${r.ref}]`;
}

// 内部：把所有 kind 拼成 alternation `图片|音频|视频|文件`
function kindAlternation(): string {
  return ALL_KINDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * 在文本中扫描所有形如 `[<kind>(: <desc>)? | ref:<ref>]` 的占位符。
 * `<ref>` 内不允许出现 `]`（这是契约：写入时由 formatAttachmentRef 保证）。
 */
export function parseAttachmentRefs(text: string): AttachmentRef[] {
  const re = new RegExp(`\\[(${kindAlternation()})(?:: ([^\\]\\n|]+?))? \\| ref:([^\\]\\n]+?)\\]`, 'g');
  const out: AttachmentRef[] = [];
  for (const m of text.matchAll(re)) {
    const kind = m[1] as AttachmentRefKind;
    const desc = m[2]?.trim();
    const ref = m[3].trim();
    out.push(desc ? { kind, desc, ref } : { kind, ref });
  }
  return out;
}

/**
 * 构造一个用于在文本中匹配「指定 kind + 指定 ref」的全部已存在占位符的正则。
 * 主要给 plugin-media 的 update_image_description 工具用，让它不必重新硬编码格式。
 */
export function buildAttachmentRefMatcher(kind: AttachmentRefKind, ref: string): RegExp {
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[${escapedKind}(?:: [^\\]\\n]*?)? \\| ref:${escapedRef}\\]`, 'g');
}
