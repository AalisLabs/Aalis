// ============================================================
// plan.ts — 渲染计划（纯函数层：源分类 / 画布定界 / 外壳文档 / 请求放行判定）
//
// 引擎是无头浏览器，SVG 与 HTML 对它是同一件事——真正需要区分的只有
// 「画布怎么定界」：SVG 有 viewBox/width 的精确尺寸语义，直接算；
// HTML 交给排版引擎流式布局，宽度取参数、高度渲染后实测。
// 本文件零 IO 零浏览器依赖，全部可单测。
// ============================================================

export interface DrawCaps {
  /** HTML 模式与无宽度 SVG 的默认画布宽（px） */
  defaultWidth: number;
  /** 画布宽上限（px） */
  maxWidth: number;
  /** 画布总像素上限（width × height，防巨图拖垮渲染与投递） */
  maxPixels: number;
  /** 输入标记大小上限（字节） */
  maxSourceBytes: number;
  /** 截图缩放（deviceScaleFactor） */
  scale: number;
}

export type SourceMode = 'svg' | 'html';

export interface CanvasPlan {
  mode: SourceMode;
  /** 画布宽（CSS px，已 clamp） */
  width: number;
  /** 画布高：SVG 按尺寸语义先验可知；HTML 需渲染后实测 */
  height: number | 'auto';
  /** 交给浏览器 setContent 的完整文档 */
  html: string;
}

const clampInt = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(v)));

/**
 * 源分类：剥掉 BOM/空白/XML 序言/DOCTYPE/前导注释后，根元素是 <svg> 即 SVG 文档，
 * 否则一律按 HTML 片段处理（含"HTML 里嵌 SVG"的混合写法）。
 */
export function classifySource(source: string): SourceMode {
  let s = source.replace(/^﻿/, '');
  for (;;) {
    const t = s.trimStart();
    if (t.startsWith('<!--')) {
      const end = t.indexOf('-->');
      if (end < 0) break;
      s = t.slice(end + 3);
      continue;
    }
    if (/^<\?xml/i.test(t)) {
      const end = t.indexOf('?>');
      if (end < 0) break;
      s = t.slice(end + 2);
      continue;
    }
    if (/^<!doctype/i.test(t)) {
      const end = t.indexOf('>');
      if (end < 0) break;
      s = t.slice(end + 1);
      continue;
    }
    return /^<svg[\s/>]/i.test(t) ? 'svg' : 'html';
  }
  return 'html';
}

/** 从 SVG 根元素上解析尺寸语义（width/height 属性优先，viewBox 兜底）。 */
export function parseSvgCanvas(svg: string): { width?: number; height?: number; aspect?: number } {
  const root = svg.match(/<svg[^>]*>/i)?.[0] ?? '';
  const num = (attr: string): number | undefined => {
    // 只认纯数字与 px（em/%/pt 等相对单位对画布定界无意义，忽略走 viewBox）
    const m = root.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i'));
    const v = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const width = num('width');
  const height = num('height');
  const vb = root.match(/\bviewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
  const vbW = vb ? Number(vb[3]) : Number.NaN;
  const vbH = vb ? Number(vb[4]) : Number.NaN;
  const aspect = Number.isFinite(vbW) && Number.isFinite(vbH) && vbW > 0 && vbH > 0 ? vbH / vbW : undefined;
  return { width, height, aspect };
}

/**
 * 画布定界：
 * - SVG：width/height 属性直取；只有 viewBox 时按纵横比配默认宽；都没有则默认宽配 3:2。
 *   （内联 SVG 不定界会随视口伸缩——实测坑，必须显式定死。）
 * - HTML：宽 = 请求宽或默认宽，高渲染后实测。
 * 全部经 maxWidth 与 maxPixels 收口。
 */
export function resolveCanvas(source: string, requestedWidth: number | undefined, caps: DrawCaps): CanvasPlan {
  const mode = classifySource(source);
  const reqW = requestedWidth && requestedWidth > 0 ? requestedWidth : undefined;

  let width: number;
  let height: number | 'auto';
  if (mode === 'svg') {
    const c = parseSvgCanvas(source);
    if (c.width && c.height) {
      width = clampInt(reqW ?? c.width, 16, caps.maxWidth);
      height = Math.max(16, Math.round(width * (c.height / c.width)));
    } else {
      const aspect = c.aspect ?? 2 / 3;
      width = clampInt(reqW ?? caps.defaultWidth, 16, caps.maxWidth);
      height = Math.max(16, Math.round(width * aspect));
    }
    // 总像素收口：等比缩小
    if (width * height > caps.maxPixels) {
      const k = Math.sqrt(caps.maxPixels / (width * height));
      width = Math.max(16, Math.floor(width * k));
      height = Math.max(16, Math.floor(height * k));
    }
  } else {
    width = clampInt(reqW ?? caps.defaultWidth, 16, caps.maxWidth);
    height = 'auto';
  }

  return { mode, width, height, html: buildShell(source, mode, width, height) };
}

/**
 * 外壳文档：body 归零边距；SVG 模式用定宽定高容器把根 SVG 撑满（杜绝随视口伸缩）；
 * HTML 模式定宽、高度自流。字体栈兜底中文与 emoji（部署机 macOS；模型可在标记内自定覆盖）。
 */
export function buildShell(source: string, mode: SourceMode, width: number, height: number | 'auto'): string {
  const base =
    'html,body{margin:0;padding:0}' +
    'body{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Apple Color Emoji",sans-serif}';
  if (mode === 'svg') {
    return (
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${base}` +
      `#aalis-draw{width:${width}px;height:${height}px;overflow:hidden}` +
      `#aalis-draw>svg{display:block;width:100%;height:100%}</style></head>` +
      `<body><div id="aalis-draw">${source}</div></body></html>`
    );
  }
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${base}` +
    `#aalis-draw{width:${width}px}</style></head>` +
    `<body><div id="aalis-draw">${source}</div></body></html>`
  );
}

/**
 * 请求放行判定（default-deny）：渲染页只允许内联资源。
 * LLM 生成的标记是不可信输入——实测 <script> 会执行、外链会真发请求（SSRF/外泄口），
 * 引擎层禁 JS + 本判定拦一切网络面：只放 about:blank（setContent 的初始导航）与 data:。
 */
export function allowRequest(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:');
}
