import { describe, expect, it } from 'vitest';
import {
  AttachmentRefKind,
  buildAttachmentRefMatcher,
  formatAttachmentRef,
  parseAttachmentRefs,
} from '../../packages/schema-message/src/attachment-ref.js';

describe('attachment-ref helpers', () => {
  describe('formatAttachmentRef', () => {
    it('包含描述时输出 [kind: desc | ref:xxx]', () => {
      expect(formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: '一只猫', ref: 'data/x.png' })).toBe(
        '[图片: 一只猫 | ref:data/x.png]',
      );
    });

    it('无描述时输出 [kind | ref:xxx]（保持历史 byte-for-byte 兼容）', () => {
      expect(formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: 'data/x.png' })).toBe('[图片 | ref:data/x.png]');
    });

    it('描述为空字符串视同未提供', () => {
      expect(formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: '   ', ref: 'p' })).toBe('[图片 | ref:p]');
    });

    it('支持四种 kind', () => {
      expect(formatAttachmentRef({ kind: AttachmentRefKind.Audio, ref: 'a.mp3' })).toBe('[音频 | ref:a.mp3]');
      expect(formatAttachmentRef({ kind: AttachmentRefKind.Video, ref: 'v.mp4' })).toBe('[视频 | ref:v.mp4]');
      expect(formatAttachmentRef({ kind: AttachmentRefKind.File, desc: '报表', ref: 'r.xlsx' })).toBe(
        '[文件: 报表 | ref:r.xlsx]',
      );
    });
  });

  describe('parseAttachmentRefs', () => {
    it('解析单个带描述的占位', () => {
      const refs = parseAttachmentRefs('用户发了 [图片: 一只猫 | ref:data/x.png] 然后……');
      expect(refs).toEqual([{ kind: '图片', desc: '一只猫', ref: 'data/x.png' }]);
    });

    it('解析无描述的占位', () => {
      expect(parseAttachmentRefs('[图片 | ref:p1] [图片 | ref:p2]')).toEqual([
        { kind: '图片', ref: 'p1' },
        { kind: '图片', ref: 'p2' },
      ]);
    });

    it('混合 kind 与混合是否带描述', () => {
      const text = '前缀 [音频: 你好 | ref:a.mp3] 中段 [视频 | ref:v.mp4] [文件: 报告 | ref:r.xlsx]';
      expect(parseAttachmentRefs(text)).toEqual([
        { kind: '音频', desc: '你好', ref: 'a.mp3' },
        { kind: '视频', ref: 'v.mp4' },
        { kind: '文件', desc: '报告', ref: 'r.xlsx' },
      ]);
    });

    it('忽略不含 ref: 的弱占位 [图片]', () => {
      expect(parseAttachmentRefs('开头 [图片] 中段 [图片: 描述] 末尾')).toEqual([]);
    });

    it('format → parse round-trip', () => {
      const inputs = [
        { kind: AttachmentRefKind.Image, desc: '日落', ref: 'data/sunset.jpg' },
        { kind: AttachmentRefKind.Audio, ref: 'voice/a.mp3' },
      ] as const;
      const text = inputs.map(formatAttachmentRef).join('\n');
      expect(parseAttachmentRefs(text)).toEqual([
        { kind: '图片', desc: '日落', ref: 'data/sunset.jpg' },
        { kind: '音频', ref: 'voice/a.mp3' },
      ]);
    });
  });

  describe('buildAttachmentRefMatcher', () => {
    it('匹配同一 ref 的所有变体（带/不带描述）', () => {
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/x.png');
      const text = '[图片 | ref:data/x.png] 文 [图片: desc | ref:data/x.png]';
      const matches = text.match(re);
      expect(matches).toEqual(['[图片 | ref:data/x.png]', '[图片: desc | ref:data/x.png]']);
    });

    it('不匹配其它 ref', () => {
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/x.png');
      expect('[图片 | ref:data/y.png]'.match(re)).toBeNull();
    });

    it('正则元字符在 ref 中被转义', () => {
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/foo+bar.png');
      expect('[图片 | ref:data/foo+bar.png]'.match(re)?.length).toBe(1);
      expect('[图片 | ref:data/fooXbar.png]'.match(re)).toBeNull();
    });
  });

  describe('desc 净化（视觉模型输出带表格/多行时仍可解析）', () => {
    const dirty = '这是一张表格：\n| 列A | 列B |\n| 1 | 2 ]';

    it('format 把换行折成空格、| 与 ] 换成全角', () => {
      const line = formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: dirty, ref: 'data/t.png' });
      expect(line).toBe('[图片: 这是一张表格： 丨 列A 丨 列B 丨 丨 1 丨 2 ］ | ref:data/t.png]');
      expect(line.includes('\n')).toBe(false);
    });

    it('净化后 parseAttachmentRefs 仍认得（不净化则整条引用在历史里永远匹配不到）', () => {
      const line = formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: dirty, ref: 'data/t.png' });
      const refs = parseAttachmentRefs(`用户发了 ${line} 然后……`);
      expect(refs.length).toBe(1);
      expect(refs[0].ref).toBe('data/t.png');
      expect(refs[0].desc).toContain('列A');
    });

    it('净化后 matcher 命中且只吃掉整条占位（update_image_description 能改写）', () => {
      const line = formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: dirty, ref: 'data/t.png' });
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/t.png');
      expect(line.replace(re, '<改写>')).toBe('<改写>');
    });

    it('存量 desc 含裸 | 时 matcher 仍能改写（parse 不认，两读侧刻意不一致）', () => {
      const legacy = '[图片: a | b | ref:data/t.png]';
      // parse 只发现净化过的新格式
      expect(parseAttachmentRefs(legacy)).toEqual([]);
      // matcher 额外兼容存量：收严则这条占位符 update_image_description 再也改不动
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/t.png');
      expect(legacy.replace(re, '<改写>')).toBe('<改写>');
    });

    it('宽松的 desc 字符类仍不跨 ]：不会吞掉相邻占位符', () => {
      const text = '[图片 | ref:data/a.png][图片: x | ref:data/t.png]';
      const re = buildAttachmentRefMatcher(AttachmentRefKind.Image, 'data/t.png');
      expect(text.match(re)).toEqual(['[图片: x | ref:data/t.png]']);
    });
  });
});
