import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BLOCKED_EVENT_TRIGGERS } from '../../packages/plugin-workflow/src/triggers.js';
import { ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 编排的 event 触发器按定义者的身份运行，事件参数作为运行变量插值进 tool 节点的参数、agent 节点的指令与 send-message 的正文：
// 负载带会话内容的事件不能当触发源，内容里不可信的部分会以定义者的身份下达，转发到别的会话又是跨会话外泄。第一方声明的每个
// 事件（packages/*/src 里 AalisEvents 的条目，core 自持的与 declaration merging 的都算）都要表态：不可作触发源的在
// plugin-workflow 的 BLOCKED_EVENT_TRIGGERS 里，可作触发源的在下面的 TRIGGERABLE 里、写明负载里有什么。新事件不表态、两张表
// 都列、表里的事件不再声明，都红；按名字表态不了的条目（动态事件族的索引签名、计算属性名、继承来的成员）也红。按语法树查。
// ════════════════════════════════════════════════════════════

const TRIGGERABLE = new Map<string, string>([
  ['service:changed', '服务名'],
  ['plugin:loaded', '插件实例 id'],
  ['plugin:unloaded', '插件实例 id'],
  ['plugins:changed', '没有负载'],
  ['app:ready', '没有负载'],
  ['app:started', '没有负载'],
  ['app:restarting', '没有负载'],
  ['app:stopping', '没有负载'],
  ['token:usage', '会话与回合 id、平台、用量数字与宿主写的分项名'],
  ['token:request', '会话 id 与平台'],
  ['llm:usage', '服务商、模型、调用方、会话 id、用途与 token 数'],
  ['gateway:phase:done', '相位名、是否走到底、耗时、会话 id 与平台'],
  ['doctor:updated', '诊断时刻与各级计数'],
  ['memory:messages-deleted', '会话 id 与被删消息的时间戳'],
  ['history:changed', '会话 id'],
  ['session:compressing', '会话 id 与压缩进度'],
  ['session:deleted', '会话 id'],
  ['session:config:changed', '没有负载'],
  ['terminal:claimed', '占用终端的插件名'],
  ['terminal:released', '占用终端的插件名'],
  ['scheduler:job:start', '任务名（owner 写下或审批过）'],
  ['scheduler:job:done', '任务名（owner 写下或审批过）'],
  ['scheduler:job:error', '任务名与宿主的失败原因'],
]);

/** 第一方源码里 AalisEvents 接口的全部条目名；认不出名字的条目与 extends 子句原样记进 unrecognized */
function declaredEvents(): { names: Set<string>; unrecognized: string[] } {
  const names = new Set<string>();
  const unrecognized: string[] = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf-8');
    if (!text.includes('AalisEvents')) continue;
    const where = relative(ROOT, file);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'AalisEvents') {
        for (const clause of node.heritageClauses ?? []) unrecognized.push(`${where}: ${clause.getText()}`);
        for (const member of node.members) {
          if (member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))) {
            names.add(member.name.text);
          } else {
            unrecognized.push(`${where}: ${member.getText()}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  }
  return { names, unrecognized };
}

describe('事件能不能当编排的触发源', () => {
  const { names: declared, unrecognized } = declaredEvents();

  it('每个条目都认得出名字', () => {
    expect(unrecognized, '动态事件族与继承来的成员按名字表态不了：先定怎么表态').toEqual([]);
  });

  it('第一方声明的每个事件恰在一张表里', () => {
    expect(declared.size, '扫描面里应找得到 AalisEvents 的条目').toBeGreaterThan(0);
    expect(
      [...declared].filter(name => !BLOCKED_EVENT_TRIGGERS.has(name) && !TRIGGERABLE.has(name)).sort(),
      '新事件要表态：负载带会话内容的加进 BLOCKED_EVENT_TRIGGERS，其余加进本文件的 TRIGGERABLE 并写明负载里有什么',
    ).toEqual([]);
    expect([...BLOCKED_EVENT_TRIGGERS].filter(name => TRIGGERABLE.has(name))).toEqual([]);
  });

  it('两张表里的都是第一方声明着的事件', () => {
    expect([...BLOCKED_EVENT_TRIGGERS, ...TRIGGERABLE.keys()].filter(name => !declared.has(name)).sort()).toEqual([]);
  });
});
