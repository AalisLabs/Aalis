import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpServer from '../../packages/plugin-mcp-server/src/index.js';
import { validateConfig } from '../../packages/schema-config/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// toolGroups 是分组名的字符串数组（multiselect）。此前 schema 声明成对象数组 [{ name }]，
// 与文档的 string[] 不一致：按文档写的配置每次启动都报 invalid，WebUI 编辑会把字符串展开成对象；
// 代码两种都收，null / '*' 这类裸值则在 .map 上抛 TypeError。
// 空数组 = 全部暴露，所以认不出的形态必须拒绝启动，不能退化成空数组（fail-open）。
// ════════════════════════════════════════════════════════════

function captureLogger() {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (...args: unknown[]) => void infos.push(args.map(String).join(' ')),
    warn() {},
    error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')),
    child: () => logger,
  };
  return { logger, errors, infos };
}

/** 端口上是否有人在监听 */
function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
  });
}

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

async function start(toolGroups: unknown) {
  const port = await freePort();
  const { logger, errors, infos } = captureLogger();
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  app.bind({ provide }).provide(tools, {
    getAll: () => [],
    getDefinitions: () => [],
    getSummaries: () => [],
    execute: async () => ({ content: '' }),
  } as never);
  await app.plugins.register(mcpServer, { port, bind: '127.0.0.1', toolGroups, allowRestricted: false });
  await app.plugins.idle();
  return { port, errors, infos, state: app.plugins.getPlugin(mcpServer.name)?.state };
}

describe('plugin-mcp-server toolGroups', () => {
  it('schema 接受文档写法：分组名字符串数组（含 *）', () => {
    const issues = validateConfig(mcpServer.configSchema, {
      port: 7861,
      bind: '127.0.0.1',
      toolGroups: ['search', '*'],
      allowRestricted: false,
    });
    expect(issues).toEqual([]);
  });

  it('字符串数组：正常监听', async () => {
    const r = await start(['search']);
    expect(r.errors).toEqual([]);
    expect(await isListening(r.port)).toBe(true);
  });

  for (const [label, value] of [
    ['旧版 WebUI 的 [{ name }]', [{ name: 'search' }]],
    ["裸字符串 '*'", '*'],
    ['null（YAML 裸键）', null],
    ['含非字符串元素', ['search', 1]],
  ] as const) {
    it(`${label}：报错且不监听，不退化成全部暴露`, async () => {
      const r = await start(value);
      expect(r.errors.join('\n')).toContain('toolGroups 非法');
      expect(r.state, '配置错误走日志，不把插件打进 error 态').toBe('active');
      expect(await isListening(r.port)).toBe(false);
    });
  }
});
