import { describe, expect, it } from 'vitest';
import {
  augmentInstalled,
  buildDependencyChain,
  buildSearchUrl,
  classifyPackage,
  classifySystemComponent,
  findPackageDependents,
  findServiceDependents,
  type LocalPkgInfo,
  resolveLocalInfo,
  type SystemComponent,
  sortSystemComponents,
  toLocalPackages,
  toManifest,
  toMarketplacePackages,
} from '../../packages/plugin-webui-server/src/routes/marketplace.js';

// ════════════════════════════════════════════════════════════
// 插件市场 — npm registry 检索映射（纯 npm 路线，keyword 发现）
// ════════════════════════════════════════════════════════════

describe('buildSearchUrl（单类型关键词；调用方对四类各发一条再合并 = OR）', () => {
  it('无搜索词只按该 keyword（npm 的 keywords 逗号是 AND，故不合并成一条）', () => {
    expect(buildSearchUrl('', 'aalis-util')).toBe(
      'https://registry.npmjs.org/-/v1/search?text=keywords%3Aaalis-util&size=100',
    );
  });
  it('带搜索词时 keyword + 词同时约束', () => {
    expect(decodeURIComponent(buildSearchUrl('memory', 'aalis-plugin'))).toContain('keywords:aalis-plugin memory');
  });
  it('可配 registry 基址（去尾斜杠；空值回退官方源）', () => {
    expect(buildSearchUrl('', 'aalis-api', 'https://npm.example.com/')).toBe(
      'https://npm.example.com/-/v1/search?text=keywords%3Aaalis-api&size=100',
    );
    expect(buildSearchUrl('', 'aalis-plugin', '')).toContain('registry.npmjs.org');
  });
});

describe('toMarketplacePackages（响应映射 + 已装 + 官方标注 + 富信息）', () => {
  const resp = {
    objects: [
      {
        package: { name: '@aalis/plugin-foo', version: '1.2.0', description: 'Foo', publisher: { username: 'alice' } },
      },
      { package: { name: 'someone-aalis-plugin-bar', version: '0.1.0' } }, // 社区包（非 @aalis scope）
    ],
  };

  it('映射字段 + 已装标注 + @aalis scope 判官方（无 keyword 时为空数组）', () => {
    const pkgs = toMarketplacePackages(resp, new Set(['@aalis/plugin-foo']));
    expect(pkgs[0]).toMatchObject({
      name: '@aalis/plugin-foo',
      version: '1.2.0',
      description: 'Foo',
      author: 'alice',
      installed: true,
      official: true,
      keywords: [],
    });
    expect(pkgs[1]).toMatchObject({
      name: 'someone-aalis-plugin-bar',
      version: '0.1.0',
      description: '',
      installed: false,
      official: false, // 非 @aalis scope = 社区
    });
  });

  it('提取富信息字段（下载量/评分/更新/不安全/许可/链接）并剔除 aalis-plugin 关键词', () => {
    const rich = {
      objects: [
        {
          package: {
            name: '@aalis/plugin-rich',
            version: '2.0.0',
            description: 'rich',
            keywords: ['aalis-plugin', 'memory', 'vector'],
            date: '2026-01-01T00:00:00.000Z',
            license: 'MIT',
            links: { npm: 'https://npm/x', homepage: 'https://home' },
          },
          score: { final: 0.8, detail: { quality: 0.9, popularity: 0.5, maintenance: 0.7 } },
          downloads: { monthly: 12345, weekly: 3000 },
          flags: { insecure: 1 },
          updated: '2026-06-01T00:00:00.000Z',
        },
      ],
    };
    const [p] = toMarketplacePackages(rich, new Set());
    expect(p.keywords).toEqual(['memory', 'vector']); // aalis-plugin 被剔除
    expect(p.downloads).toBe(12345);
    expect(p.updated).toBe('2026-06-01T00:00:00.000Z'); // updated 优先于 package.date
    expect(p.score).toBe(0.8);
    expect(p.insecure).toBe(true);
    expect(p.license).toBe('MIT');
    expect(p.links).toEqual({ npm: 'https://npm/x', homepage: 'https://home' });
  });

  it('空响应返回空数组（降级安全）', () => {
    expect(toMarketplacePackages({}, new Set())).toEqual([]);
    expect(toMarketplacePackages({ objects: [] }, new Set())).toEqual([]);
  });
});

describe('findServiceDependents（卸载护栏：断服务依赖检测）', () => {
  const status = [
    { name: '@aalis/plugin-llm-openai', provides: ['llm'], requiredServices: [] },
    { name: '@aalis/plugin-agent', provides: ['agent'], requiredServices: ['llm'] },
    { name: '@aalis/plugin-llm-deepseek', provides: ['llm'], requiredServices: [] },
  ];

  it('删了某服务的唯一提供者 → 列出受影响的依赖方', () => {
    const onlyProvider = [status[0], status[1]]; // 仅 openai 提供 llm，agent 需要 llm
    expect(findServiceDependents('@aalis/plugin-llm-openai', onlyProvider)).toEqual(['@aalis/plugin-agent']);
  });

  it('还有别的提供者 → 删了不致命，无依赖方阻断', () => {
    // openai 与 deepseek 都提供 llm；删 openai，deepseek 仍在
    expect(findServiceDependents('@aalis/plugin-llm-openai', status)).toEqual([]);
  });

  it('目标不提供任何服务 → 空', () => {
    expect(findServiceDependents('@aalis/plugin-agent', status)).toEqual([]);
  });
});

describe('findPackageDependents（import 依赖：谁的 deps 含 target）', () => {
  const depMap = new Map<string, string[]>([
    ['@aalis/plugin-a', ['@aalis/plugin-b', 'express']],
    ['@aalis/plugin-b', ['@aalis/util-c']],
    ['@aalis/util-c', []],
    ['@aalis/plugin-d', ['@aalis/util-c']],
  ]);
  it('列出直接 import 该包的所有包（排序、排除自身）', () => {
    expect(findPackageDependents('@aalis/util-c', depMap)).toEqual(['@aalis/plugin-b', '@aalis/plugin-d']);
    expect(findPackageDependents('@aalis/plugin-b', depMap)).toEqual(['@aalis/plugin-a']);
  });
  it('无人依赖 → 空', () => {
    expect(findPackageDependents('@aalis/plugin-a', depMap)).toEqual([]);
  });
});

describe('buildDependencyChain（import 链路树：传递、环/深度守卫、缺失中断）', () => {
  // a → b → c(util) ；d → c ；e → f(缺失，本地无)
  const depMap = new Map<string, string[]>([
    ['@aalis/plugin-a', ['@aalis/plugin-b', 'express']],
    ['@aalis/plugin-b', ['@aalis/util-c']],
    ['@aalis/util-c', []],
    ['@aalis/plugin-d', ['@aalis/util-c']],
    ['@aalis/plugin-e', ['@aalis/plugin-f']], // f 不在图中（缺失）
  ]);
  const names = (n: { children: { name: string }[] }) => n.children.map(c => c.name);

  it('upstream：传递展开依赖；第三方库（express）被 isRelevant 默认滤掉', () => {
    const t = buildDependencyChain('@aalis/plugin-a', depMap, 'upstream');
    expect(names(t)).toEqual(['@aalis/plugin-b']); // express 被滤
    expect(t.children[0].children.map(c => c.name)).toEqual(['@aalis/util-c']); // 传递到 c
  });
  it('upstream：依赖缺失 → present=false 且不再下钻（中断）', () => {
    const t = buildDependencyChain('@aalis/plugin-e', depMap, 'upstream', { isRelevant: () => true });
    expect(t.children[0]).toMatchObject({ name: '@aalis/plugin-f', present: false, children: [] });
  });
  it('downstream：谁依赖它，传递；不因 target 未装而中断', () => {
    const t = buildDependencyChain('@aalis/util-c', depMap, 'downstream');
    expect(names(t).sort()).toEqual(['@aalis/plugin-b', '@aalis/plugin-d']);
    // b 的上游依赖者是 a → 传递展开
    expect(t.children.find(c => c.name === '@aalis/plugin-b')?.children.map(c => c.name)).toEqual(['@aalis/plugin-a']);
  });
  it('downstream：target 本地未装也能查依赖者（装前场景）', () => {
    const t = buildDependencyChain('@aalis/plugin-f', depMap, 'downstream');
    expect(t.present).toBe(false);
    expect(names(t)).toEqual(['@aalis/plugin-e']); // e 依赖 f
  });
  it('环检测：a↔b 互依不死循环', () => {
    const cyclic = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const t = buildDependencyChain('a', cyclic, 'upstream', { isRelevant: () => true });
    expect(t.children[0].name).toBe('b');
    expect(t.children[0].children[0]).toMatchObject({ name: 'a', children: [] }); // 回到 a 即停
  });
  it('深度上限：maxDepth 截断', () => {
    const chain = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['d']],
    ]);
    const t = buildDependencyChain('a', chain, 'upstream', { isRelevant: () => true, maxDepth: 1 });
    expect(t.children[0]).toMatchObject({ name: 'b', children: [] }); // depth 1 即停，不展开 c
  });
});

describe('toManifest（packument → 装前能力清单）', () => {
  it('读 dist-tags.latest 版本的 aalis.service', () => {
    const packument = {
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.0.0': { description: '旧' },
        '1.2.0': {
          description: '新',
          aalis: { service: { required: ['llm'], optional: ['memory'], provides: ['x'] } },
          dependencies: { '@aalis/api-llm': 'workspace:^', zod: '^3.0.0' },
          peerDependencies: { '@aalis/core': '>=0.2.0 <1.0.0' },
        },
      },
    };
    expect(toManifest(packument)).toEqual({
      name: '',
      version: '1.2.0',
      description: '新',
      service: { required: ['llm'], optional: ['memory'], provides: ['x'] },
      dependencies: ['@aalis/api-llm', 'zod', '@aalis/core'], // deps+peer 并集去重、剔版本
    });
  });

  it('无 aalis.service / 无依赖时 service=undefined、dependencies=[]（仍返回版本/描述）', () => {
    const m = toManifest({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { description: 'd' } } });
    expect(m).toEqual({ name: '', version: '1.0.0', description: 'd', service: undefined, dependencies: [] });
  });

  it('不可信依赖键：非法包名剔除（含空格话术的伪官方名进不了装前弹窗）', () => {
    const m = toManifest({
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          dependencies: {
            '@aalis/api-llm': '^1',
            '@aalis/core 官方推荐先装此包': '^1', // 含空格的社工伪名
            '<script>alert(1)</script>': '^1',
            'valid-pkg': '^1',
          },
        },
      },
    });
    expect(m?.dependencies).toEqual(['@aalis/api-llm', 'valid-pkg']);
  });

  it('不可信依赖键：数量封顶 200（海量伪键不得淹没真依赖）', () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 500; i++) deps[`pkg-${i}`] = '^1';
    const m = toManifest({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dependencies: deps } } });
    expect(m?.dependencies).toHaveLength(200);
  });

  it('不可信 aalis.service：非字符串项被剔除，非数组归空（畸形数据不得打崩弹窗渲染）', () => {
    const m = toManifest({
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          // 对象混进 required 会让 React 渲染抛 'Objects are not valid as a React child'
          aalis: { service: { required: [{ evil: 1 }, 'llm'], provides: 'not-an-array' } as never },
        },
      },
    });
    expect(m?.service).toEqual({ required: ['llm'], provides: [] });
  });

  it('无 latest tag 返回 null（降级安全）', () => {
    expect(toManifest({})).toBeNull();
    expect(toManifest({ versions: {} })).toBeNull();
  });
});

describe('classifyPackage（按类型关键词分类）', () => {
  it('aalis-interface → 前端界面', () => {
    expect(classifyPackage(['aalis', 'aalis-interface'])).toBe('interface');
  });
  it('aalis-api → 契约', () => {
    expect(classifyPackage(['aalis', 'aalis-api'])).toBe('api');
  });
  it('aalis-util → 工具库', () => {
    expect(classifyPackage(['aalis', 'aalis-util'])).toBe('util');
  });
  it('aalis-plugin / 无类型词 → 功能插件（关键词优先，mcp-client 这类靠 aalis-plugin 判定而非名字）', () => {
    expect(classifyPackage(['aalis', 'aalis-plugin'])).toBe('plugin');
    expect(classifyPackage([])).toBe('plugin');
  });
  it('augmentInstalled：已装的 api/前端经 resolve 补判为已安装（getStatus 漏掉它们）', () => {
    // base = getStatus 仅含已加载运行时插件；api/client 带 marker 不在其中
    const base = new Set(['@aalis/plugin-llm-openai']);
    const names = ['@aalis/plugin-llm-openai', '@aalis/api-llm', '@aalis/plugin-webui-client', '@aalis/plugin-x'];
    // 模拟 node_modules：llm-api 与 webui-client 已装（可 resolve），plugin-x 未装
    const canResolve = (n: string) => n === '@aalis/api-llm' || n === '@aalis/plugin-webui-client';
    const out = augmentInstalled(names, base, canResolve);
    expect(out.has('@aalis/plugin-llm-openai')).toBe(true); // base 保留
    expect(out.has('@aalis/api-llm')).toBe(true); // 补判已装（修复"永远未安装"bug）
    expect(out.has('@aalis/plugin-webui-client')).toBe(true);
    expect(out.has('@aalis/plugin-x')).toBe(false); // 未装
    // 用于 toMarketplacePackages 时，api/client installed=true
    const pkgs = toMarketplacePackages({ objects: names.map(n => ({ package: { name: n, version: '1.0.0' } })) }, out);
    expect(pkgs.find(p => p.name === '@aalis/api-llm')?.installed).toBe(true);
    expect(pkgs.find(p => p.name === '@aalis/plugin-x')?.installed).toBe(false);
  });

  it('toMarketplacePackages 按关键词注入 category', () => {
    const pkgs = toMarketplacePackages(
      {
        objects: [
          { package: { name: '@aalis/plugin-llm-openai', version: '1.0.0', keywords: ['aalis-plugin'] } },
          { package: { name: '@aalis/api-tools', version: '1.0.0', keywords: ['aalis-api'] } },
          { package: { name: '@aalis/plugin-webui-client', version: '1.0.0', keywords: ['aalis-interface'] } },
        ],
      },
      new Set(),
    );
    expect(pkgs.map(p => p.category)).toEqual(['plugin', 'api', 'interface']);
  });
});

// ════════════════════════════════════════════════════════════
// 来源判定 —— 一个包「从哪来」由根 package.json 的依赖声明决定，不由文件路径决定。
//
// 路径判据（「解析路径含不含 node_modules」）看着能用，实则分不清两类东西：
// 直装包与传递依赖躺在同一个 node_modules 里、路径完全相同，但后者的版本由父包的
// 范围决定——市场独立升它只会和父包打架。实测（脚手架部署）：
//   @aalis/core             根声明 ^0.9.1              → node_modules/@aalis/core
//   @aalis/api-memory 不在根 dependencies（传递） → node_modules/@aalis/api-memory
// 两者路径同形，唯有根声明能把它们分开。
// ════════════════════════════════════════════════════════════

describe('resolveLocalInfo（三路信号汇总；两种部署形态各有陷阱）', () => {
  it('脚手架形态：根声明了 semver + 装在 node_modules → registry，可更新', () => {
    const info = resolveLocalInfo('^0.9.1', { version: '0.9.1', keywords: ['aalis-plugin'] }, undefined);
    expect(info?.origin).toBe('registry');
    expect(info?.version).toBe('0.9.1');
    expect(info?.request).toBe('^0.9.1');
  });

  it('脚手架形态：装在 node_modules 但不在根 dependencies → transitive（父包拉进来的）', () => {
    // 实测：@aalis/api-memory 由 plugin-memory-inmemory 引入，与直装包路径同形，
    // 只有「不在根 dependencies」这一条能把它们分开。
    expect(resolveLocalInfo(undefined, { version: '0.9.0' }, undefined)?.origin).toBe('transitive');
  });

  it('monorepo 形态：resolve 不到但扫描扫得到 → workspace，不是 transitive', () => {
    // 实测：本仓库 @aalis/plugin-commands 不在根 dependencies 且从仓库根 resolve 失败，
    // 但它是 packages/ 下的工作区源码。若沿用 classifyDepSpec(undefined) 会误判为「依赖引入」。
    const info = resolveLocalInfo(undefined, undefined, { version: '0.9.0' });
    expect(info?.origin).toBe('workspace');
    // 版本取自扫描时读到的那份 package.json。不带上它，前端的 `resolved ?? version` 兜底就会
    // 把 npm latest 当成已装版本显示——实测本仓库 93 张卡片里 91 张显示的是远端版本号。
    expect(info?.version, '工作区包的版本来自扫描').toBe('0.9.0');
  });

  it('monorepo 形态：根声明 workspace: 且能 resolve → workspace（本仓库 @aalis/core 即如此）', () => {
    expect(resolveLocalInfo('workspace:*', { version: '0.9.1' }, { version: '0.9.1' })?.origin).toBe('workspace');
  });

  it('三路都没有 → undefined（未安装）', () => {
    expect(resolveLocalInfo(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('toLocalPackages（npm 检索不可达时的降级卡片）', () => {
  const local = new Map<string, LocalPkgInfo>([
    ['@aalis/plugin-b', { version: '0.9.0', request: '^0.9.0', origin: 'registry', keywords: ['aalis-plugin'] }],
    ['@aalis/plugin-a', { version: '0.9.1', request: 'workspace:*', origin: 'workspace', keywords: ['aalis-plugin'] }],
    ['express', { version: '4.0.0', request: '^4', origin: 'registry', keywords: ['http'] }],
    ['@aalis/api-c', { version: '0.9.0', origin: 'transitive', keywords: ['aalis-api'] }],
  ]);

  it('只收带 Aalis 类型关键词的包，按名排序', () => {
    expect(toLocalPackages(local).map(p => p.name)).toEqual(['@aalis/api-c', '@aalis/plugin-a', '@aalis/plugin-b']);
  });

  it('剔掉无关第三方库（express 不该出现在插件市场里）', () => {
    expect(toLocalPackages(local).some(p => p.name === 'express')).toBe(false);
  });

  it('离线时 version 用本地版本占位，故 resolved === version → 前端不会误报「可更新」', () => {
    const a = toLocalPackages(local).find(p => p.name === '@aalis/plugin-a');
    expect(a?.version).toBe(a?.resolved);
  });

  it('如实带出 origin 与 request，供前端区分工作区 / 传递依赖 / 可更新', () => {
    const byName = new Map(toLocalPackages(local).map(p => [p.name, p]));
    expect(byName.get('@aalis/plugin-a')?.origin).toBe('workspace');
    expect(byName.get('@aalis/plugin-b')?.origin).toBe('registry');
    expect(byName.get('@aalis/api-c')?.origin).toBe('transitive');
    expect(byName.get('@aalis/api-c')?.request).toBeUndefined();
  });

  it('全部标 installed（本地扫出来的必然已装）+ 按 scope 标官方', () => {
    for (const p of toLocalPackages(local)) expect(p.installed).toBe(true);
    expect(toLocalPackages(local).every(p => p.official)).toBe(true);
  });
});

describe('toMarketplacePackages 的本地实况注入', () => {
  const data = {
    objects: [
      { package: { name: '@aalis/plugin-x', version: '1.2.0', keywords: ['aalis-plugin'] } },
      { package: { name: '@aalis/plugin-y', version: '1.0.0', keywords: ['aalis-plugin'] } },
    ],
  };

  it('version 保持 npm latest，resolved 才是本地已装版本——两者不可混同', () => {
    const pkgs = toMarketplacePackages(data, new Set(['@aalis/plugin-x']), name =>
      name === '@aalis/plugin-x' ? { version: '1.0.0', request: '^1.0.0', origin: 'registry' } : undefined,
    );
    const x = pkgs.find(p => p.name === '@aalis/plugin-x');
    expect(x?.version, 'version 必须仍是 npm latest').toBe('1.2.0');
    expect(x?.resolved, 'resolved 必须是本地已装版本').toBe('1.0.0');
  });

  it('未装的包没有 resolved / origin（前端据此不显示任何版本落后提示）', () => {
    const pkgs = toMarketplacePackages(data, new Set(), () => undefined);
    expect(pkgs.every(p => p.resolved === undefined && p.origin === undefined)).toBe(true);
  });

  it('不给 localOf 时保持旧行为（缺省参数，老调用点不受影响）', () => {
    const pkgs = toMarketplacePackages(data, new Set(['@aalis/plugin-x']));
    expect(pkgs.find(p => p.name === '@aalis/plugin-x')?.resolved).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════
// 系统组件（内核 / 宿主 / 契约 / 规范 / 工具库）
//
// 这一页与市场检索的**数据源不同**：列表只来自本地已装 + 根依赖表（不可伪造），
// 版本按精确包名查询。npm 关键词是开放命名空间，任何人都能发一个带 aalis-core
// 关键词的包——若走检索，它就能在市场里拿到一张「内核」卡片。
// ════════════════════════════════════════════════════════════

describe('classifySystemComponent（本地已装包 → 系统组件分类）', () => {
  it('五类各自命中', () => {
    expect(classifySystemComponent(['aalis', 'aalis-core'])).toBe('core');
    expect(classifySystemComponent(['aalis', 'aalis-runtime'])).toBe('runtime');
    expect(classifySystemComponent(['aalis', 'aalis-api'])).toBe('api');
    expect(classifySystemComponent(['aalis', 'aalis-schema'])).toBe('schema');
    expect(classifySystemComponent(['aalis', 'aalis-util'])).toBe('util');
  });

  it('功能插件与前端界面不属系统组件（它们在市场页可装可卸）', () => {
    expect(classifySystemComponent(['aalis', 'aalis-plugin'])).toBeUndefined();
    expect(classifySystemComponent(['aalis', 'aalis-interface'])).toBeUndefined();
  });

  it('无关键词 / undefined 一律不收', () => {
    expect(classifySystemComponent([])).toBeUndefined();
    expect(classifySystemComponent(undefined)).toBeUndefined();
    expect(classifySystemComponent(['express'])).toBeUndefined();
  });

  it('同时带多个类型词时按 core > runtime > api > schema > util 取先', () => {
    expect(classifySystemComponent(['aalis-util', 'aalis-core'])).toBe('core');
  });
});

describe('sortSystemComponents', () => {
  it('内核与宿主置顶（更新它们必须全量重启），其余按类型再按名', () => {
    const list: SystemComponent[] = [
      { name: '@aalis/util-cron', kind: 'util', origin: 'registry', updatable: false },
      { name: '@aalis/schema-message', kind: 'schema', origin: 'registry', updatable: false },
      { name: '@aalis/runtime', kind: 'runtime', origin: 'registry', updatable: false },
      { name: '@aalis/api-tools', kind: 'api', origin: 'registry', updatable: false },
      { name: '@aalis/core', kind: 'core', origin: 'registry', updatable: false },
    ];
    expect(sortSystemComponents(list).map(c => c.name)).toEqual([
      '@aalis/core',
      '@aalis/runtime',
      '@aalis/api-tools',
      '@aalis/schema-message',
      '@aalis/util-cron',
    ]);
  });

  it('同类按包名字典序，且不改写入参', () => {
    const list: SystemComponent[] = [
      { name: '@aalis/api-z', kind: 'api', origin: 'registry', updatable: false },
      { name: '@aalis/api-a', kind: 'api', origin: 'registry', updatable: false },
    ];
    const sorted = sortSystemComponents(list);
    expect(sorted.map(c => c.name)).toEqual(['@aalis/api-a', '@aalis/api-z']);
    expect(list[0].name).toBe('@aalis/api-z'); // 原数组未被排序
  });
});
