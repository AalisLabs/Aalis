import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { WellKnownMetadataKeys } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 存档元数据只经登记的键读：
// - 会话服务读存档消息 metadata 的键，要么引用 schema-message 的 WellKnownMetadataKeys，要么是它自己写进工具结果元数据的
//   那几个（agent 按 api-agent 的约定原样落库）；直接写别的键名就失败。
// - 全部第一方插件读存档元数据里登记过的键，都引用 WellKnownMetadataKeys，不写成字面量；按路径写的（查询条件与索引里的
//   'metadata.<键>'）同样拼常量。别的插件也有叫 metadata 的东西（提示词消息、向量条目、会话记录），守卫按名字认不出是不是
//   存档的，所以这里只查登记过的键名；键名相同、却不是存档元数据的读按「文件 键」列出理由。
// 第三方的 agent 与存档插件照登记的键写，历史、记忆与关系才还原得出说话人、群、文件、模型与工具卡的归组。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
const PACKAGES = join(ROOT, 'packages');
const SESSION_SERVER_SRC = 'packages/plugin-session-server/src/';

/** 会话服务自己写进工具结果元数据、自己读的键：与它实际写的逐条相等 */
const SELF_WRITTEN_KEYS = ['aborted', 'approval', 'backgroundTask', 'exitCode', 'sentToRoom'];

/** 登记过的键名 */
const REGISTERED_KEYS: ReadonlySet<string> = new Set(Object.values(WellKnownMetadataKeys));

/** 名字叫 metadata、却不是存档消息元数据的读：「文件 键」→ 理由。每条都要还读着 */
const NOT_ARCHIVE_READS = new Map([
  [
    'packages/plugin-session-server/src/sessions.ts platform',
    '会话记录（api-session-manager 的 SessionInfo）的元数据，子任务建档时写入，不是存档消息的',
  ],
  [
    'packages/plugin-memory-vector/src/index.ts platform',
    '向量条目的元数据：本插件写入向量库时自己定的字段，按平台筛召回结果',
  ],
  [
    'packages/plugin-memory-vector/src/index.ts userId',
    '向量条目的元数据：本插件写入向量库时自己定的字段，按发言人加权与渲染',
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

/** 键引用 WellKnownMetadataKeys（WellKnownMetadataKeys.X） */
const registeredKey = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'WellKnownMetadataKeys';

/**
 * 一个文件里对存档元数据的读写：元数据是名为 metadata 的属性与变量，以及从它取来的变量（const meta = m.metadata ?? {}）；
 * 读写是它上面的 .键 与 [键]，以及对它的解构，赋值的左边算写。键引用 WellKnownMetadataKeys 的不记；键不是字面量的
 * （变量、剩余元素、数组解构），记成没有键
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
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const name = element.propertyName ?? element.name;
          if (ts.isComputedPropertyName(name) && registeredKey(name.expression)) continue;
          const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
          reads.push(access(element, element.dotDotDotToken ? undefined : key));
        }
      } else reads.push(access(node, undefined));
    }
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) || !isMetadata(node.expression)) {
      return;
    }
    let key: string | undefined;
    if (ts.isPropertyAccessExpression(node)) key = node.name.text;
    else {
      const argument = node.argumentExpression;
      if (registeredKey(argument)) return;
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

/** 一个文件里按路径写的存档元数据键：字符串字面量 'metadata.<键>'（查询条件、索引），键只取单段的 */
function metadataPaths(source: ts.SourceFile): KeyAccess[] {
  const found: KeyAccess[] = [];
  visitAll(source, node => {
    const key = /^metadata\.(\w+)$/.exec(literalText(node) ?? '')?.[1];
    if (key) found.push({ file: source.fileName, line: lineOf(node), key });
  });
  return found;
}

describe('存档元数据只经登记的键读', () => {
  const sources = readdirSync(PACKAGES)
    .filter(name => name.startsWith('plugin-'))
    .flatMap(name => {
      const src = join('packages', name, 'src');
      return readdirSync(join(ROOT, src), { recursive: true, encoding: 'utf-8' })
        .filter(file => /\.tsx?$/.test(file))
        .map(file => join(src, file));
    })
    .map(file => ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true));
  const accesses = sources.map(metadataAccess);
  const paths = sources.flatMap(metadataPaths);
  const reads = accesses.flatMap(found => found.reads);
  const writes = accesses.flatMap(found => found.writes);
  const inSessionServer = ({ file }: KeyAccess) => file.startsWith(SESSION_SERVER_SRC);
  const where = ({ file, line, key }: KeyAccess) => `${file}:${line} ${key ?? '（看不见的键）'}`;
  const entryOf = ({ file, key }: KeyAccess) => `${file} ${key}`;

  it('会话服务自己写的键恰为名单，也都读着：判据没有因为写法变化失效', () => {
    const own = reads.filter(inSessionServer);
    expect([...new Set(writes.filter(inSessionServer).map(write => write.key))].sort()).toEqual(SELF_WRITTEN_KEYS);
    expect(SELF_WRITTEN_KEYS.filter(key => !own.some(read => read.key === key))).toEqual([]);
  });

  it('会话服务读存档元数据的键都引用 WellKnownMetadataKeys，或是它自己写的', () => {
    expect(
      reads
        .filter(inSessionServer)
        .filter(read => !(read.key && SELF_WRITTEN_KEYS.includes(read.key)) && !NOT_ARCHIVE_READS.has(entryOf(read)))
        .map(where),
      '跨插件的存档元数据键登记进 schema-message 的 WellKnownMetadataKeys，读写两方都引用常量',
    ).toEqual([]);
  });

  it('第一方插件读存档元数据里登记过的键都引用 WellKnownMetadataKeys，不写成字面量', () => {
    expect(
      reads
        .filter(read => read.key && REGISTERED_KEYS.has(read.key) && !NOT_ARCHIVE_READS.has(entryOf(read)))
        .map(where),
      '把字面量换成 WellKnownMetadataKeys 里对应的常量',
    ).toEqual([]);
  });

  it('第一方插件按路径写的存档元数据键（查询条件、索引里的 metadata.<键>）同样拼常量', () => {
    expect(
      paths.filter(path => REGISTERED_KEYS.has(path.key ?? '')).map(where),
      '拼成 metadata. 加 WellKnownMetadataKeys 里对应的常量',
    ).toEqual([]);
  });

  it('不算存档元数据的读都还在：改掉之后豁免不能悄悄留着', () => {
    expect([...NOT_ARCHIVE_READS.keys()].filter(entry => !reads.some(read => entryOf(read) === entry))).toEqual([]);
  });

  it('按判据收集：metadata 属性与变量、从它取来的变量上的 .键 与 [键] 及解构；引用 WellKnownMetadataKeys 的不记，键看不见的记成没有键', () => {
    const declared = ts.createSourceFile(
      'zz-history.ts',
      `const visible = m.metadata?.[WellKnownMetadataKeys.VisibleContent];
      const approval = m.metadata?.approval;
      const meta = m.metadata ?? {};
      const who = meta.zzSpeaker;
      function settled(metadata: Record<string, unknown> | undefined) { return metadata?.['zzQuoted']; }
      const dynamic = m.metadata?.[key];
      const { zzField, 'zz-quoted': quoted, [WellKnownMetadataKeys.UserId]: user, ...rest } = m.metadata ?? {};
      const [first] = m.metadata;
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
        { file: 'zz-history.ts', line: 7, key: 'zzField' },
        { file: 'zz-history.ts', line: 7, key: 'zz-quoted' },
        { file: 'zz-history.ts', line: 7, key: undefined },
        { file: 'zz-history.ts', line: 8, key: undefined },
      ],
      writes: [{ file: 'zz-history.ts', line: 11, key: 'zzWritten' }],
    });
  });

  it('按判据收集路径：字符串字面量与不带插值的模板里单段的 metadata.<键>；注释、多段与拼了常量的不记', () => {
    const declared = ts.createSourceFile(
      'zz-store.ts',
      `// 按 metadata.zzComment 过滤
      filter['metadata.zzField'] = x;
      index({ [\`metadata.zzTemplate\`]: 1 });
      index({ [\`metadata.\${WellKnownMetadataKeys.Platform}\`]: 1 });
      sort('metadata.zz.deep');`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(metadataPaths(declared)).toEqual([
      { file: 'zz-store.ts', line: 2, key: 'zzField' },
      { file: 'zz-store.ts', line: 3, key: 'zzTemplate' },
    ]);
  });
});
