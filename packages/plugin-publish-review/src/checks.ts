import { type NominateInput, PUBLIC_CONTENT_TYPES, publicPathProblem, type WorkKind } from '@aalis/api-publish';
import type { TextRef } from '@aalis/schema-i18n';
import { decodeUtf8Text, detectMediaFormat, FILE_HEAD_BYTES, isAnimatedImage } from '@aalis/util-file-signature';
import type { ReviewConfig } from './config.js';

const MIB = 1024 * 1024;
const SURFACE_RETRY_MS = 30_000;
const media = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4']);
const text = new Set(['html', 'css', 'js', 'mjs', 'json', 'svg']);
const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.slice(start, start + length));
const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

/** 内容与扩展名相符：网站按扩展名给 Content-Type，媒体的判定格式要正是那一种 */
function signature(ext: string, bytes: Uint8Array): boolean {
  if (media.has(ext)) return detectMediaFormat(bytes.subarray(0, FILE_HEAD_BYTES))?.mime === PUBLIC_CONTENT_TYPES[ext];
  if (ext === 'woff2') return ascii(bytes, 0, 4) === 'wOF2';
  if (!text.has(ext)) return true;
  const decoded = decodeUtf8Text(bytes);
  if (decoded === null) return false;
  if (ext === 'html') return /^(?:<!doctype html\b|<html\b)/i.test(decoded.trimStart());
  if (ext === 'svg') return /<svg\b/i.test(decoded);
  return true;
}

function fileProblem(path: string, bytes: Uint8Array): string | undefined {
  const ext = extension(path);
  if (!signature(ext, bytes)) return '文件内容与扩展名不符';
  if (ext === 'png' && isAnimatedImage(bytes)) return '动态 PNG 暂不接收';
  if (ext === 'webp' && isAnimatedImage(bytes)) return '动态 WebP 暂不接收';
  return undefined;
}

export function checkNomination(
  input: NominateInput,
  cfg: ReviewConfig,
  surfaces: ReadonlySet<string>,
):
  | { ok: true; kind: WorkKind; title: string; summary: string }
  | { refused: string | TextRef; fileIndex?: number; retryAfterMs?: number } {
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  const title = clean(input.title);
  const summary = clean(input.summary);
  if (!title || title.length > 40 || summary.length > 300) return { refused: '标题或简介不合规' };
  if (!input.surfaces.length) return { refused: '展示面未登记' };
  // 展示面可能正在重载或重新挂上；名字暂缺按临时拒绝，由提名方稍后重试。
  if (input.surfaces.some(name => !surfaces.has(name)))
    return { refused: '展示面暂未登记', retryAfterMs: SURFACE_RETRY_MS };
  if (!input.files.length || input.files.length > cfg.limits.maxWorkFiles) return { refused: '文件数量超限' };
  const paths = new Set<string>();
  let bytesTotal = 0;
  for (const [i, file] of input.files.entries()) {
    const pathProblem = publicPathProblem(file.path);
    if (pathProblem) return { refused: pathProblem, fileIndex: i };
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) return { refused: '文件路径重复', fileIndex: i };
    paths.add(folded);
    if (
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.length === 0 ||
      file.bytes.length > cfg.limits.maxFileMB * MIB
    )
      return { refused: '文件大小不合规', fileIndex: i };
    bytesTotal += file.bytes.length;
    if (bytesTotal > cfg.limits.maxWorkMB * MIB) return { refused: '作品总大小超限', fileIndex: i };
    const problem = fileProblem(file.path, file.bytes);
    if (problem) return { refused: problem, fileIndex: i };
  }
  if (input.cover) {
    const bytes = input.cover;
    if (
      bytes.length === 0 ||
      bytes.length > cfg.limits.maxFileMB * MIB ||
      !['png', 'jpg', 'jpeg', 'gif', 'webp'].some(ext => signature(ext, bytes) && !fileProblem(`cover.${ext}`, bytes))
    )
      return { refused: '封面不是可接收的静态位图', fileIndex: -1 };
  }
  const only = input.files.length === 1 ? extension(input.files[0].path) : undefined;
  if (only && media.has(only)) return { ok: true, kind: 'media', title, summary };
  if (only === 'svg') return { refused: 'SVG 请放进网页作品里' };
  if (!paths.has('index.html')) return { refused: '网页作品缺少 index.html' };
  if (input.files.some(file => extension(file.path) === 'html' && file.path !== 'index.html'))
    return { refused: '网页文件只能是 index.html' };
  return { ok: true, kind: 'html', title, summary };
}

export function contentType(path: string): string {
  return PUBLIC_CONTENT_TYPES[extension(path)];
}

/** 保守提示，不替代内容分类；返回固定标签，不能把文件中的指令写进宿主通知。 */
export function markContent(title: string, sources: readonly string[]): { flags: string[]; reasons: string[] } {
  const raw = sources
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\bxmlns(?::[\w-]+)?\s*=\s*(["']).*?\1/gi, '');
  const decoded = raw
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_all, number: string) => {
      const code = number[0].toLowerCase() === 'x' ? Number.parseInt(number.slice(1), 16) : Number.parseInt(number, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '')
    .toLowerCase();
  const compact = decoded.replace(/[\t\r\n]/g, '');
  const flags: string[] = [];
  const reasons: string[] = [];
  if (
    /<script\b|\bon[a-z]+\s*=|javascript\s*:|\bsrcdoc\b|data\s*:\s*text\/html|<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(
      compact,
    )
  )
    flags.push('活动内容');
  if (/(?:https?:|[/\\]{2})[/\\]*[a-z0-9]/i.test(compact)) flags.push('外链');
  if (/<form\b/i.test(compact)) flags.push('表单');
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(compact)) {
    flags.push('密码框');
    reasons.push('包含密码框');
  }
  if (/\d{7,}/.test(title)) {
    flags.push('疑似个人信息');
    reasons.push('疑似个人信息');
  }
  if (
    /-----begin\s+(?:rsa\s+|ec\s+|openssh\s+)?private key|\bsk-[a-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[a-z0-9_/-]{16,}/i.test(
      decoded,
    )
  ) {
    flags.push('疑似密钥');
    reasons.push('疑似密钥');
  }
  return { flags, reasons };
}
