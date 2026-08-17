import { describe, expect, it } from 'vitest';
import {
  allowRequest,
  buildShell,
  classifySource,
  type DrawCaps,
  parseSvgCanvas,
  resolveCanvas,
} from '../../packages/plugin-draw/src/plan.js';

// ════════════════════════════════════════════════════════════
// 绘图渲染计划（纯函数层）——源分类 / 画布定界 / 请求放行。
// 画布定界是实测坑的解：内联 SVG 不定死宽高会随视口伸缩；
// allowRequest 是安全闸的判定芯（default-deny，引擎层用它拦一切外联）。
// ════════════════════════════════════════════════════════════

const caps: DrawCaps = { defaultWidth: 800, maxWidth: 1600, maxPixels: 4_000_000, maxSourceBytes: 262144, scale: 2 };

describe('classifySource', () => {
  it('SVG 文档（含 XML 序言/注释/DOCTYPE 前导）→ svg', () => {
    expect(classifySource('<svg viewBox="0 0 1 1"></svg>')).toBe('svg');
    expect(classifySource('  <?xml version="1.0"?>\n<!-- c -->\n<svg></svg>')).toBe('svg');
    expect(classifySource('<!DOCTYPE svg PUBLIC "x"><svg/>')).toBe('svg');
  });

  it('HTML 片段（含内嵌 SVG 的混合写法）→ html', () => {
    expect(classifySource('<div>卡片<svg viewBox="0 0 1 1"/></div>')).toBe('html');
    expect(classifySource('<p>hello</p>')).toBe('html');
    expect(classifySource('随便一段文字')).toBe('html');
  });
});

describe('parseSvgCanvas / resolveCanvas', () => {
  it('width/height 属性直取；请求宽按比例覆盖', () => {
    const svg = '<svg width="400" height="300" viewBox="0 0 400 300"></svg>';
    expect(parseSvgCanvas(svg)).toMatchObject({ width: 400, height: 300 });
    const plan = resolveCanvas(svg, undefined, caps);
    expect([plan.width, plan.height]).toEqual([400, 300]);
    const wide = resolveCanvas(svg, 800, caps);
    expect([wide.width, wide.height]).toEqual([800, 600]);
  });

  it('仅 viewBox：默认宽配纵横比；相对单位宽度被忽略走 viewBox', () => {
    const plan = resolveCanvas('<svg viewBox="0 0 100 50"></svg>', undefined, caps);
    expect([plan.width, plan.height]).toEqual([800, 400]);
    const rel = resolveCanvas('<svg width="50%" viewBox="0 0 100 100"></svg>', undefined, caps);
    expect([rel.width, rel.height]).toEqual([800, 800]);
  });

  it('总像素超限等比缩小；宽度 clamp 到 maxWidth', () => {
    const plan = resolveCanvas('<svg width="4000" height="4000"></svg>', undefined, caps);
    expect(plan.width * (plan.height as number)).toBeLessThanOrEqual(caps.maxPixels);
    expect(plan.width).toBeLessThanOrEqual(caps.maxWidth);
  });

  it('HTML：宽取参数或默认，高待实测（auto）', () => {
    const plan = resolveCanvas('<div>x</div>', 500, caps);
    expect(plan).toMatchObject({ mode: 'html', width: 500, height: 'auto' });
  });

  it('SVG 外壳把根 SVG 定死为画布尺寸（防随视口伸缩）', () => {
    const plan = resolveCanvas('<svg viewBox="0 0 10 10"><rect/></svg>', 200, caps);
    expect(plan.html).toContain('width:200px;height:200px');
    expect(plan.html).toContain('<svg viewBox="0 0 10 10">');
    expect(buildShell('<p>x</p>', 'html', 640, 'auto')).toContain('width:640px');
  });
});

describe('allowRequest（default-deny）', () => {
  it('只放 about:blank 与 data:', () => {
    expect(allowRequest('about:blank')).toBe(true);
    expect(allowRequest('data:image/png;base64,AAAA')).toBe(true);
    for (const bad of [
      'http://169.254.169.254/latest/meta-data/',
      'https://example.com/a.png',
      'file:///etc/passwd',
      'blob:null/x',
      'chrome://settings',
    ]) {
      expect(allowRequest(bad), bad).toBe(false);
    }
  });
});
