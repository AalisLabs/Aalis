import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 存档元数据只经登记的键读：会话服务读存档消息 metadata 的键，要么引用 schema-message 的 WellKnownMetadataKeys，要么是
// 它自己写进工具结果元数据的那几个（agent 按 api-agent 的约定原样落库）；直接写别的键名就失败。第三方的 agent 与存档
// 插件照登记的键写，历史才还原得出说话人、文件、模型与工具卡的归组。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const SESSION_SERVER_SRC = 'packages/plugin-session-server/src';

/** 会话服务自己写进工具结果元数据、自己读的键：与它实际写的逐条相等 */
const SELF_WRITTEN_KEYS = ['aborted', 'approval', 'backgroundTask', 'exitCode', 'sentToRoom'];

/** 名字叫 metadata、却不是存档消息元数据的读：「文件 键」→ 理由。每条都要还读着 */
const NOT_ARCHIVE_READS = new Map([
  [
    'packages/plugin-session-server/src/sessions.ts platform',
    '会话记录（api-session-manager 的 SessionInfo）的元数据，子任务建档时写入，不是存档消息的',
  ],
]);

function visitAll(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => visitAll(child, visit));
}

const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

const literalText = (node: ts.Node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;

/** 去掉括号、非空与类型断言，`a ?? b`、`a || b` 取 a */
function strip(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return strip(node.expression);
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return strip(node.left);
  }
  return node;
}

interface KeyAccess {
  file: string;
  line: number;
  /** 写成字面量的键；守卫看不见的（键是变量、解构）为 undefined */
  key: string | undefined;
}

/**
 * 一个文件里对存档元数据的读写：元数据是名为 metadata 的属性与变量，以及从它取来的变量（const meta = m.metadata ?? {}）；
 * 读写是它上面的 .键 与 [键]，赋值的左边算写。键引用 WellKnownMetadataKeys 的不记；键不是字面量的、对它解构的，记成没有键
 */
function metadataAccess(source: ts.SourceFile): { reads: KeyAccess[]; writes: KeyAccess[] } {
  const reads: KeyAccess[] = [];
  const writes: KeyAccess[] = [];
  const names = new Set(['metadata']);
  const isMetadata = (node: ts.Expression) => {
    const inner = strip(node);
    return (
      (ts.isPropertyAccessExpression(inner) && inner.name.text === 'metadata') ||
      (ts.isIdentifier(inner) && names.has(inner.text))
    );
  };
  const access = (node: ts.Node, key: string | undefined) => ({ file: source.fileName, line: lineOf(node), key });
  visitAll(source, node => {
    if (ts.isVariableDeclaration(node) && node.initializer && isMetadata(node.initializer)) {
      if (ts.isIdentifier(node.name)) names.add(node.name.text);
      else reads.push(access(node, undefined));
    }
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) || !isMetadata(node.expression)) {
      return;
    }
    let key: string | undefined;
    if (ts.isPropertyAccessExpression(node)) key = node.name.text;
    else {
      const argument = node.argumentExpression;
      const registered =
        ts.isPropertyAccessExpression(argument) &&
        ts.isIdentifier(argument.expression) &&
        argument.expression.text === 'WellKnownMetadataKeys';
      if (registered) return;
      key = literalText(argument);
    }
    const written =
      ts.isBinaryExpression(node.parent) &&
      node.parent.left === node &&
      node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    (written ? writes : reads).push(access(node, key));
  });
  return { reads, writes };
}

describe('存档元数据只经登记的键读', () => {
  const accesses = readdirSync(join(ROOT, SESSION_SERVER_SRC), { recursive: true, encoding: 'utf-8' })
    .filter(name => /\.tsx?$/.test(name))
    .map(name => {
      const file = join(SESSION_SERVER_SRC, name);
      return metadataAccess(
        ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true),
      );
    });
  const reads = accesses.flatMap(found => found.reads);
  const writes = accesses.flatMap(found => found.writes);
  const where = ({ file, line, key }: KeyAccess) => `${file}:${line} ${key ?? '（看不见的键）'}`;
  const entryOf = ({ file, key }: KeyAccess) => `${file} ${key}`;

  it('会话服务自己写的键恰为名单，也都读着：判据没有因为写法变化失效', () => {
    expect([...new Set(writes.map(write => write.key))].sort()).toEqual(SELF_WRITTEN_KEYS);
    expect(SELF_WRITTEN_KEYS.filter(key => !reads.some(read => read.key === key))).toEqual([]);
  });

  it('会话服务读存档元数据的键都引用 WellKnownMetadataKeys，或是它自己写的', () => {
    expect(
      reads
        .filter(read => !(read.key && SELF_WRITTEN_KEYS.includes(read.key)) && !NOT_ARCHIVE_READS.has(entryOf(read)))
        .map(where),
      '跨插件的存档元数据键登记进 schema-message 的 WellKnownMetadataKeys，读写两方都引用常量',
    ).toEqual([]);
  });

  it('不算存档元数据的读都还在：改掉之后豁免不能悄悄留着', () => {
    expect([...NOT_ARCHIVE_READS.keys()].filter(entry => !reads.some(read => entryOf(read) === entry))).toEqual([]);
  });

  it('按判据收集：metadata 属性与变量、从它取来的变量上的 .键 与 [键]；引用 WellKnownMetadataKeys 的不记，键看不见与解构的记成没有键', () => {
    const declared = ts.createSourceFile(
      'zz-history.ts',
      `const visible = m.metadata?.[WellKnownMetadataKeys.VisibleContent];
      const approval = m.metadata?.approval;
      const meta = m.metadata ?? {};
      const who = meta.zzSpeaker;
      function settled(metadata: Record<string, unknown> | undefined) { return metadata?.['zzQuoted']; }
      const dynamic = m.metadata?.[key];
      const { zzField } = m.metadata ?? {};
      const record: Record<string, unknown> = {};
      record.zzNotMetadata = true;
      metadata.zzWritten = true;`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(metadataAccess(declared)).toEqual({
      reads: [
        { file: 'zz-history.ts', line: 2, key: 'approval' },
        { file: 'zz-history.ts', line: 4, key: 'zzSpeaker' },
        { file: 'zz-history.ts', line: 5, key: 'zzQuoted' },
        { file: 'zz-history.ts', line: 6, key: undefined },
        { file: 'zz-history.ts', line: 7, key: undefined },
      ],
      writes: [{ file: 'zz-history.ts', line: 10, key: 'zzWritten' }],
    });
  });
});
