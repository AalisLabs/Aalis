import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 发起它的那一轮（IncomingMessage.fromTurn）：续做与子任务的消息带着发起它的那次调用所在那一轮的事实（平台、发言者、参与者、
// 来源与那一轮自己的 fromTurn），权限服务按那一轮判这一轮的类别，agent 经 api-authority 的 originTurnOf 由它给工具调用上下文
// 的发言者与授权身份。这是和 actor 同一信任面的口子：只由登记的注入方填，不由模型给，
// 所以 packages/*/src 下出现 fromTurn 的文件必须恰为下面的名单（契约、拼装与判定、已登记的注入方）。
// 消费方只调权限服务与拼装函数，不出现这个字段。
// ════════════════════════════════════════════════════════════

const PACKAGES = join(__dirname, '../../packages');

const ALLOWED = new Map<string, string>([
  ['schema-message/index.ts', '契约：IncomingMessage.fromTurn 与它的类型 FromTurn'],
  ['api-authority/index.ts', '契约与拼装：入站回合（InboundTurn）带着它，originTurnOf 由它给发言者与授权身份'],
  [
    'plugin-authority/authority-model.ts',
    '判定：续做与子任务的类别随发起它的那一轮，主体按这次调用的参与者，批过的按批的人',
  ],
  ['plugin-tools/background.ts', '注入方：后台任务的结束通知带着发起它的那次调用所在那一轮'],
  ['plugin-subtask/index.ts', '注入方：入站回合里派出的任务消息与追问带着派它的那一轮'],
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

describe('发起它的那一轮：注入方登记', () => {
  it('packages/*/src 下出现 fromTurn 的文件恰为登记名单', () => {
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
        if (readFileSync(file, 'utf-8').includes('fromTurn')) found.push(`${pkg}/${file.slice(src.length + 1)}`);
      }
    }
    expect(
      found.sort(),
      '新增带发起它的那一轮的注入方要登记进本文件的 ALLOWED 并写明理由；不延续某次调用的通知用 selfInitiatedActor、不带 fromTurn',
    ).toEqual([...ALLOWED.keys()].sort());
  });
});
