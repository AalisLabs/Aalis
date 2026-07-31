// ════════════════════════════════════════════════════════════
// npm 依赖声明的来源分档 + semver 版本序比较
//
// 抽到 util 是因为**同一语义曾有三份实现**，且三份互不一致：
//   - plugin-package-manager 的 isRegistryDep —— 更新闸，判 `user/repo` 不可更新
//   - plugin-webui-server 的 classifyOrigin —— 卡片来源，判 `user/repo` 是 registry
//   - plugin-webui-client 的 isUpdatable —— 勾选框，跟着 classifyOrigin 走
// 实测后果：fork 后钉分支的依赖（`"@aalis/plugin-foo": "acme/aalis-plugin-foo"`）在前端
// 出「可更新」勾选框，提交后被服务端闸整批否决，且理由「不在根依赖中」是错的——它就在根依赖里。
//
// 本模块是这条语义的**唯一实现**：展示分档与更新闸都由 classifyDepSpec 派生，
// 于是「前端显示能更新」与「服务端允许更新」在定义上不可能再分岔。
//
// 零依赖、环境无关、纯函数。
// ════════════════════════════════════════════════════════════

/**
 * 依赖声明的来源分档。
 *
 * 只有 `registry` 一档谈得上「经市场更新」——`npm install <name>@<version>` 对其余各档
 * 要么无从下手，要么会**改写用户的意图**（把 git 引用换成 registry 版本、把别名拆掉）。
 */
export type DepOrigin =
  /** semver 范围 / dist-tag —— npm 从 registry 装的，可经市场更新 */
  | 'registry'
  /** `workspace:` —— pnpm 工作区包，源码在仓库里 */
  | 'workspace'
  /** `file:` / `link:` / `portal:` —— 本地链接 */
  | 'link'
  /** git URL、tarball URL、以及 npm 的 `user/repo` 简写 —— 外部源 */
  | 'git'
  /** `npm:<其它包>@<范围>` —— 装的是别名，包名与声明键不同 */
  | 'alias'
  /** 无有效声明：不在根 dependencies（传递依赖），或声明是空串 */
  | 'transitive';

/** 带协议前缀的外部源。`git+ssh` / `git+https` 由 `git` 前缀一并覆盖。 */
const EXTERNAL_PROTOCOL_RE = /^(git|github:|gitlab:|bitbucket:|https?:)/;

/**
 * 依赖声明字符串 → 来源分档。
 *
 * @param spec 根 package.json 里该包的依赖声明；不在其中传 `undefined`
 */
export function classifyDepSpec(spec: string | undefined): DepOrigin {
  // 空串在 npm 语义下等价于 `*`，但「声明了却没写东西」多半是配置事故而非本意，
  // 保守归入 transitive：市场不去动它，用户自己 npm install 不受影响。
  if (typeof spec !== 'string' || spec.length === 0) return 'transitive';
  if (spec.startsWith('workspace:')) return 'workspace';
  if (spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('portal:')) return 'link';
  if (spec.startsWith('npm:')) return 'alias';
  if (EXTERNAL_PROTOCOL_RE.test(spec)) return 'git';
  // npm 的 `user/repo` GitHub 简写。semver 范围与 dist-tag 都不含 `/`，故这条不会误伤。
  if (spec.includes('/')) return 'git';
  return 'registry';
}

/**
 * 该依赖能否经市场更新（`npm install <name>@<version>`）。
 *
 * 传递依赖尤其危险：npm 对它的语义是「加进根 dependencies」，而父包声明的范围若不含新版
 * 就会**嵌套装第二份**——同一个契约包出现两份，两份 `declare module` 撞成 TS2717 且被
 * `skipLibCheck` 静默吞掉，而插件运行时加载的仍是自己那份旧版，更新对它零效果。
 */
export function isRegistryDep(spec: string | undefined): boolean {
  return classifyDepSpec(spec) === 'registry';
}

/** 精确版本号（semver 主体 + 可选 prerelease + 可选 build）。范围/dist-tag 不匹配。 */
const EXACT_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Parsed {
  main: [number, number, number];
  pre: string[];
}

function parse(v: string): Parsed | undefined {
  const m = EXACT_VERSION_RE.exec(v.trim());
  if (!m) return undefined;
  return {
    main: [Number(m[1]), Number(m[2]), Number(m[3])],
    // 无 prerelease 用空数组表示；semver 规定「有 prerelease < 无 prerelease」，见下。
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** semver §11 的 prerelease 比较：数字段按数值、非数字段按 ASCII、数字段 < 非数字段、短的先耗尽者小。 */
function comparePre(a: string[], b: string[]): number {
  // 空 prerelease = 正式版，**大于**任何 prerelease（1.0.0 > 1.0.0-rc.1）
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // 数字段永远小于非数字段
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * semver 版本序比较：`a < b` 返回 -1，相等 0，`a > b` 返回 1。
 * 任一侧不是**精确版本号**（范围、dist-tag、空值）返回 `undefined`——调用方必须显式处理，
 * 不给一个「看起来能比」的假答案。build 元数据按 semver §10 不参与比较。
 */
export function compareVersions(a: string | undefined, b: string | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = pa.main[i] - pb.main[i];
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/**
 * `candidate` 是否**严格新于** `installed`——市场「可更新」的版本侧判据。
 *
 * 用序比较而非字符串不等，堵的是**降级**：registry 的 dist-tags.latest 可以低于本地已装版本
 * （发布事故后 `npm dist-tag add pkg@旧版 latest` 回滚，或用户曾 `npm i pkg@next` 装过预发布版）。
 * 字符串不等会把这种情形渲染成「可更新 v<更旧的版本>」，勾选提交后 npm 真的把包换成旧版并重启。
 *
 * 版本号无法解析（范围、dist-tag、缺失）时返回 `false`：宁可不给更新按钮，也不给错的。
 */
export function isUpgrade(installed: string | undefined, candidate: string | undefined): boolean {
  return compareVersions(candidate, installed) === 1;
}
