import puppeteer from 'puppeteer';
import { describe, expect, it } from 'vitest';
import type { PublishedItem } from '../../packages/api-publish/src/index.js';
import { SITE_CSS, wrapperPage } from '../../packages/plugin-works-site/src/site/templates.js';

const item: PublishedItem = {
  id: 'abcdefgabc',
  group: 'room',
  groupLabel: 'room',
  surfaces: ['works'],
  kind: 'html',
  title: 'The work',
  summary: 'A private summary',
  publishedAt: Date.UTC(2026, 0, 2),
  files: [{ path: 'index.html', size: 4, contentType: 'text/html' }],
  hasThumbnail: false,
};

function withInlineCss(html: string): string {
  return html.replace(/<link rel="stylesheet" href="[^"]+">/, `<style>${SITE_CSS}</style>`);
}

describe('works site work viewport', () => {
  it('gives the HTML frame the whole viewport without host page scrolling or visible metadata', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP * 127.0.0.1:1'],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      await page.setContent(withInlineCss(wrapperPage(item, 'https://p-abc.example')));
      const layout = await page.evaluate(() => {
        const frame = document.querySelector('iframe')!;
        const rect = frame.getBoundingClientRect();
        return {
          title: document.title,
          iframeTitle: frame.title,
          width: rect.width,
          height: rect.height,
          x: rect.x,
          y: rect.y,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          text: document.body.textContent,
        };
      });
      expect(layout).toMatchObject({
        title: item.title,
        iframeTitle: item.title,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        scrollWidth: 1280,
        scrollHeight: 720,
      });
      expect(layout.text).not.toContain(item.title);
      expect(layout.text).not.toContain(item.summary);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('fits a portrait image inside the viewport without scrolling or visible metadata', async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      const media = {
        ...item,
        kind: 'media' as const,
        files: [{ path: 'portrait.png', size: 4, contentType: 'image/png' }],
      };
      const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"/>')}`;
      const html = withInlineCss(wrapperPage(media)).replace('src="/m/abcdefgabc.png"', `src="${image}"`);
      await page.setContent(html);
      await page.waitForFunction(() => (document.querySelector('img') as HTMLImageElement)?.complete);
      const layout = await page.evaluate(() => {
        const rect = document.querySelector('img')!.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          x: rect.x,
          y: rect.y,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          text: document.body.textContent,
        };
      });
      expect(layout.width).toBeCloseTo(405);
      expect(layout).toMatchObject({ height: 720, x: 437.5, y: 0, scrollWidth: 1280, scrollHeight: 720 });
      expect(layout.text).not.toContain(item.title);
      expect(layout.text).not.toContain(item.summary);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
