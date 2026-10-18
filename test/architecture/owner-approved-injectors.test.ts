import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 只有人亲手写的文字才执行指令：带 source 的注入里，只有声明了 IncomingMessage.ownerApproved 的照常过指令解析。
// 这个声明表示文字在建立时经 owner 过目过原文，与 actor 同一信任面，所以填它的注入方要在这里显式登记：
// packages/*/src 下出现 ownerApproved 的文件必须恰为下面的名单（契约、消费方与已登记的注入方）。
// ════════════════════════════════════════════════════════════

const ALLOWED = new Map<string, string>([
  ['packages/schema-message/src/index.ts', '契约：IncomingMessage.ownerApproved'],
  ['packages/plugin-commands/src/index.ts', '消费方：带 source 的注入只有声明了的才过指令解析'],
  [
    'packages/plugin-scheduler/src/index.ts',
    '注入方：任务内容在配置、计划任务页由 owner 写下，经工具建的每次由 owner 审批',
  ],
]);

describe('经 owner 审批的注入方登记', () => {
  it('packages/*/src 下出现 ownerApproved 的文件恰为登记名单', () => {
    const found = sourceFiles()
      .filter(file => readFileSync(file, 'utf-8').includes('ownerApproved'))
      .map(file => relative(ROOT, file).replace(/\\/g, '/'));
    expect(
      found.sort(),
      '新增声明 ownerApproved 的注入方要登记进本文件的 ALLOWED 并写明原文怎样经过 owner；别的注入不声明，正文按普通消息交给她',
    ).toEqual([...ALLOWED.keys()].sort());
  });
});
