import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderConfig } from '../../packages/create-aalis/src/cli.js';

// 脚手架生成的 aalis.config.yaml：owner 专用平台（cli / webui）的平台档开箱给全部工具分组，多人平台不代开——
// 带分组的工具默认不暴露，public 工具在群里的可达性靠这道分组闸（docs/concepts/security-model.md）。
// 平台档是会话设置的一层，写在配置文档的 sessionConfig 里，由 session-manager 读。

const platformsOf = (yaml: string): Record<string, unknown> => parse(yaml).sessionConfig?.platforms ?? {};

describe('create-aalis renderConfig', () => {
  it('装了 session-manager + cli + webui：两个平台档都给 ["*"]', () => {
    const yaml = renderConfig(
      new Set(['@aalis/plugin-session-manager', '@aalis/plugin-cli', '@aalis/plugin-webui-server']),
    );
    expect(platformsOf(yaml)).toEqual({ cli: { enabledToolGroups: ['*'] }, webui: { enabledToolGroups: ['*'] } });
    expect(parse(yaml).plugins['@aalis/plugin-session-manager'], '平台档不在插件配置里').toBeUndefined();
  });

  it('多人平台（onebot）不代开', () => {
    const yaml = renderConfig(new Set(['@aalis/plugin-session-manager', '@aalis/plugin-adapter-onebot']));
    expect(platformsOf(yaml)).toEqual({});
  });

  it('没装 session-manager 不写平台档（没人读）；密钥桩照旧', () => {
    const yaml = renderConfig(new Set(['@aalis/plugin-cli', '@aalis/plugin-llm-deepseek']));
    expect(parse(yaml).sessionConfig).toBeUndefined();
    expect(parse(yaml).plugins['@aalis/plugin-llm-deepseek']).toEqual({ apiKey: '' });
  });

  it('bare 档（空集）：仍是合法 YAML，plugins 为空对象', () => {
    const cfg = parse(renderConfig(new Set()));
    expect(cfg.plugins).toEqual({});
    expect(cfg.disabledPlugins).toEqual([]);
  });

  it('只有平台档、没有要写配置的插件：plugins 为空对象，平台档照写', () => {
    const cfg = parse(renderConfig(new Set(['@aalis/plugin-session-manager', '@aalis/plugin-cli'])));
    expect(cfg.plugins).toEqual({});
    expect(cfg.sessionConfig).toEqual({ platforms: { cli: { enabledToolGroups: ['*'] } } });
  });
});
