import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MINIMAL_BASE, pluginSettings, renderConfig } from '../../packages/create-aalis/src/cli.js';
import { derivePaths, initHome } from '../../packages/runtime/src/home.js';
import { isLoadablePlugin } from '../../packages/runtime/src/node-modules-loader.js';
import { defineConfig } from '../../packages/schema-config/src/index.js';
import { fieldsPlugin, startSettings } from '../fixtures/session-settings.js';

// 脚手架生成的 aalis.config.yaml：owner 专用平台（cli / webui）的平台档开箱给全部工具分组，多人平台不代开——
// 带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸（docs/concepts/security-model.md）。
// 平台档是会话设置的一层，写在配置文档的 sessionConfig 里、按插件实例嵌套，由会话设置插件读。

const CLI = '@aalis/plugin-cli';

const configOf = (enabled: Set<string>, keys = {}, ollama?: string) =>
  parse(renderConfig(pluginSettings(enabled, keys, ollama), 'zh-CN'));
const TOOLS = { '@aalis/plugin-tools': { enabledToolGroups: ['*'] } };
const OWNER_PROFILES = { platforms: { cli: TOOLS, webui: TOOLS } };

describe('create-aalis renderConfig', () => {
  it.each([
    [[CLI, '@aalis/plugin-llm-deepseek']],
    [[]],
  ])('cli、webui 两个平台档无条件写，与插件段有没有内容无关；多人平台不代开（%j）', plugins => {
    expect(configOf(new Set(plugins)).sessionConfig).toEqual(OWNER_PROFILES);
  });

  it('密钥桩照旧写在插件段', () => {
    expect(configOf(new Set([CLI, '@aalis/plugin-llm-deepseek'])).plugins['@aalis/plugin-llm-deepseek']).toEqual({
      apiKey: '',
    });
  });

  it('bare 档（空集）：仍是合法 YAML，plugins 为空对象', () => {
    const cfg = configOf(new Set());
    expect(cfg.plugins).toEqual({});
    expect(cfg.disabledPlugins).toEqual([]);
  });

  it('粘贴的 key 写进对应插件段，YAML 读出来与输入逐字相同', () => {
    const keys = ['sk-a"b', 'c\\d', 'e: f', 'g #h', "'i'", '- j', '{k}', 'ü文字'];
    for (const apiKey of keys) {
      const enabled = new Set(['@aalis/plugin-llm-deepseek', '@aalis/plugin-embedding-openai']);
      const cfg = configOf(enabled, { '@aalis/plugin-llm-deepseek': { apiKey } });
      expect(cfg.plugins['@aalis/plugin-llm-deepseek'], apiKey).toEqual({ apiKey });
      // 没粘贴的照旧留空，等用户填
      expect(cfg.plugins['@aalis/plugin-embedding-openai']).toEqual({ apiKey: '' });
    }
  });

  it('给了语言列表时写进 plugin-i18n 的插件段（按给的顺序），与别的插件段并列；没给时不写这一段', () => {
    const settings = pluginSettings(new Set([CLI, '@aalis/plugin-llm-deepseek']), {});
    const cfg = parse(renderConfig(settings, 'zh-CN', ['zh-CN', 'en']));
    expect(cfg.plugins['@aalis/plugin-i18n']).toEqual({ language: ['zh-CN', 'en'] });
    expect(cfg.plugins['@aalis/plugin-llm-deepseek']).toEqual({ apiKey: '' });
    expect(parse(renderConfig(pluginSettings(new Set(), {}), 'en', ['en'])).plugins).toEqual({
      '@aalis/plugin-i18n': { language: ['en'] },
    });
    expect(configOf(new Set([CLI])).plugins['@aalis/plugin-i18n']).toBeUndefined();
  });

  it('设了 OLLAMA_HOST 时写进已装的 Ollama 插件的 baseUrl，别的插件不带', () => {
    const enabled = new Set([
      '@aalis/plugin-llm-ollama',
      '@aalis/plugin-embedding-ollama',
      '@aalis/plugin-llm-deepseek',
    ]);
    const cfg = configOf(enabled, {}, 'http://192.0.2.1:11434');
    expect(cfg.plugins['@aalis/plugin-llm-ollama']).toEqual({ baseUrl: 'http://192.0.2.1:11434' });
    expect(cfg.plugins['@aalis/plugin-embedding-ollama']).toEqual({ baseUrl: 'http://192.0.2.1:11434' });
    expect(cfg.plugins['@aalis/plugin-llm-deepseek']).toEqual({ apiKey: '' });
    expect(configOf(enabled).plugins['@aalis/plugin-llm-ollama'], '没设时用插件自己的默认地址').toBeUndefined();
  });
});

// `--init` 建的家目录与脚手架生成的家目录写同样的平台档：两份实现（脚手架引用不了 runtime），在这里核完全相等
describe('平台档：create-aalis 与 --init 一致', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('两边写出的 sessionConfig 完全相等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-init-parity-'));
    dirs.push(dir);
    const paths = derivePaths(join(dir, 'home'), join(dir, 'app'));
    initHome(paths);
    expect(parse(readFileSync(paths.config, 'utf-8')).sessionConfig).toEqual(configOf(new Set()).sessionConfig);
  });
});

// 最小档装上会话设置插件：靠 aalis-plugin 关键词经插件发现加载，不另手动登记；--init 写出的平台档由它读到
describe('最小档带会话设置', () => {
  it('MINIMAL_BASE 在会话管理之后列出会话设置插件，它的 package.json 带 aalis-plugin 关键词', () => {
    const at = MINIMAL_BASE.indexOf('@aalis/plugin-session-settings');
    expect(at).toBe(MINIMAL_BASE.indexOf('@aalis/plugin-session-manager') + 1);
    const manifest = JSON.parse(
      readFileSync(new URL('../../packages/plugin-session-settings/package.json', import.meta.url), 'utf-8'),
    );
    expect(isLoadablePlugin(manifest)).toBe(true);
  });
});

describe('--init 写出的平台档', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('终端会话经会话设置读到工具插件在平台档里的全部工具分组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-init-profile-'));
    dirs.push(dir);
    const paths = derivePaths(join(dir, 'home'), join(dir, 'app'));
    initHome(paths);
    const tools = fieldsPlugin(
      '@aalis/plugin-tools',
      defineConfig({
        enabledToolGroups: {
          type: 'multiselect',
          label: '<工具分组>',
          allowCustom: true,
          default: [],
          session: { appliesTo: ['owner', 'room', 'task'], prominence: 'common' },
        },
      }),
    );
    const { app, sm } = await startSettings({
      doc: parse(readFileSync(paths.config, 'utf-8')),
      fields: [tools.definition],
    });
    try {
      await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });
      expect(tools.reader().get('cli-default', { platform: 'cli' }).enabledToolGroups).toEqual(['*']);
      expect(tools.reader().get('cli-default', { platform: 'onebot' }).enabledToolGroups).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
