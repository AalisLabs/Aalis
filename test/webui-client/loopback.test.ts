// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { openableLocalUrl } from '../../packages/plugin-webui-client/src/background/loopback.js';
import { setPageUrl as at, DEFAULT_PAGE_URL } from '../helpers/browser.js';

// ════════════════════════════════════════════════════════════
// 后台任务最后一行里的本机网址：页面经回环地址打开时认出来给链接，否则没有；认到空白、引号、尖括号与终端颜色码为止，
// 末尾的句末标点不算
// ════════════════════════════════════════════════════════════

afterEach(() => at(DEFAULT_PAGE_URL));

describe('本机网址', () => {
  it.each([
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    ['Server running at https://127.0.0.1:8443/app?x=1#top.', 'https://127.0.0.1:8443/app?x=1#top'],
    ['Server running at http://localhost:3000.', 'http://localhost:3000'],
    ['ready at http://localhost:3000/.', 'http://localhost:3000/'],
    ['dev server (http://localhost:3000) started', 'http://localhost:3000'],
    ['Serving HTTP on 127.0.0.1 port 8000 (http://127.0.0.1:8000/) ...', 'http://127.0.0.1:8000/'],
    ['http://localhost:3000, ready', 'http://localhost:3000'],
    ['服务已启动：http://localhost:3000，按 Ctrl+C 退出', 'http://localhost:3000'],
    ['打开 http://localhost:3000/）', 'http://localhost:3000/'],
    ['listening on http://[::1]:3000', 'http://[::1]:3000'],
    ['\u001b[36mhttp://localhost:4321/\u001b[39m ready', 'http://localhost:4321/'],
    ['see "http://localhost:8080/docs" for docs', 'http://localhost:8080/docs'],
    ['Network: http://192.168.1.5:5173/', undefined],
    ['http://localhost.example.com/', undefined],
    ['http://localhost-dev.local/', undefined],
    ['http://127.0.0.1.nip.io/', undefined],
    ['http://localhost@evil.com/', undefined],
    ['http://localhost:3000@evil.com/', undefined],
    ['nothing here', undefined],
  ])('经回环地址打开时：%j → %s', (line, url) => {
    expect(openableLocalUrl(line)).toBe(url);
  });

  it.each(['http://127.0.0.1:3000/', 'http://[::1]:3000/'])('页面经 %s 打开时同样认', page => {
    at(page);
    expect(openableLocalUrl('Local: http://localhost:5173/')).toBe('http://localhost:5173/');
  });

  it('页面从别的机器打开（局域网地址、域名）时不给', () => {
    at('http://192.168.1.5:3000/');
    expect(openableLocalUrl('Local: http://localhost:5173/')).toBeUndefined();
    at('https://aalis.example.com/');
    expect(openableLocalUrl('Local: http://localhost:5173/')).toBeUndefined();
  });
});
