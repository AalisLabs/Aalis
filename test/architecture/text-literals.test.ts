import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compilerOptions, fixtureProgram, holdsTextRef, ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 给人看的位置不写死中文
//
// 给人看的文字取自原文字典、以文字对象交给出口，按读者的语言渲染；写死的中文换了语言也还是中文。契约把给人看的位置放宽成
// string | TextRef，这类位置的类型里有文字对象，给模型与日志的位置是 string 或 unknown，所以服务端按类型认：字符串字面量
// 与模板字面量（带插值的看各段原文）含中日韩文字、它的上下文类型里又有文字对象，即违例——对象属性、实参、返回值、条件
// 分支、t() 的参数值都算。文字对象按结构认（与拼接守卫同一判法，联合与交叉看成员）；泛型调用（如 defineConfig）按类型参数
// 的约束认，泛型回调（如 map）的返回值按调用处要的类型认。core 不依赖 schema-i18n，它的展示值（插件定义的 displayName、
// provide 选项的 label）类型是 unknown，按声明认，对象字面量里这两个属性的值同样算。WebUI 客户端没有给模型的位置，src 下的
// 字符串、模板字面量、JSX 文本与 JSX 属性含中日韩文字一律违例，它自己的字典（src/texts.ts 与 src/locales/ 下）除外。注释
// 不算。中日韩文字按 Unicode 脚本认（Han、Hiragana、Katakana、Hangul），全角标点单独出现不算；看源码原文，用转义写的（如
// '[\u4e00-\u9fff]'）不算。
//
// 扫描面是 packages/*/src 的全部 .ts / .tsx，编译选项取 tsconfig.test.json，全仓只建一次程序。
//
// 还没迁的违例按名单放行，每条带理由。包级名单按包放行，迁完一个包删一行。位置级名单登记长期不翻的位置（显示但不翻的日志、
// 协议与数据，或某单元定下的诊断句），按「文件 + 字面量原文」认，不用行号，同一文件里同一原文一条放行全部（有意的：同一句
// 是同一个决定）；可以与包级名单重叠，一经确认就登记，包迁完删掉包级那一行时它们自然保留。名单里的包已经没有位置级名单之外
// 的违例（包级那一行没有放行的了）、位置已经没有违例时，守卫报「该删掉」，同一位置登记两次也报。
//
// 看不到的写法有两类。一类永久看不到，要靠迁移时自查：Error 与只收 string 的内置类型的说明，标签模板，插值里的字面量，加号
// 与 join 拼出的句子，数组里的展开（有没有条件都一样），展开实参，先赋给变量再交出去的字面量，as 断言成 string 的字面量，对象
// 字面量里 getter 的返回值，Object.fromEntries 的条目值，flatMap 回调返回的数组，core 展示值写在条件分支里的字面量；套了两层
// 的泛型回调（如 flatMap 里再 map）里的字面量也可能看不到。扫描面只认 .ts 与 .tsx，示例前端 plugin-webui-client-example 的
// src/index.html 等不在内。另一类是只收 string 的契约位置，单元 D 放宽契约时自然进入视野。
// ════════════════════════════════════════════════════════════

/** 包级名单：包目录名 → 理由 */
const PACKAGE_ALLOWLIST = new Map([
  ['plugin-adapter-onebot', '单元 D'],
  ['plugin-asr-openai', '单元 D'],
  ['plugin-asr-whisper-cpp', '单元 D'],
  ['plugin-authority', '单元 D'],
  ['plugin-checkpoint', '单元 D'],
  ['plugin-code-sandbox-os', '单元 D'],
  ['plugin-contributions', '单元 D'],
  ['plugin-cron-engine', '单元 D'],
  ['plugin-draw', '单元 D'],
  ['plugin-embedding-ollama', '单元 D'],
  ['plugin-embedding-openai', '单元 D'],
  ['plugin-file-reader', '单元 D'],
  ['plugin-flow-control', '单元 D'],
  ['plugin-hooks', '单元 D'],
  ['plugin-image-sender', '单元 D'],
  ['plugin-llm-deepseek', '单元 D'],
  ['plugin-llm-ollama', '单元 D'],
  ['plugin-llm-openai', '单元 D'],
  ['plugin-maimai', '单元 D'],
  ['plugin-mcp-client', '单元 D'],
  ['plugin-mcp-server', '单元 D'],
  ['plugin-media', '单元 D'],
  ['plugin-memory-history', '单元 D'],
  ['plugin-memory-inmemory', '单元 D'],
  ['plugin-memory-mongodb', '单元 D'],
  ['plugin-memory-sqlite', '单元 D'],
  ['plugin-memory-summary', '单元 D'],
  ['plugin-memory-vector', '单元 D'],
  ['plugin-message-archive', '单元 D'],
  ['plugin-office', '单元 D'],
  ['plugin-okx-trading', '单元 D'],
  ['plugin-package-manager', '单元 D'],
  ['plugin-paper', '单元 D'],
  ['plugin-persona', '单元 D'],
  ['plugin-process-local', '单元 D'],
  ['plugin-publish-review', '单元 D'],
  ['plugin-reach', '单元 D'],
  ['plugin-remote-agent-cursor', '单元 D'],
  ['plugin-scheduler', '单元 D'],
  ['plugin-skills', '单元 D'],
  ['plugin-storage-local', '单元 D'],
  ['plugin-subtask', '单元 D'],
  ['plugin-todo-list', '单元 D'],
  ['plugin-tool-browser', '单元 D'],
  ['plugin-tool-code-runner', '单元 D'],
  ['plugin-tool-math', '单元 D'],
  ['plugin-tool-onebot', '单元 D'],
  ['plugin-tool-search', '单元 D'],
  ['plugin-tool-session', '单元 D'],
  ['plugin-tool-system', '单元 D'],
  ['plugin-trigger-laya', '单元 D'],
  ['plugin-trigger-policy', '单元 D'],
  ['plugin-usage-stats', '单元 D'],
  ['plugin-user-profile', '单元 D'],
  ['plugin-user-relation', '单元 D'],
  ['plugin-vectorstore-flat', '单元 D'],
  ['plugin-vectorstore-lancedb', '单元 D'],
  ['plugin-websearch-serper', '单元 D'],
  ['plugin-workflow', '单元 D'],
  ['plugin-works-site', '单元 D'],
]);

/** 位置级名单：长期不翻的位置，reason 写依据 */
const POSITION_ALLOWLIST: readonly (Position & { reason: string })[] = [
  {
    file: 'packages/plugin-session-server/src/connection.ts',
    literal: "'这条连接已经握过手'",
    reason: '协议诊断，显示但不翻（第 6 节，B3 审查定）',
  },
  {
    file: 'packages/plugin-session-server/src/connection.ts',
    literal: `\`没有这个方法：\${method}\``,
    reason: '协议诊断，显示但不翻（第 6 节，B3 审查定）',
  },
  {
    file: 'packages/plugin-session-server/src/connection.ts',
    literal: "'请先 initialize 握手'",
    reason: '协议诊断，显示但不翻（第 6 节，B3 审查定）',
  },
  {
    file: 'packages/plugin-session-server/src/connection.ts',
    literal: "'帧不是合法的 JSON'",
    reason: '协议诊断，显示但不翻（第 6 节，B3 审查定）',
  },
  {
    file: 'packages/plugin-session-server/src/connection.ts',
    literal: "'不是 JSON-RPC 2.0 请求'",
    reason: '协议诊断，显示但不翻（第 6 节，B3 审查定）',
  },
  {
    file: 'packages/plugin-session-manager/src/index.ts',
    literal: "'会话消息历史已清空'",
    reason: '删除会话时的清理结果只进日志（第 6 节显示但不翻）',
  },
  {
    file: 'packages/plugin-session-manager/src/index.ts',
    literal: `\`会话消息历史清空失败: \${msg}\``,
    reason: '删除会话时的清理结果只进日志（第 6 节显示但不翻）',
  },
  {
    file: 'packages/plugin-tools/src/tools.ts',
    literal: "'回合已中止，未执行'",
    reason:
      '执行守卫的拒绝语在工具路径只给模型（交工具结果前取原文），与「调用已中止，未执行」同类，不进字典（单元 D 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/FramePage.tsx',
    literal: `\`插件前端「\${page.title}」（\${page.instance}）：\${STOPPED[why.reason].source}\``,
    reason: '插件前端被停止显示的告警只进浏览器控制台，日志照原文（第 6 节显示但不翻，单元 C 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/channel.ts',
    literal: "'输入要能写成 JSON'",
    reason: '协议诊断：插件前端发来写不成 JSON 的输入，只在它的代码写错时出现，同 frame 校验句不翻（5.2，单元 C 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/channel.ts',
    literal: "'取回的数据不是 { data } 的形状'",
    reason: '协议诊断：服务端的回应与契约不符，只在宿主一方的代码写错时出现，同 frame 校验句不翻（5.2，单元 C 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/channel.ts',
    literal: `\`这一页没有动作 \${name}\``,
    reason: '协议诊断：插件前端调了这一页没声明的动作，只在它的代码写错时出现，同 frame 校验句不翻（5.2，单元 C 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/channel.ts',
    literal: "'宿主自己的地址不经外链打开'",
    reason: '协议诊断：插件前端拿宿主自己的地址请外链，只在它的代码写错时出现，同 frame 校验句不翻（5.2，单元 C 定）',
  },
  {
    file: 'packages/plugin-webui-client/src/frame/channel.ts',
    literal: `\`这个页面没有申请 \${needed}\``,
    reason: '协议诊断：插件前端用了没申请的宿主数据能力，只在它的代码写错时出现，同 frame 校验句不翻（5.2，单元 C 定）',
  },
];

/** 一处违例：文件相对仓根，literal 是字面量的源码原文 */
interface Hit {
  file: string;
  line: number;
  literal: string;
}

/** 名单上的位置按文件与字面量原文认，不用行号 */
type Position = Pick<Hit, 'file' | 'literal'>;

/** 中日韩文字：按 Unicode 脚本认，全角标点的脚本是 Common，不算 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 按客户端规则查的源码：WebUI 客户端的 src，它自己的字典（src/texts.ts 与 src/locales/ 下，原文与译文就写在那里）除外 */
const CLIENT_SRC = /^packages\/plugin-webui-client\/src\/(?!texts\.ts$|locales\/)/;
/** core 的展示值（`文件 接口.属性`）：core 不依赖 schema-i18n，类型是 unknown，按声明认 */
const CORE_DISPLAY_FIELDS = new Set([
  'packages/core/src/composition/plugin-definition.ts PluginDefinition.displayName',
  'packages/core/src/composition/core-services.ts ProvideOptions.label',
]);

/** 程序里写死中文的给人看的位置，只看 `files` 里的源文件 */
function literalHits(program: ts.Program, files: readonly string[]): Hit[] {
  const checker = program.getTypeChecker();
  // getContextualType 的第二个参数是 TS 内部的 ContextFlags，公开的类型声明里没有。Completions（4）阻断从节点自身推断：
  // defineConfig 的 const 类型参数、map 回调的返回值默认推成字面量自己的类型，这样取时类型参数退回约束或按调用处要的类型推，
  // 才认得出。这种取法受 TS 的检查缓存影响：先取过默认的，紧接着按约束取的第一次常落空（泛型回调外面还套着调用时，如
  // data: () => xs.map(…)），所以按约束取两次。TS 改了这个标志或缓存，服务端夹具会变红
  const contextualType = checker.getContextualType as (node: ts.Expression, flags?: number) => ts.Type | undefined;
  /** 上下文类型满足 test：先取默认的，不满足再按约束取 */
  const inContext = (node: ts.Expression, test: (type: ts.Type) => boolean) =>
    [undefined, 4, 4].some(flags => {
      const type = contextualType(node, flags);
      return type !== undefined && test(type);
    });
  /** 类型（联合看成员）的这个属性声明为 core 的展示值 */
  const coreDisplayField = (type: ts.Type, name: string) =>
    (type.isUnion() ? type.types : [type]).some(member =>
      checker.getPropertyOfType(member, name)?.declarations?.some(({ parent }) => {
        const file = relative(ROOT, parent.getSourceFile().fileName).replace(/\\/g, '/');
        return ts.isInterfaceDeclaration(parent) && CORE_DISPLAY_FIELDS.has(`${file} ${parent.name.text}.${name}`);
      }),
    );
  // 上下文类型里有文字对象，或是对象字面量里 core 展示值的属性值；属性名的上下文类型取的是属性值的，它本身不是值
  const forHumans = (node: ts.Expression): boolean => {
    const { parent } = node;
    if ((parent as { name?: ts.Node }).name === node) return false;
    if (inContext(node, type => holdsTextRef(checker, type))) return true;
    if (!ts.isPropertyAssignment(parent) || ts.isComputedPropertyName(parent.name)) return false;
    const { text } = parent.name;
    return inContext(parent.parent, type => coreDisplayField(type, text));
  };
  const hits: Hit[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`程序里没有 ${file}`);
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const client = CLIENT_SRC.test(rel);
    const visit = (node: ts.Node): void => {
      const segments = ts.isTemplateExpression(node)
        ? [node.head, ...node.templateSpans.map(span => span.literal)]
        : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || (client && ts.isJsxText(node))
          ? [node]
          : [];
      if (segments.some(segment => CJK.test(segment.getText(sf))) && (client || forHumans(node as ts.Expression))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        // JSX 文本带着行尾的换行与缩进
        hits.push({ file: rel, line, literal: node.getText(sf).trim() });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

/** 对照两份名单：名单外的违例（`文件:行 原文`），该删掉的包（没有位置级名单之外的违例）与位置（没有违例），登记了两次的位置 */
function audit(hits: readonly Hit[], packages: ReadonlyMap<string, string>, positions: readonly Position[]) {
  const packageOf = (file: string) => file.split('/')[1];
  const same = (a: Position, b: Position) => a.file === b.file && a.literal === b.literal;
  const show = (position: Position) => `${position.file} ${position.literal}`;
  return {
    unlisted: hits
      .filter(hit => !packages.has(packageOf(hit.file)) && !positions.some(position => same(position, hit)))
      .map(hit => `${hit.file}:${hit.line} ${hit.literal}`),
    stalePackages: [...packages.keys()].filter(
      pkg => !hits.some(hit => packageOf(hit.file) === pkg && !positions.some(position => same(position, hit))),
    ),
    stalePositions: positions.filter(position => !hits.some(hit => same(position, hit))).map(show),
    duplicatePositions: positions
      .filter((position, i) => positions.findIndex(other => same(other, position)) !== i)
      .map(show),
  };
}

// 夹具不落盘；编译宿主收到的文件名一律用 / 分隔
const SERVER_FIXTURE = join(ROOT, 'test/architecture/text-literals.fixture.ts').replace(/\\/g, '/');
const SERVER_SOURCE = `import { definePlugin, defineService, provide } from '@aalis/core';
import { defineConfig } from '@aalis/schema-config';
import { defineTexts, type TextRef } from '@aalis/schema-i18n';
const t = defineTexts({ ns: 'zz-fixture', language: 'zh-CN', source: { hello: '你好，{name}', plain: '原文' } });
interface Page { readonly title: string | TextRef; readonly hint?: string | TextRef }
interface Tool { readonly description: string }
interface ToolReply { readonly label: unknown }
declare function show(text: string | TextRef): void;
declare function choose(options: readonly { readonly label: string | TextRef }[]): void;
declare function lazy(rows: () => readonly { readonly label: string | TextRef }[]): void;
declare function log(...args: unknown[]): void;
declare const flag: boolean;
declare const count: number;
declare const names: readonly string[];
export const page: Page = { title: '标题', hint: 'ASCII only' };
export const tool: Tool = { description: '给模型看的说明' };
export const reply: ToolReply = { label: '工具结果' };
show('提示');
export const label = (): string | TextRef => '返回值';
show(flag ? '是' : '否');
show(\`\${count} 项\`);
export const greeting = t('hello', { name: '世界' });
log('日志', \`第 \${count} 次\`);
show('[\\u4e00-\\u9fff]');
export const table: Readonly<Record<string, string | TextRef>> = { '引号键': t('plain') };
export const schema = defineConfig({ a: { type: 'string', label: '字段', description: '说明', default: '默认值' } });
choose(names.map(name => ({ label: \`选项 \${name}\` })));
lazy(() => names.map(name => ({ label: '延后' })));
const service = defineService<object>('zz-fixture');
export const plugin = definePlugin({
  name: 'zz-fixture',
  displayName: '夹具插件',
  uses: { provide },
  apply({ provide }) {
    provide.use(service, {}, { label: '服务名' });
  },
});
`;
// 放在客户端的 src 下，才按客户端规则查
const CLIENT_FIXTURE = join(ROOT, 'packages/plugin-webui-client/src/text-literals.fixture.tsx').replace(/\\/g, '/');
const CLIENT_SOURCE = `// 注释里的中文不算
export const plain = '普通字符串';
export const template = \`模板 \${plain}\`;
export const element = <span title="属性">正文</span>;
export const nested = <input placeholder={'表达式里的'} aria-label="ascii" />;
/* 块注释：中文 */
export const fine = ['ascii', \`ok \${plain}\`, '[\\u4e00-\\u9fff]', '（，。：）'];
export const scripts = ['ひらがな', 'カタカナ', '한글'];
export const block = <p>
  多行的 JSX 文本
</p>;
`;

/** 一个夹具里的违例：`行 原文` */
function fixtureHits(file: string, source: string): string[] {
  return literalHits(fixtureProgram(file, source), [file]).map(hit => `${hit.line} ${hit.literal}`);
}

describe('给人看的位置不写死中文', () => {
  it('服务端：上下文类型里有文字对象的位置与 core 的展示值报；只收字符串或 unknown 的、纯 ASCII、字典原文、转义写的字符类与属性名不报', () => {
    expect(fixtureHits(SERVER_FIXTURE, SERVER_SOURCE)).toEqual([
      "15 '标题'",
      "18 '提示'",
      "19 '返回值'",
      "20 '是'",
      "20 '否'",
      `21 \`\${count} 项\``,
      "22 '世界'",
      "26 '字段'",
      "26 '说明'",
      `27 \`选项 \${name}\``,
      "28 '延后'",
      "32 '夹具插件'",
      "35 '服务名'",
    ]);
  });

  it('客户端：字符串、模板、JSX 属性与 JSX 文本含中日韩文字即报；注释、全角标点与转义写的字符类不报', () => {
    expect(fixtureHits(CLIENT_FIXTURE, CLIENT_SOURCE)).toEqual([
      "2 '普通字符串'",
      `3 \`模板 \${plain}\``,
      '4 "属性"',
      '4 正文',
      "5 '表达式里的'",
      "8 'ひらがな'",
      "8 'カタカナ'",
      "8 '한글'",
      '10 多行的 JSX 文本',
    ]);
  });

  it('客户端：自己的字典（src/texts.ts 与 src/locales/ 下）不按客户端规则查', () => {
    const at = (path: string) => join(ROOT, 'packages/plugin-webui-client/src', path).replace(/\\/g, '/');
    const source = "export const hello = '你好';\n";
    expect(fixtureHits(at('texts.ts'), source)).toEqual([]);
    expect(fixtureHits(at('locales/ja.ts'), source)).toEqual([]);
    expect(fixtureHits(at('other.ts'), source)).toEqual(["1 '你好'"]);
  });

  it('名单外的违例报出来；包里没有位置级名单之外的违例、位置已经没有违例时报「该删掉」；位置可与包重叠，登记两次的位置报出来', () => {
    const hits: Hit[] = [
      { file: 'packages/plugin-a/src/index.ts', line: 3, literal: "'甲'" },
      { file: 'packages/plugin-b/src/index.ts', line: 5, literal: "'乙'" },
      { file: 'packages/plugin-c/src/index.ts', line: 7, literal: "'丙'" },
      { file: 'packages/plugin-e/src/index.ts', line: 2, literal: "'戊'" },
      { file: 'packages/plugin-e/src/index.ts', line: 4, literal: "'己'" },
    ];
    const positions: Position[] = [
      { file: 'packages/plugin-a/src/index.ts', literal: "'甲'" },
      { file: 'packages/plugin-b/src/index.ts', literal: "'乙'" },
      { file: 'packages/plugin-b/src/index.ts', literal: "'丁'" },
      { file: 'packages/plugin-b/src/index.ts', literal: "'乙'" },
      { file: 'packages/plugin-e/src/index.ts', literal: "'戊'" },
    ];
    const packages = new Map([
      ['plugin-a', '夹具'],
      ['plugin-d', '夹具'],
      ['plugin-e', '夹具'],
    ]);
    expect(audit(hits, packages, positions)).toEqual({
      unlisted: ["packages/plugin-c/src/index.ts:7 '丙'"],
      stalePackages: ['plugin-a', 'plugin-d'],
      stalePositions: ["packages/plugin-b/src/index.ts '丁'"],
      duplicatePositions: ["packages/plugin-b/src/index.ts '乙'"],
    });
  });

  it('packages 源码里写死中文的位置都在名单里，名单里的条目都还有违例', () => {
    const files = sourceFiles();
    const hits = literalHits(ts.createProgram(files, compilerOptions()), files);
    expect(
      audit(hits, PACKAGE_ALLOWLIST, POSITION_ALLOWLIST),
      '名单外的违例改成文字对象；名单里已经没有违例的条目（包是没有位置级名单之外的违例）删掉，登记两次的删掉一条',
    ).toEqual({ unlisted: [], stalePackages: [], stalePositions: [], duplicatePositions: [] });
  }, 120_000);
});
