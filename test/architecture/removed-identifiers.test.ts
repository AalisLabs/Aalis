import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 已删除的机制不留痕迹：下表的标识在仓库的代码、测试与文档里一处都不能再出现（CHANGELOG 记的是历史，不查）。
// 删掉一套机制时把它的标识加进来；某个标识日后被正当地重新用上，先改这里的说明再删行。
// ════════════════════════════════════════════════════════════

const ROOT = join(__dirname, '../..');
const SCAN_DIRS = ['packages', 'docs', 'test', 'src', 'tools'];
const SCAN_FILES = ['README.md', 'CONTRIBUTING.md', 'package.json', 'knip.json', 'biome.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist']);
/** 文档站的构建缓存 */
const SKIP_PATHS = new Set([join(ROOT, 'docs/.vitepress/cache')]);
const TEXT = /\.(ts|tsx|mts|js|mjs|md|json|ya?ml|vue|css)$/;
const SELF = relative(ROOT, __filename);

/** [标识, 删掉的是什么] */
const REMOVED: Array<[string, string]> = [
  ['session-confirm', '会话内文本确认的插件与契约，由 owner 审批与指令的意图确认取代'],
  ['setConfirmHandler', 'authority 的确认通道注册表'],
  ['inbound:confirm', '网关为文本确认回复设的入站相位'],
  ['TemporaryGrant', '确认后的临时授予'],
  ['createTempGrant', '确认后的临时授予'],
  ['revokeTemporaryGrant', '确认后的临时授予'],
  ['autoConfirmUntil', 'owner 限时免确认（/auto）'],
  ['pendingConfirm', '旧前端把下一句输入当确认回复'],
  ['确认相位', '网关为文本确认回复设的入站相位'],
  ['确认通道', 'authority 的确认通道注册表与各平台登记的确认通道'],
  ['自动确认', 'owner 限时免确认（/auto）'],
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name) && !SKIP_PATHS.has(full)) yield* walk(full);
    } else if (TEXT.test(name) && !name.endsWith('-lock.json')) {
      yield full;
    }
  }
}

function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap(dir => [...walk(join(ROOT, dir))]);
  for (const name of SCAN_FILES) files.push(join(ROOT, name));
  return files.map(file => relative(ROOT, file)).filter(file => file !== SELF);
}

describe('已删除的机制不留痕迹', () => {
  const files = scannedFiles().map(file => [file, readFileSync(join(ROOT, file), 'utf-8')] as const);
  it.each(REMOVED)('%s（%s）', identifier => {
    const hits = files.filter(([, text]) => text.includes(identifier)).map(([file]) => file);
    expect(hits).toEqual([]);
  });
});
