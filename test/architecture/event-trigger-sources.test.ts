import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BLOCKED_EVENT_TRIGGERS } from '../../packages/plugin-workflow/src/triggers.js';
import { compilerOptions, ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 编排的 event 触发器按定义者的身份运行，事件参数作为运行变量插值进 tool 节点的参数、agent 节点的指令与 send-message 的正文：
// 负载带会话内容（会话 id、平台、正文等）的事件不能当触发源，内容里不可信的部分会以定义者的身份下达，转发到别的会话又是跨会话
// 外泄，单是会话 id 也让订阅者看出别人的私聊在活动。第一方声明的每个事件（packages/*/src 里 AalisEvents 的条目，core 自持的与
// declaration merging 的都算）都要表态：不可作触发源的在 plugin-workflow 的 BLOCKED_EVENT_TRIGGERS 里，可作触发源的在下面的
// TRIGGERABLE 里、写明负载里有什么。新事件不表态、两张表都列、表里的事件不再声明，都红；按名字表态不了的条目（动态事件族的
// 索引签名、计算属性名、继承来的成员）也红。可作触发源的事件，参数名或参数类型的顶层属性（含可选的）里有会话 id 或平台的
// 也红；放在 content、message 一类字段里的正文按类型查不出，要靠表态时照实写负载。
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
  ['doctor:updated', '诊断时刻与各级计数'],
  ['session:config:changed', '没有负载'],
  ['terminal:claimed', '占用终端的插件名'],
  ['terminal:released', '占用终端的插件名'],
  ['scheduler:job:start', '任务名（owner 写下或审批过）'],
  ['scheduler:job:done', '任务名（owner 写下或审批过）'],
  ['scheduler:job:error', '任务名与宿主的失败原因'],
]);

/** 表明负载是会话信息的名字 */
const SESSION_FIELDS = ['sessionId', 'platform'];

/** 条目的参数里有会话 id 或平台：参数名（元组的标签），或参数类型的顶层属性（含可选的） */
function carriesSession(checker: ts.TypeChecker, member: ts.TypeElement): boolean {
  const type = checker.getTypeAtLocation(member);
  if (!checker.isTupleType(type)) return false;
  const labels = (type as ts.TupleTypeReference).target.labeledElementDeclarations ?? [];
  return (
    labels.some(label => label && ts.isIdentifier(label.name) && SESSION_FIELDS.includes(label.name.text)) ||
    checker
      .getTypeArguments(type as ts.TypeReference)
      .some(param =>
        (param.isUnion() ? param.types : [param]).some(part =>
          SESSION_FIELDS.some(field => checker.getPropertyOfType(part, field)),
        ),
      )
  );
}

/**
 * 第一方源码里 AalisEvents 接口的全部条目名，与参数里有会话 id 或平台的条目名；认不出名字的条目与 extends 子句原样记进
 * unrecognized
 */
function declaredEvents(): { names: Set<string>; withSession: Set<string>; unrecognized: string[] } {
  const names = new Set<string>();
  const withSession = new Set<string>();
  const unrecognized: string[] = [];
  const files = sourceFiles().filter(file => readFileSync(file, 'utf-8').includes('AalisEvents'));
  const program = ts.createProgram(files, compilerOptions());
  const checker = program.getTypeChecker();
  for (const file of files) {
    const where = relative(ROOT, file);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'AalisEvents') {
        for (const clause of node.heritageClauses ?? []) unrecognized.push(`${where}: ${clause.getText()}`);
        for (const member of node.members) {
          if (member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))) {
            names.add(member.name.text);
            if (carriesSession(checker, member)) withSession.add(member.name.text);
          } else {
            unrecognized.push(`${where}: ${member.getText()}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`编译程序里没有 ${where}`);
    visit(source);
  }
  return { names, withSession, unrecognized };
}

describe('事件能不能当编排的触发源', () => {
  const { names: declared, withSession, unrecognized } = declaredEvents();

  it('每个条目都认得出名字', () => {
    expect(unrecognized, '动态事件族与继承来的成员按名字表态不了：先定怎么表态').toEqual([]);
  });

  it('第一方声明的每个事件恰在一张表里', () => {
    expect(declared.size, '扫描面里应找得到 AalisEvents 的条目').toBeGreaterThan(0);
    expect(
      [...declared].filter(name => !BLOCKED_EVENT_TRIGGERS.has(name) && !TRIGGERABLE.has(name)).sort(),
      '新事件要表态：负载带会话内容（会话 id、平台、正文等）的加进 BLOCKED_EVENT_TRIGGERS，其余加进本文件的 TRIGGERABLE 并写明负载里有什么',
    ).toEqual([]);
    expect([...BLOCKED_EVENT_TRIGGERS].filter(name => TRIGGERABLE.has(name))).toEqual([]);
  });

  it('可作触发源的事件，参数里没有会话 id 与平台', () => {
    expect(
      [...TRIGGERABLE.keys()].filter(name => withSession.has(name)).sort(),
      '参数名或参数类型的顶层属性里有 sessionId、platform 的事件带会话信息，列进 BLOCKED_EVENT_TRIGGERS',
    ).toEqual([]);
  });

  it('两张表里的都是第一方声明着的事件', () => {
    expect([...BLOCKED_EVENT_TRIGGERS, ...TRIGGERABLE.keys()].filter(name => !declared.has(name)).sort()).toEqual([]);
  });
});
