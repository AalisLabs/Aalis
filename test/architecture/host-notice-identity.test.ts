import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 宿主通知的身份：默认不带任何人的权限（actor 用 selfInitiatedActor、不设 callerUserId）。
// 延续某次工具调用的通知可以沿用那次调用的身份并设 hostNotice.callerUserId，agent 据此填工具调用上下文的 userId，
// 确认由起它的人应答。这是和 actor 同一信任面的口子，所以允许延续身份的注入方要在这里显式登记：
// packages/*/src 下出现 callerUserId 的文件必须恰为下面的名单（契约、消费方与已登记的注入方）。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

const ALLOWED = new Map<string, string>([
  ['schema-message/index.ts', '契约：IncomingMessage.hostNotice.callerUserId'],
  ['plugin-agent/index.ts', '消费方：只用来填工具调用上下文的 userId'],
  ['plugin-tool-system/tools/shell.ts', '注入方：后台命令结束通知延续起进程那次调用的身份'],
]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('宿主通知延续身份的注入方登记', () => {
  it('packages/*/src 下出现 callerUserId 的文件恰为登记名单', () => {
    const found: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = join(PACKAGES, pkg, 'src');
      let files: string[];
      try {
        files = [...walk(src)];
      } catch {
        continue; // 无 src 目录的包
      }
      for (const file of files) {
        if (readFileSync(file, 'utf-8').includes('callerUserId')) found.push(`${pkg}/${file.slice(src.length + 1)}`);
      }
    }
    expect(
      found.sort(),
      '新增延续身份的宿主通知注入方要登记进本文件的 ALLOWED 并写明理由；不延续某次调用的通知用 selfInitiatedActor、不设 callerUserId',
    ).toEqual([...ALLOWED.keys()].sort());
  });
});
