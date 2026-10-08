import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 宿主通知的身份：默认不带任何人的权限（actor 用 selfInitiatedActor、不设 callerUserId）。
// 延续某次工具调用的通知可以沿用那次调用的身份并设 hostNotice.callerUserId，agent 据此填工具调用上下文的 userId，
// 能否产生 owner 审批按 owner 链判（发起类别 owner-chain 要求 callerUserId 与授权身份都是 owner）。
// 这是和 actor 同一信任面的口子，所以允许延续身份的注入方要在这里显式登记：
// packages/*/src 下出现 callerUserId 的文件必须恰为下面的名单（契约、消费方与已登记的注入方）。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

const ALLOWED = new Map<string, string>([
  ['schema-message/index.ts', '契约：IncomingMessage.hostNotice.callerUserId'],
  ['api-authority/index.ts', '契约：执行守卫上下文的入站回合（InboundTurn）带着它，工具调用上下文沿用这个类型'],
  ['plugin-agent/index.ts', '消费方：填工具调用上下文的 userId 与 inbound.callerUserId'],
  ['plugin-authority/authority-model.ts', '消费方：判发起回合是不是 owner 链的延续（能否产生审批）'],
  ['plugin-tools/background.ts', '注入方：后台任务的结束通知延续起它的那次工具调用的身份'],
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
