/**
 * api-publish — 发布契约
 *
 *  1. publicPathProblem：公开路径白名单（段字符与首字符、段数、总长、保留名、扩展名、index.html），
 *     拒绝原因只写类别、不回显路径（路径来自远端给的文件名，原因会经工具回执进模型上下文）
 *  2. workHeaders：作品文件的响应头。CSP 沙箱只给 allow-scripts，外发面全关，作用域两种写法；
 *     拼进头里的来源按语法核对，带分号、换行的值拼不进去
 *  3. galleryHeaders：主站与包装页的响应头，frame-src 恰为给定列表
 *  4. publish 绑定门面：经它登记的 onChange、attachSurface 随消费方激活撤回；撤回后 live 不再送到提供者、
 *     health 不再被读；提供者换人时整批重挂，同一个 live 句柄跟到新提供者
 *
 * 门面部分只走公开入口：桩提供者插件与最小消费者插件经 app.plugin 装载。
 */
import { App, definePlugin, optional, provide } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BoundPublish,
  galleryHeaders,
  PUBLIC_CONTENT_TYPES,
  type PublishService,
  type PublishSurface,
  publicPathProblem,
  publish,
  WORK_IFRAME_SANDBOX,
  workHeaders,
} from '../../packages/api-publish/src/index.js';

// ===== 公开路径 =====

describe('publicPathProblem', () => {
  const legal = [
    'index.html',
    'js/app.js',
    'img/a.PNG',
    'style.css',
    'mod/entry.mjs',
    'data/level-1.json',
    'img/photo.jpg',
    'img/photo.jpeg',
    'img/anim.gif',
    'img/pic.webp',
    'img/icon.svg',
    'media/clip.mp4',
    'fonts/f.woff2',
    'a/b/c/d.css',
    'v1.0_final-cut.js',
    // 4 段、每段不超过 64 字符、总长恰好 200
    `${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}/d.css`,
  ];
  it.each(legal)('合法：%s', path => {
    expect(publicPathProblem(path)).toBeUndefined();
  });

  const illegal = [
    '',
    '/a',
    'a/',
    'a//b',
    '../a',
    'a/../b.js',
    'a/./b.js',
    '.a',
    // 只有首字符规则拦得住的三条：扩展名合法、字符集合法，只是以点、下划线、连字符开头
    '.hidden.css',
    '_private.js',
    '-dash.png',
    '_headers',
    '_redirects',
    '_worker.js',
    'a/_routes.json',
    '.assetsignore',
    'functions/x.js',
    'Functions/x.js',
    'a b.js',
    '中文.png',
    'a\\b.js',
    'x.wasm',
    'x.mp3',
    'noext',
    'trailing.',
    'sub/index.html',
    'page.html',
    'INDEX.HTML',
    'a/b/c/d/e.css',
    `${'x'.repeat(65)}.css`,
    // 段数与每段长度都合法，总长 205
    `${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}/dddddd.css`,
    // 扩展名撞上 Object.prototype 的键：白名单查表不能沿原型链取到东西
    'x.constructor',
    'x.__proto__',
  ];
  it.each(illegal.map(p => [JSON.stringify(p), p]))('拒绝：%s', (_label, path) => {
    const reason = publicPathProblem(path);
    expect(reason, `${JSON.stringify(path)} 应被拒`).toBeTypeOf('string');
    expect(reason).not.toBe('');
    // 空串是任何字符串的子串，只对非空输入判回显
    if (path !== '') expect(reason, '原因只写类别，不回显路径').not.toContain(path);
  });

  it('白名单查表不沿原型链', () => {
    expect(Object.getPrototypeOf(PUBLIC_CONTENT_TYPES)).toBeNull();
    expect(Object.isFrozen(PUBLIC_CONTENT_TYPES)).toBe(true);
  });

  it('白名单恰为约定的 13 种扩展名，不含 wasm 与音频', () => {
    expect(Object.keys(PUBLIC_CONTENT_TYPES).sort()).toEqual(
      ['css', 'gif', 'html', 'jpeg', 'jpg', 'js', 'json', 'mjs', 'mp4', 'png', 'svg', 'webp', 'woff2'].sort(),
    );
    expect(PUBLIC_CONTENT_TYPES.png).toBe('image/png');
    expect(PUBLIC_CONTENT_TYPES.mp4).toBe('video/mp4');
    expect(PUBLIC_CONTENT_TYPES.woff2).toBe('font/woff2');
    expect(PUBLIC_CONTENT_TYPES.html).toMatch(/^text\/html\b/);
  });
});

// ===== 响应头 =====

/** CSP 拆成「指令名 → 值列表」；同名指令出现两次视为错误（浏览器只认第一个，第二个是注入的迹象） */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    if (out.has(name)) throw new Error(`CSP 指令重复：${name}`);
    out.set(name, values);
  }
  return out;
}

describe('workHeaders', () => {
  const ALIAS = 'https://p-abcdefgh.aalis.pages.dev';
  const ANCESTORS = ['https://aalis.pages.dev', 'https://works.example.org'];

  it('作用域写成本作品目录：CSP 逐条指令恰为约定值', () => {
    const h = workHeaders({ scope: { origin: ALIAS, basePath: '/abcdefghij/' }, frameAncestors: ANCESTORS });
    const s = `${ALIAS}/abcdefghij/`;
    expect(Object.fromEntries(directives(h['Content-Security-Policy']))).toEqual({
      sandbox: ['allow-scripts'],
      'default-src': ["'none'"],
      'script-src': ["'unsafe-inline'", 'blob:', 'data:', s],
      'style-src': ["'unsafe-inline'", 'data:', s],
      'img-src': ['data:', 'blob:', s],
      'media-src': ['data:', 'blob:', s],
      'font-src': ['data:', s],
      'connect-src': ["'none'"],
      'form-action': ["'none'"],
      'base-uri': ["'none'"],
      'frame-ancestors': ANCESTORS,
    });
  });

  it("作用域写成 'self'（_headers 底层）", () => {
    const h = workHeaders({ scope: 'self', frameAncestors: ANCESTORS });
    const d = directives(h['Content-Security-Policy']);
    for (const name of ['script-src', 'style-src', 'img-src', 'media-src', 'font-src']) {
      expect(d.get(name), name).toContain("'self'");
    }
    expect(d.get('frame-ancestors')).toEqual(ANCESTORS);
  });

  it('沙箱只给脚本：不给同源、顶层导航、弹窗与表单', () => {
    const csp = workHeaders({ scope: 'self', frameAncestors: ANCESTORS })['Content-Security-Policy'];
    expect(directives(csp).get('sandbox')).toEqual([WORK_IFRAME_SANDBOX]);
    expect(WORK_IFRAME_SANDBOX).toBe('allow-scripts');
    for (const token of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals']) {
      expect(csp, token).not.toContain(token);
    }
  });

  it('头恰为六个：含匿名模块资源 CORS、Vary 与 DNS 预取开关，不带 CORP', () => {
    const h = workHeaders({ scope: 'self', frameAncestors: ANCESTORS });
    expect(Object.keys(h).sort()).toEqual(
      [
        'Access-Control-Allow-Origin',
        'Content-Security-Policy',
        'Referrer-Policy',
        'Vary',
        'X-Content-Type-Options',
        'X-DNS-Prefetch-Control',
      ].sort(),
    );
    expect(h['Access-Control-Allow-Origin']).toBe('*');
    expect(h.Vary).toBe('Sec-Fetch-Dest');
    expect(h['X-DNS-Prefetch-Control']).toBe('off');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it("frame-ancestors 为空列表时写 'none'，不留空指令", () => {
    const d = directives(workHeaders({ scope: 'self', frameAncestors: [] })['Content-Security-Policy']);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('本机隔离预览的写法：http 回环源加令牌目录', () => {
    const origin = 'http://127.0.0.1:43210';
    const h = workHeaders({
      scope: { origin, basePath: '/0123456789abcdef0123456789abcdef/w/' },
      frameAncestors: [origin],
    });
    const d = directives(h['Content-Security-Policy']);
    expect(d.get('img-src')).toContain(`${origin}/0123456789abcdef0123456789abcdef/w/`);
    expect(d.get('frame-ancestors')).toEqual([origin]);
  });

  it.each([
    [
      'frame-ancestors 带分号',
      { scope: 'self' as const, frameAncestors: ["https://a.example; script-src 'unsafe-eval'"] },
    ],
    ['frame-ancestors 带换行', { scope: 'self' as const, frameAncestors: ['https://a.example\nX-Injected: 1'] }],
    ['frame-ancestors 带空格', { scope: 'self' as const, frameAncestors: ['https://a.example *'] }],
    ['frame-ancestors 带路径', { scope: 'self' as const, frameAncestors: ['https://a.example/x'] }],
    ['frame-ancestors 是通配', { scope: 'self' as const, frameAncestors: ['*'] }],
    ['作用域源带分号', { scope: { origin: 'https://a.example;', basePath: '/x/' }, frameAncestors: [] }],
    ['作用域源不是 http(s)', { scope: { origin: 'javascript:alert(1)', basePath: '/x/' }, frameAncestors: [] }],
    ['作用域目录缺尾斜杠', { scope: { origin: 'https://a.example', basePath: '/x' }, frameAncestors: [] }],
    ['作用域目录带空格', { scope: { origin: 'https://a.example', basePath: '/x y/' }, frameAncestors: [] }],
    [
      '作用域目录带分号',
      { scope: { origin: 'https://a.example', basePath: "/x/;script-src 'self'/" }, frameAncestors: [] },
    ],
    ['作用域目录带点段', { scope: { origin: 'https://a.example', basePath: '/../' }, frameAncestors: [] }],
  ])('拼不进去：%s', (_label, params) => {
    // 按原因匹配：函数缺失时的 TypeError 也算「抛了」，只写 toThrow() 在实现之前就会恒过
    expect(() => workHeaders(params)).toThrow(/拼不进响应头/);
  });
});

describe('galleryHeaders', () => {
  it('frame-src 恰为给定列表；其余指令恰为约定值', () => {
    const origins = ['https://p-abcdefgh.aalis.pages.dev', 'https://p-ijklmnop.aalis.pages.dev'];
    const h = galleryHeaders({ frameOrigins: origins });
    expect(Object.fromEntries(directives(h['Content-Security-Policy']))).toEqual({
      'default-src': ["'none'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'media-src': ["'self'"],
      'frame-src': origins,
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
    expect(Object.keys(h).sort()).toEqual(['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options']);
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it("没有网页作品时 frame-src 为 'none'", () => {
    const d = directives(galleryHeaders({ frameOrigins: [] })['Content-Security-Policy']);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('来源带分号或换行时拼不进去', () => {
    expect(() => galleryHeaders({ frameOrigins: ["https://a.example; script-src 'self'"] })).toThrow(/拼不进响应头/);
    expect(() => galleryHeaders({ frameOrigins: ['https://a.example\r\nSet-Cookie: x=1'] })).toThrow(/拼不进响应头/);
  });
});

// ===== 绑定门面 =====

/** 桩提供者：记录登记的展示面、收到的上线回报与变更订阅 */
function makeProvider() {
  const listeners = new Set<() => void>();
  const surfaces = new Set<PublishSurface>();
  const live: Array<{ surface: string; ids: string[] }> = [];
  const svc: PublishService = {
    listSurfaces: () => [...surfaces].map(surface => ({ name: surface.name, available: true })),
    nominate: async () => ({ refused: '桩' }),
    get: () => undefined,
    listPublished: () => [],
    readFile: async () => new Uint8Array(),
    readThumbnail: async () => new Uint8Array(),
    withdraw: async () => ({ refused: '桩' }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachSurface(surface) {
      surfaces.add(surface);
      return {
        // 有意不看是否已 detach：撤回后 live 不再生效要由门面保证，不靠提供者自觉
        live: ids => {
          live.push({ surface: surface.name, ids: [...ids] });
        },
        detach: () => {
          surfaces.delete(surface);
        },
      };
    },
  };
  return {
    svc,
    surfaces,
    live,
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    /** 提供者读一遍全部已登记展示面的 health（发布服务在提名与撤下时就是这样读的） */
    readHealth: () => [...surfaces].map(s => s.health()),
  };
}

function providerPlugin(name: string, svc: PublishService, priority?: number) {
  return definePlugin({
    name,
    provides: [publish],
    uses: { provide },
    apply(caps) {
      caps.provide(publish, svc, priority === undefined ? undefined : { priority });
    },
  });
}

/** 最小消费者：交出这次激活的 publish 门面。optional，提供者后到的情形也能激活 */
async function loadConsumer(app: App, name: string): Promise<BoundPublish> {
  let bound: BoundPublish | undefined;
  await app.plugin(
    definePlugin({
      name,
      uses: { publish: optional(publish) },
      apply(caps) {
        bound = caps.publish;
      },
    }),
  );
  await app.plugins.idle();
  if (app.plugins.getPlugin(name)?.state !== 'active') throw new Error(`消费者 "${name}" 未激活`);
  if (!bound) throw new Error(`消费者 "${name}" 未交出 publish 门面`);
  return bound;
}

/** 展示面桩：记录 health 被读的次数 */
function surfaceStub(name = 'works') {
  const counter = { healthReads: 0 };
  const surface: PublishSurface = {
    name,
    urlFor: id => `https://works.example.org/w/${id}/`,
    health: () => {
      counter.healthReads++;
      return { ok: true };
    },
  };
  return { surface, counter };
}

let app: App;

beforeEach(() => {
  app = new App({ name: 'T', logLevel: 'error' });
});

afterEach(async () => {
  await app.stop();
});

describe('publish 门面 — 随消费方激活撤回', () => {
  it('消费方卸载后：变更不再送到它，它的 health 不再被读，它的 live 不再送到提供者', async () => {
    const p = makeProvider();
    await app.plugin(providerPlugin('stub-publish', p.svc));
    const bound = await loadConsumer(app, 'consumer-site');

    let changes = 0;
    bound.onChange(() => {
      changes++;
    });
    const { surface, counter } = surfaceStub();
    const binding = bound.attachSurface(surface);

    p.emit();
    expect(p.readHealth()).toEqual([{ ok: true }]);
    binding.live(['aaaaaaaaaa']);
    expect(changes).toBe(1);
    expect(counter.healthReads).toBe(1);
    expect(p.live).toEqual([{ surface: 'works', ids: ['aaaaaaaaaa'] }]);

    await app.plugins.unload('consumer-site');

    p.emit();
    p.readHealth();
    binding.live(['bbbbbbbbbb']);
    expect(changes, '撤回后的变更不该再送到已关闭的消费方').toBe(1);
    expect(counter.healthReads, '撤回后提供者不该再读到这个展示面').toBe(1);
    expect(p.surfaces.size).toBe(0);
    expect(p.live, '撤回后的上线回报不该送到提供者').toEqual([{ surface: 'works', ids: ['aaaaaaaaaa'] }]);
  });

  it('卸载一个消费方不牵连另一个', async () => {
    const p = makeProvider();
    await app.plugin(providerPlugin('stub-publish', p.svc));
    const a = await loadConsumer(app, 'consumer-a');
    const b = await loadConsumer(app, 'consumer-b');
    let aChanges = 0;
    let bChanges = 0;
    a.onChange(() => {
      aChanges++;
    });
    b.onChange(() => {
      bChanges++;
    });
    a.attachSurface(surfaceStub('works').surface);
    const bBinding = b.attachSurface(surfaceStub('gallery').surface);

    await app.plugins.unload('consumer-a');
    p.emit();
    bBinding.live(['cccccccccc']);

    expect(aChanges).toBe(0);
    expect(bChanges).toBe(1);
    expect([...p.surfaces].map(s => s.name)).toEqual(['gallery']);
    expect(p.live).toEqual([{ surface: 'gallery', ids: ['cccccccccc'] }]);
  });

  it('手动退订与 detach：立即撤回，重复调用无副作用', async () => {
    const p = makeProvider();
    await app.plugin(providerPlugin('stub-publish', p.svc));
    const bound = await loadConsumer(app, 'consumer-site');
    let changes = 0;
    const off = bound.onChange(() => {
      changes++;
    });
    const binding = bound.attachSurface(surfaceStub().surface);

    off();
    off();
    binding.detach();
    binding.detach();
    p.emit();
    binding.live(['dddddddddd']);

    expect(changes).toBe(0);
    expect(p.surfaces.size).toBe(0);
    expect(p.live).toEqual([]);
  });

  it('同一激活同名再登记：替换旧的，旧句柄的 live 不再生效', async () => {
    const p = makeProvider();
    await app.plugin(providerPlugin('stub-publish', p.svc));
    const bound = await loadConsumer(app, 'consumer-site');
    const first = surfaceStub('works');
    const second = surfaceStub('works');
    const oldBinding = bound.attachSurface(first.surface);
    const newBinding = bound.attachSurface(second.surface);

    expect([...p.surfaces]).toEqual([second.surface]);
    oldBinding.live(['eeeeeeeeee']);
    newBinding.live(['ffffffffff']);
    expect(p.live).toEqual([{ surface: 'works', ids: ['ffffffffff'] }]);
    // 旧句柄的 detach 不能撤掉替换它的那条
    oldBinding.detach();
    expect([...p.surfaces]).toEqual([second.surface]);
  });
});

describe('publish 门面 — 提供者后到与换人', () => {
  it('提供者后到：先登记的挂在账上，上线后补登记；之前的 live 不排队', async () => {
    const bound = await loadConsumer(app, 'consumer-site');
    expect(bound.current).toBeUndefined();
    let changes = 0;
    bound.onChange(() => {
      changes++;
    });
    const binding = bound.attachSurface(surfaceStub().surface);
    binding.live(['gggggggggg']);

    const p = makeProvider();
    await app.plugin(providerPlugin('stub-publish', p.svc));
    await app.plugins.idle();

    expect(p.surfaces.size).toBe(1);
    expect(p.live, '提供者不在场时的回报丢弃，不补发').toEqual([]);
    p.emit();
    binding.live(['hhhhhhhhhh']);
    expect(changes).toBe(1);
    expect(p.live).toEqual([{ surface: 'works', ids: ['hhhhhhhhhh'] }]);
  });

  it('提供者换人：整批从旧的撤下、重挂到新的，同一个 live 句柄跟到新提供者', async () => {
    const first = makeProvider();
    const second = makeProvider();
    await app.plugin(providerPlugin('stub-publish-a', first.svc));
    const bound = await loadConsumer(app, 'consumer-site');
    let changes = 0;
    bound.onChange(() => {
      changes++;
    });
    const binding = bound.attachSurface(surfaceStub().surface);
    expect(first.surfaces.size).toBe(1);

    await app.plugin(providerPlugin('stub-publish-b', second.svc, 10));
    await app.plugins.idle();

    expect(first.surfaces.size, '旧提供者上的展示面应已撤下').toBe(0);
    expect(second.surfaces.size, '展示面应重挂到新提供者').toBe(1);
    first.emit();
    second.emit();
    expect(changes, '只收新提供者的变更').toBe(1);
    binding.live(['iiiiiiiiii']);
    expect(first.live).toEqual([]);
    expect(second.live).toEqual([{ surface: 'works', ids: ['iiiiiiiiii'] }]);
  });
});
