import { describe, expect, it } from 'vitest';
import type { MediaService } from '../../packages/api-media/src/index.js';
import {
  lookupDescriptionByUrl,
  rememberLandedAlias,
  stripRkey,
} from '../../packages/plugin-adapter-onebot/src/media-alias.js';
import {
  lookupCachedDescription,
  rememberDescription,
  rememberDescriptionAlias,
} from '../../packages/plugin-media/src/cache.js';

// ════════════════════════════════════════════════════════════
// QQ 媒体直链的 rkey 是访问密钥，定期轮换但不改变文件：引用消息经 get_msg 反查拿到的是换过
// rkey 的另一条串，别名按完整串相等就永远不命中，同一张图白重认。契约：登记时同时登记剥掉
// rkey 的键，查询时先原串、再剥 rkey 的键。用 plugin-media 真实的缓存/别名表验证端到端。
// 各用例用不同 fileid，互不依赖模块级缓存状态。
// ════════════════════════════════════════════════════════════

const media = {
  lookupDescription: (key: string) => lookupCachedDescription(key),
  rememberDescriptionAlias,
} as unknown as MediaService;

const qq = (fileid: string, rkey: string) =>
  `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fileid}&rkey=${rkey}&spec=0`;

describe('stripRkey', () => {
  it('只剥 rkey，其余参数与顺序不动；无 rkey / 非 URL 原样返回', () => {
    expect(stripRkey(qq('EhQabc', 'CAQSKAB1'))).toBe(
      'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhQabc&spec=0',
    );
    expect(stripRkey(qq('EhQabc', 'CAQSKAB1'))).toBe(stripRkey(qq('EhQabc', 'CAQSKAB2')));
    expect(stripRkey('https://example.invalid/a.jpg?x=1')).toBe('https://example.invalid/a.jpg?x=1');
    expect(stripRkey('data/images/s/0123456789abcdef.jpg')).toBe('data/images/s/0123456789abcdef.jpg');
  });
});

describe('落盘别名跨 rkey 轮换命中', () => {
  it('按 rkey=1 登记、识别写入落盘键，rkey=2 的引用消息查得到同一条描述；不同 fileid 不串', () => {
    const a = qq('EhQcat', 'CAQSKAB1');
    const landed = 'data/images/onebot_1_group_2/0123456789abcdef.jpg';
    rememberLandedAlias(media, 'image', a, landed);
    rememberDescription(a, '一只猫'); // 识别阶段按原始 URL 写入 → 经别名落到落盘键
    expect(lookupCachedDescription(landed)).toBe('一只猫');
    expect(lookupDescriptionByUrl(media, qq('EhQcat', 'CAQSKAB2')), 'rkey 轮换后仍应命中').toBe('一只猫');
    expect(lookupDescriptionByUrl(media, a)).toBe('一只猫');
    expect(
      lookupDescriptionByUrl(media, qq('EhQdog', 'CAQSKAB9')),
      '不同 fileid 不得因剥 rkey 串成同一张图',
    ).toBeNull();
  });

  it('先查原串：没登记过别名、只按原始 URL 写过描述的条目仍命中；换了 rkey 则不命中（无别名即无归一）', () => {
    const raw = 'https://example.invalid/pic/only-raw.jpg?rkey=k1';
    rememberDescription(raw, '原串条目');
    expect(lookupDescriptionByUrl(media, raw)).toBe('原串条目');
    expect(lookupDescriptionByUrl(media, 'https://example.invalid/pic/only-raw.jpg?rkey=k2')).toBeNull();
  });

  it('会话私有描述（shareable=false，带对话语境）不经 URL 路径复用——rkey 归一不改变这一边界', () => {
    const a = qq('EhQctx', 'CAQSKAB1');
    const landed = 'data/images/onebot_1_group_2/fedcba9876543210.jpg';
    rememberLandedAlias(media, 'image', a, landed);
    rememberDescription(a, '带语境的描述', false);
    expect(lookupDescriptionByUrl(media, a)).toBeNull();
    expect(lookupDescriptionByUrl(media, qq('EhQctx', 'CAQSKAB2'))).toBeNull();
  });

  it('音频与非 http 来源不登记（与登记面的既有约束一致）；无 rkey 的 URL 只登记一条', () => {
    const calls: string[] = [];
    const spy = { rememberDescriptionAlias: (s: string) => calls.push(s) } as unknown as MediaService;
    rememberLandedAlias(spy, 'audio', qq('EhQaud', 'CAQSKAB1'), 'data/audios/s/0123456789abcdef.amr');
    rememberLandedAlias(spy, 'image', 'data:image/png;base64,AAAA', 'data/images/s/0123456789abcdef.png');
    expect(calls).toEqual([]);
    rememberLandedAlias(spy, 'image', 'https://example.invalid/p.jpg', 'data/images/s/0123456789abcdef.jpg');
    expect(calls).toEqual(['https://example.invalid/p.jpg']);
    rememberLandedAlias(spy, 'image', qq('EhQtwo', 'CAQSKAB1'), 'data/images/s/0123456789abcdef.jpg');
    expect(calls.slice(1)).toEqual([qq('EhQtwo', 'CAQSKAB1'), stripRkey(qq('EhQtwo', 'CAQSKAB1'))]);
  });
});
