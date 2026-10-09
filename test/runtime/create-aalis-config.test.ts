import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { pluginSettings, renderConfig } from '../../packages/create-aalis/src/cli.js';
import { derivePaths, initHome } from '../../packages/runtime/src/home.js';

// 脚手架生成的 aalis.config.yaml：owner 专用平台（cli / webui）的平台档开箱给全部工具分组，多人平台不代开——
// 带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸（docs/concepts/security-model.md）。
// 平台档是会话设置的一层，写在配置文档的 sessionConfig 里，由 session-manager 读。

const SESSION_MANAGER = '@aalis/plugin-session-manager';
const CLI = '@aalis/plugin-cli';
const WEBUI = '@aalis/plugin-webui-server';
const ONEBOT = '@aalis/plugin-adapter-onebot';

const configOf = (enabled: Set<string>, keys = {}, ollama?: string) =>
  parse(renderConfig(pluginSettings(enabled, keys, ollama)));
const OWNER_PROFILES = { platforms: { cli: { enabledToolGroups: ['*'] }, webui: { enabledToolGroups: ['*'] } } };

describe('create-aalis renderConfig', () => {
  it.each([
    [[SESSION_MANAGER, CLI, WEBUI]],
    [[SESSION_MANAGER, ONEBOT]],
    [[CLI, '@aalis/plugin-llm-deepseek']],
    [[]],
  ])('cli、webui 两个平台档无条件写，与装了哪些插件无关；多人平台不代开（%j）', plugins => {
    const cfg = configOf(new Set(plugins));
    expect(cfg.sessionConfig).toEqual(OWNER_PROFILES);
    expect(cfg.plugins[SESSION_MANAGER], '平台档不在插件配置里').toBeUndefined();
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

  it.each([
    ['还没有 package.json', undefined],
    ['装了会话管理与终端', { dependencies: { [SESSION_MANAGER]: '^0.1.0', [CLI]: '^0.1.0' } }],
    ['只装了多人平台', { dependencies: { [ONEBOT]: '^0.1.0' } }],
  ])('%s', (_label, manifest) => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-init-parity-'));
    dirs.push(dir);
    const app = join(dir, 'app');
    mkdirSync(app);
    if (manifest) writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
    const paths = derivePaths(join(dir, 'home'), app);
    initHome(paths);
    expect(parse(readFileSync(paths.config, 'utf-8')).sessionConfig).toEqual(configOf(new Set()).sessionConfig);
  });
});
