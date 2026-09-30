import { describe, expect, it } from 'vitest';
import type { NominateInput } from '../../packages/api-publish/src/index.js';
import { checkNomination, markContent } from '../../packages/plugin-publish-review/src/checks.js';
import type { ReviewConfig } from '../../packages/plugin-publish-review/src/config.js';

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const jpeg = new Uint8Array([255, 216, 255]);
const html = new TextEncoder().encode('<!doctype html><html></html>');
const config: ReviewConfig = {
  reviewEnabled: true,
  manualReview: false,
  ownerTimeoutHours: 12,
  ffmpegPath: 'ffmpeg',
  chrome: { headless: true, executablePath: '' },
  limits: {
    maxFileMB: 25,
    maxWorkFiles: 50,
    maxWorkMB: 50,
    maxPending: 20,
    maxPendingPerOrigin: 3,
    maxDailyPerOrigin: 10,
  },
};
const surfaces = new Set(['works']);
const input = (files: Array<{ path: string; bytes: Uint8Array }>): NominateInput => ({
  origin: { producer: 'paper', ref: 't-1', label: '房间' },
  group: 'g',
  groupLabel: 'g',
  surfaces: ['works'],
  title: '作品',
  summary: '',
  files,
});
const check = (files: Array<{ path: string; bytes: Uint8Array }>) => checkNomination(input(files), config, surfaces);

describe('发布提名同步检查', () => {
  it('路径与大小写重复被拒，理由不回显文件名', () => {
    const path = check([{ path: '../secret.png', bytes: png }]);
    expect(path).toMatchObject({ refused: expect.any(String), fileIndex: 0 });
    expect(JSON.stringify(path)).not.toContain('secret.png');
    expect(
      check([
        { path: 'index.html', bytes: html },
        { path: 'a.PNG', bytes: png },
        { path: 'a.png', bytes: png },
      ]),
    ).toMatchObject({ refused: expect.stringContaining('重复'), fileIndex: 2 });
  });

  it('用媒体签名分清扩展名，拒绝假 PNG、MOV 与 AVIF', () => {
    expect(check([{ path: 'work.png', bytes: jpeg }])).toMatchObject({ refused: expect.any(String), fileIndex: 0 });
    const mov = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 113, 116, 32, 32]);
    expect(check([{ path: 'work.mp4', bytes: mov }])).toMatchObject({ refused: expect.any(String), fileIndex: 0 });
    const avif = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 97, 118, 105, 102]);
    expect(check([{ path: 'work.mp4', bytes: avif }])).toMatchObject({ refused: expect.any(String), fileIndex: 0 });
  });

  it('HTML 须为文档起始，字体须有 wOF2；单 SVG 不作媒体作品', () => {
    expect(check([{ path: 'index.html', bytes: new TextEncoder().encode('hello') }])).toHaveProperty('refused');
    expect(
      check([
        { path: 'index.html', bytes: html },
        { path: 'font.woff2', bytes: png },
      ]),
    ).toMatchObject({ fileIndex: 1 });
    expect(check([{ path: 'work.svg', bytes: new TextEncoder().encode('<svg></svg>') }])).toHaveProperty('refused');
  });

  it('APNG 与动态 WebP 的两种标记都被拒，GIF 封面可用', () => {
    const apng = new Uint8Array([...png, 0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0]);
    expect(check([{ path: 'work.png', bytes: apng }])).toMatchObject({ refused: expect.stringContaining('动态 PNG') });
    const webp = new Uint8Array([82, 73, 70, 70, 20, 0, 0, 0, 87, 69, 66, 80, 65, 78, 73, 77, 0, 0, 0, 0]);
    expect(check([{ path: 'work.webp', bytes: webp }])).toMatchObject({
      refused: expect.stringContaining('动态 WebP'),
    });
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97]);
    expect(
      checkNomination({ ...input([{ path: 'work.png', bytes: png }]), cover: gif }, config, surfaces),
    ).toHaveProperty('ok', true);
  });

  it('标题简介去控制/格式字符再判长度', () => {
    const cleaned = checkNomination(
      { ...input([{ path: 'work.png', bytes: png }]), title: 'A\u202eB', summary: 'X\u0001Y' },
      config,
      surfaces,
    );
    expect(cleaned).toMatchObject({ ok: true, title: 'AB', summary: 'XY' });
    expect(
      checkNomination({ ...input([{ path: 'work.png', bytes: png }]), title: 'x'.repeat(41) }, config, surfaces),
    ).toHaveProperty('refused');
  });
});

// 标记给人工详情与流水规则使用，不把脚本/外链本身当作禁止发布。
describe('静态审核标记', () => {
  it.each([
    '<script>x</script>',
    '<SCRIPT>x</SCRIPT>',
    '<svg/onload=run()>',
    '<div onLoad=run()>',
    '<a href="jav&#x61;script:run()">',
    '<a href="jav&#9;ascript:run()">',
    '<iframe srcdoc="x">',
    '<img src="data:text/html,x">',
    '<meta http-equiv=refresh>',
  ])('活动内容 %s', source => {
    expect(markContent('', [source]).flags).toContain('活动内容');
  });
  it('外链与注释/xmlns区分，静态内联样式没有活动标记', () => {
    for (const source of ['HTTPS://example.test/x', '//example.test/x', '\\\\example.test/x'])
      expect(markContent('', [source]).flags).toContain('外链');
    expect(
      markContent('', ['<!-- https://example.test --><svg xmlns="http://www.w3.org/2000/svg"></svg>']).flags,
    ).toEqual([]);
    expect(
      markContent('', ['<!doctype html><html><style>body{color:red}</style><body>hello</body></html>']).flags,
    ).toEqual([]);
  });
  it('密码、个人信息、疑似密钥转成固定原因，不回显内容', () => {
    const found = markContent('电话 12345678901', [
      '<form><input type=password></form> API_KEY="abcdefghijklmnop123456"',
    ]);
    expect(found.flags).toEqual(expect.arrayContaining(['表单', '密码框', '疑似个人信息', '疑似密钥']));
    expect(found.reasons).toHaveLength(3);
    expect(JSON.stringify(found)).not.toContain('abcdefghijklmnop');
  });
});
