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
    expect(index).toContain('<small>');
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
