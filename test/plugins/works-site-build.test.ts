import { describe, expect, it, vi } from 'vitest';
import type { PublishedItem } from '../../packages/api-publish/src/index.js';
import { buildBranch, buildGallery } from '../../packages/plugin-works-site/src/site/build.js';
import { galleryHeaderFile } from '../../packages/plugin-works-site/src/site/headers.js';

const id = 'abcdefgabc';
const item: PublishedItem = {
  id,
  group: 'opaque',
  groupLabel: 'room',
  surfaces: ['works'],
  kind: 'html',
  title: '<script>"\u202e</iframe>',
  summary: '<img onerror="x">',
  publishedAt: Date.UTC(2026, 0, 2),
  files: [
    { path: 'index.html', size: 4, contentType: 'text/html; charset=utf-8' },
    { path: 'app.js', size: 4, contentType: 'text/javascript; charset=utf-8' },
  ],
  hasThumbnail: true,
};
const bytes = new TextEncoder().encode('data');
const readFile = vi.fn(async () => bytes);
const readThumbnail = vi.fn(async () => bytes);
const base = { items: [item], tombstones: [], nonce: 'nonce123', now: Date.UTC(2026, 0, 3), readFile, readThumbnail };
const textOf = (files: readonly { path: string; bytes: Uint8Array }[], path: string) =>
  new TextDecoder().decode(files.find(f => f.path === path)?.bytes);

describe('works site build', () => {
  it('builds a static gallery with escaped host templates and isolated iframe', async () => {
    const out = await buildGallery({
      ...base,
      siteTitle: '<script>"',
      siteIntro: '</iframe>\u202e',
      aliases: { opaque: 'https://p-abc.aalis.pages.dev' },
    });
    const paths = out.files.map(f => f.path);
    expect(paths).toContain('/index.html');
    expect(paths).toContain(`/w/${id}/index.html`);
    expect(paths).toContain(`/t/${id}.png`);
    expect(paths).toContain('/404.html');
    expect(paths).toContain('/assets/site.css');
    expect(paths).toContain('/v/nonce123.txt');
    expect(paths).not.toContain('/_worker.js');
    expect(paths).not.toContain(`/${id}/app.js`);
    const index = textOf(out.files, '/index.html');
    const wrapper = textOf(out.files, `/w/${id}/index.html`);
    expect(index).toContain(`src="/t/${id}.png" loading="lazy"`);
    expect(index).toContain('<p class="date">2026 年 1 月 2 日</p>');
    expect(index).not.toContain('<script>');
    expect(index).not.toContain('\u202e');
    expect(wrapper).toContain('<title>&lt;script&gt;&quot;&lt;/iframe&gt;</title>');
    expect(wrapper).not.toContain('<h1>');
    expect(wrapper).not.toContain('<small>');
    expect(wrapper).not.toContain('<p>');
    expect(wrapper).not.toContain('onerror');
    expect(wrapper).toContain(`sandbox="allow-scripts"`);
    expect(wrapper).toContain('referrerpolicy="no-referrer"');
    expect(wrapper).toContain(`frame-src https://p-abc.aalis.pages.dev`);
    expect(wrapper).not.toContain('</iframe>\u202e');
    expect(out.headers).toContain('X-Robots-Tag: noarchive, noimageindex');
    expect(out.headers).toContain('frame-src https://p-abc.aalis.pages.dev');
    expect(out.headers).not.toContain('Access-Control-Allow-Origin: *');
  });

  it('builds a gallery entirely below /draw/ while the isolated branch keeps its own root', async () => {
    const out = await buildGallery({
      ...base,
      basePath: '/draw/',
      siteTitle: 'Draw',
      siteIntro: '',
      aliases: { opaque: 'https://p-abc.aalis.pages.dev' },
    });
    const paths = out.files.map(file => file.path);
    expect(paths).toContain('/draw/index.html');
    expect(paths).toContain('/draw/assets/site.css');
    expect(paths).toContain(`/draw/w/${id}/index.html`);
    expect(paths).toContain(`/draw/t/${id}.png`);
    expect(paths).not.toContain(`/w/${id}/index.html`);
    const index = textOf(out.files, '/draw/index.html');
    const wrapper = textOf(out.files, `/draw/w/${id}/index.html`);
    expect(index).toContain(`href="/draw/w/${id}/"`);
    expect(index).toContain(`src="/draw/t/${id}.png"`);
    expect(index).toContain('href="/draw/assets/site.css"');
    expect(wrapper).toContain(`src="https://p-abc.aalis.pages.dev/${id}/"`);
    const branch = await buildBranch({
      ...base,
      group: 'opaque',
      mainOrigin: 'https://aalis2.example',
      mainBasePath: '/draw/',
      frameAncestors: ['https://aalis2.example'],
    });
    expect(branch?.files.map(file => file.path)).toContain(`/${id}/index.html`);
    const worker = (await import(`data:text/javascript,${encodeURIComponent(branch?.worker ?? '')}`)).default as {
      fetch(request: Request, env: { ASSETS: { fetch: (request: Request) => Promise<Response> } }): Promise<Response>;
    };
    const top = await worker.fetch(
      new Request(`https://p-abc.aalis.pages.dev/${id}/`, { headers: { 'Sec-Fetch-Dest': 'document' } }),
      { ASSETS: { fetch: async () => new Response('asset') } },
    );
    expect(top.status).toBe(302);
    expect(top.headers.get('location')).toBe(`https://aalis2.example/draw/w/${id}/`);
  });

  it('accepts main tombstones under /draw/ while building the withdrawn HTML branch', async () => {
    const out = await buildBranch({
      ...base,
      items: [],
      group: 'opaque',
      mainOrigin: 'https://aalis2.example',
      mainBasePath: '/draw/',
      frameAncestors: ['https://aalis2.example'],
      tombstones: [
        { branch: 'main', path: `/draw/w/${id}/index.html`, until: base.now + 1 },
        { branch: 'opaque', path: `/${id}/index.html`, until: base.now + 1 },
      ],
    });
    expect(textOf(out?.files ?? [], `/${id}/index.html`)).toContain('该作品已下架');
  });

  it('validates the whole manifest before reading assets', async () => {
    readFile.mockClear();
    readThumbnail.mockClear();
    await expect(
      buildBranch({
        ...base,
        group: 'opaque',
        mainOrigin: 'https://aalis.pages.dev',
        frameAncestors: ['https://aalis.pages.dev'],
        items: [item, { ...item, id: 'bad', files: item.files }],
      }),
    ).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(readThumbnail).not.toHaveBeenCalled();
  });

  it('replaces withdrawn paths with tombstones until expiry and excludes new work from a withdrawal snapshot', async () => {
    const removed = { branch: 'main', path: `/w/${id}/index.html`, until: base.now + 1 };
    const out = await buildGallery({
      ...base,
      items: [],
      tombstones: [removed],
      aliases: {},
      siteTitle: 'Works',
      siteIntro: '',
    });
    expect(textOf(out.files, removed.path)).toContain('该作品已下架');
    const expired = await buildGallery({
      ...base,
      items: [],
      tombstones: [removed],
      now: removed.until,
      aliases: {},
      siteTitle: 'Works',
      siteIntro: '',
    });
    expect(expired.files.some(f => f.path === removed.path)).toBe(false);
  });

  it('does not make a branch for a media-only group and rejects oversized headers', async () => {
    const media = {
      ...item,
      kind: 'media' as const,
      files: [{ path: 'image.png', size: 4, contentType: 'image/png' }],
    };
    expect(
      await buildBranch({
        ...base,
        items: [media],
        group: 'opaque',
        mainOrigin: 'https://aalis.pages.dev',
        frameAncestors: ['https://aalis.pages.dev'],
      }),
    ).toBeUndefined();
    expect(() => galleryHeaderFile(Array.from({ length: 150 }, (_, i) => `https://p-${i}.aalis.pages.dev`))).toThrow(
      /2000/,
    );
  });

  it('puts approved HTML files only on a branch and keeps withdrawn files as blocked tombstones', async () => {
    const branch = await buildBranch({
      ...base,
      group: 'opaque',
      mainOrigin: 'https://aalis.pages.dev',
      frameAncestors: ['https://aalis.pages.dev'],
    });
    expect(branch?.files.map(f => f.path)).toEqual([`/v/nonce123.txt`, `/${id}/index.html`, `/${id}/app.js`]);
    expect(branch?.files.some(f => f.path === '/404.html')).toBe(false);
    expect(branch?.worker).toContain(`/${id}/`);
    expect(branch?.headers).toContain('sandbox allow-scripts');
    const withdrawn = await buildBranch({
      ...base,
      items: [],
      group: 'opaque',
      mainOrigin: 'https://aalis.pages.dev',
      frameAncestors: ['https://aalis.pages.dev'],
      tombstones: [
        { branch: 'opaque', path: `/${id}/index.html`, until: base.now + 1 },
        { branch: 'opaque', path: `/${id}/app.js`, until: base.now + 1 },
      ],
    });
    expect(textOf(withdrawn?.files ?? [], `/${id}/index.html`)).toContain('该作品已下架');
    expect(textOf(withdrawn?.files ?? [], `/${id}/app.js`)).toBe('removed\n');
    expect(withdrawn?.worker).not.toContain(`"${id}":[`);
  });

  it('rejects malicious aliases before any asset read', async () => {
    readFile.mockClear();
    readThumbnail.mockClear();
    await expect(
      buildGallery({
        ...base,
        aliases: { opaque: 'https://good.aalis.pages.dev\nX-Evil: yes' },
        siteTitle: 'Works',
        siteIntro: '',
      }),
    ).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(readThumbnail).not.toHaveBeenCalled();
  });

  it.each([
    'https://good.aalis.pages.dev/path',
    'https://good.aalis.pages.dev?x=1',
    'https://user@good.aalis.pages.dev',
    'javascript:alert(1)',
    'https://good.aalis.pages.dev/" onload="evil',
  ])('rejects non-origin iframe source %s before reading assets', async origin => {
    readFile.mockClear();
    readThumbnail.mockClear();
    await expect(
      buildGallery({ ...base, aliases: { opaque: origin }, siteTitle: 'Works', siteIntro: '' }),
    ).rejects.toThrow();
    expect(readFile).not.toHaveBeenCalled();
    expect(readThumbnail).not.toHaveBeenCalled();
  });

  it('rejects an active-file tombstone collision before reading assets', async () => {
    readFile.mockClear();
    readThumbnail.mockClear();
    await expect(
      buildBranch({
        ...base,
        group: 'opaque',
        mainOrigin: 'https://aalis.pages.dev',
        frameAncestors: ['https://aalis.pages.dev'],
        tombstones: [{ branch: 'opaque', path: `/${id}/index.html`, until: base.now + 1 }],
      }),
    ).rejects.toThrow(/重复/);
    expect(readFile).not.toHaveBeenCalled();
    expect(readThumbnail).not.toHaveBeenCalled();
  });

  it.each(['PHOTO.PNG', 'MOVIE.MP4'])('serves uppercase media %s at the exact URL used by its wrapper', async path => {
    const media = {
      ...item,
      kind: 'media' as const,
      files: [{ path, size: 4, contentType: path.endsWith('.PNG') ? 'image/png' : 'video/mp4' }],
      hasThumbnail: false,
    };
    const out = await buildGallery({ ...base, items: [media], aliases: {}, siteTitle: 'Works', siteIntro: '' });
    const wrapper = textOf(out.files, `/w/${id}/index.html`);
    const src = /\bsrc="([^"]+)"/.exec(wrapper)?.[1];
    expect(src).toBeDefined();
    expect(out.files.find(file => file.path === src)?.bytes).toEqual(bytes);
  });
});

describe('works site presentation', () => {
  const site = 'https://works.example';
  const html = { ...item, title: '星空主页', summary: '一页自我介绍' };
  const gif = {
    ...item,
    id: 'bcdefghabc',
    kind: 'media' as const,
    title: '下雨的窗台',
    summary: '',
    hasThumbnail: false,
    files: [{ path: 'rain.gif', size: 4, contentType: 'image/gif' }],
  };

  it('index lists cards newest first with kind, date and summary, plus share info with absolute URLs', async () => {
    const out = await buildGallery({
      ...base,
      items: [gif, { ...html, publishedAt: gif.publishedAt + 1 }],
      aliases: { opaque: 'https://p-abc.aalis.pages.dev' },
      siteTitle: '她的作品',
      siteIntro: '群友出点子',
      siteOrigin: site,
    });
    const index = textOf(out.files, '/index.html');
    expect(index.indexOf('星空主页')).toBeLessThan(index.indexOf('下雨的窗台'));
    expect(index).toContain('<span class="kind">网页</span>');
    expect(index).toContain('<span class="kind">动图</span>');
    expect(index).toContain('<p class="sum">一页自我介绍</p>');
    expect(index).toContain('共 2 件');
    // 没有缩略图的作品用标题首字作封面
    expect(index).toMatch(/<div class="thumb tone-\d"><span class="glyph">下<\/span>/);
    expect(index).toContain('<meta property="og:title" content="她的作品">');
    expect(index).toContain('<meta property="og:description" content="群友出点子">');
    expect(index).toContain(`<meta property="og:url" content="${site}/">`);
    expect(index).toContain(`<meta property="og:image" content="${site}/t/${id}.png">`);
  });

  it('work page shares title and thumbnail but not the summary, and still shows nothing around the work', async () => {
    const out = await buildGallery({
      ...base,
      items: [html],
      aliases: { opaque: 'https://p-abc.aalis.pages.dev' },
      siteTitle: 'Works',
      siteIntro: '',
      siteOrigin: site,
      basePath: '/draw/',
    });
    const wrapper = textOf(out.files, `/draw/w/${id}/index.html`);
    expect(wrapper).toContain('<meta property="og:title" content="星空主页">');
    expect(wrapper).toContain(`<meta property="og:url" content="${site}/draw/w/${id}/">`);
    expect(wrapper).toContain(`<meta property="og:image" content="${site}/draw/t/${id}.png">`);
    expect(wrapper).not.toContain('og:description');
    expect(wrapper).not.toContain('一页自我介绍');
    expect(wrapper).not.toMatch(/<h1|<p[ >]/);
  });

  it('empty gallery says so; without a site origin no absolute share URLs are written', async () => {
    const out = await buildGallery({ ...base, items: [], aliases: {}, siteTitle: 'Works', siteIntro: '' });
    const index = textOf(out.files, '/index.html');
    expect(index).toContain('还没有作品');
    expect(index).not.toContain('og:url');
    expect(index).not.toContain('og:image');
    expect(index).not.toContain('name="description"');
  });

  it('404 and the main-site removed page link back to the gallery; the branch removed page does not', async () => {
    const gallery = await buildGallery({
      ...base,
      items: [],
      aliases: {},
      siteTitle: 'Works',
      siteIntro: '',
      basePath: '/draw/',
      tombstones: [{ branch: 'main', path: `/draw/w/${id}/index.html`, until: base.now + 1 }],
    });
    expect(textOf(gallery.files, '/draw/404.html')).toContain('<a href="/draw/">');
    const removed = textOf(gallery.files, `/draw/w/${id}/index.html`);
    expect(removed).toContain('该作品已下架');
    expect(removed).toContain('<a href="/draw/">');
    expect(removed).toContain('href="/draw/assets/site.css"');
    const branch = await buildBranch({
      ...base,
      items: [],
      group: 'opaque',
      mainOrigin: 'https://aalis.pages.dev',
      frameAncestors: ['https://aalis.pages.dev'],
      tombstones: [{ branch: 'opaque', path: `/${id}/index.html`, until: base.now + 1 }],
    });
    const framed = textOf(branch?.files ?? [], `/${id}/index.html`);
    expect(framed).toContain('该作品已下架');
    expect(framed).not.toContain('<a ');
    expect(framed).not.toContain('stylesheet');
  });

  it('rejects a malformed site origin before reading assets', async () => {
    readFile.mockClear();
    await expect(
      buildGallery({
        ...base,
        aliases: { opaque: 'https://p-abc.aalis.pages.dev' },
        siteTitle: 'W',
        siteIntro: '',
        siteOrigin: 'https://works.example/x',
      }),
    ).rejects.toThrow(/来源不合法/);
    expect(readFile).not.toHaveBeenCalled();
  });
});
