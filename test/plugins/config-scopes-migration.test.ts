import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { migratePluginConfig } from '../../tools/migrate-config-0.14.js';

describe('schema-config 0.14 作用域一次性迁移', () => {
  it('三个旧空值作用域变成空数组，包括命名实例；checkpoint 的 null 不变', () => {
    const input = `plugins:
  '@aalis/plugin-flow-control':
    scopes: null # 空范围
  '@aalis/plugin-trigger-policy:quiet':
    scopes:
  '@aalis/plugin-trigger-laya':
    scopes: null
  '@aalis/plugin-checkpoint':
    scopes: null
`;
    const result = migratePluginConfig(input);
    const plugins = parse(result.text).plugins;
    expect(result.changed).toHaveLength(3);
    expect(result.manual).toEqual([]);
    expect(plugins['@aalis/plugin-flow-control'].scopes).toEqual([]);
    expect(plugins['@aalis/plugin-trigger-policy:quiet'].scopes).toEqual([]);
    expect(plugins['@aalis/plugin-trigger-laya'].scopes).toEqual([]);
    expect(plugins['@aalis/plugin-checkpoint'].scopes).toBeNull();
    expect(result.text).toContain('# 空范围');
    expect(migratePluginConfig(result.text)).toEqual({ text: result.text, changed: [], manual: [] });
  });

  it('按各插件原分隔规则转列表，保留覆盖项和无关配置', () => {
    const result = migratePluginConfig(`plugins:
  '@aalis/plugin-flow-control':
    scopes: 'onebot:group, cli:*'
    overrides: [{scope: 'webui:*', cooldownSeconds: 0}]
  '@aalis/plugin-checkpoint':
    scopes: 'webui:* cli:*'
  '@aalis/plugin-trigger-policy':
    scopes: ''
  '@aalis/plugin-other':
    scopes: null
    apiKey: placeholder-secret
`);
    const plugins = parse(result.text).plugins;
    expect(plugins['@aalis/plugin-flow-control'].scopes).toEqual(['onebot:group', 'cli:*']);
    expect(plugins['@aalis/plugin-flow-control'].overrides).toEqual([{ scope: 'webui:*', cooldownSeconds: 0 }]);
    expect(plugins['@aalis/plugin-checkpoint'].scopes).toEqual(['webui:*', 'cli:*']);
    expect(plugins['@aalis/plugin-trigger-policy'].scopes).toEqual([]);
    expect(plugins['@aalis/plugin-other']).toEqual({ scopes: null, apiKey: 'placeholder-secret' });
    expect(JSON.stringify({ changed: result.changed, manual: result.manual })).not.toContain('placeholder-secret');
  });

  it('未配置和数组按原文本保留，复杂非法值只报告路径', () => {
    const input = `plugins:
  '@aalis/plugin-flow-control': {scopes: []}
  '@aalis/plugin-trigger-policy': {}
  '@aalis/plugin-trigger-laya': {scopes: {private: placeholder-secret}}
`;
    expect(migratePluginConfig(input)).toEqual({
      text: input,
      changed: [],
      manual: ['plugins.@aalis/plugin-trigger-laya.scopes'],
    });
  });

  it('拒绝坏 YAML 和非映射顶层，不包含原文', () => {
    expect(() => migratePluginConfig('plugins: [placeholder-secret')).toThrow('配置文件不是有效的 YAML');
    expect(() => migratePluginConfig('- placeholder-secret')).toThrow('配置文件顶层必须是映射');
  });

  it('改写会影响锚点或别名时留给人工处理', () => {
    for (const config of ['scopes: &s null', 'scopes: &s onebot:group']) {
      const source = `plugins:\n  '@aalis/plugin-flow-control': {${config}}\nother: *s\n`;
      expect(migratePluginConfig(source)).toEqual({
        text: source,
        changed: [],
        manual: ['plugins.@aalis/plugin-flow-control.scopes'],
      });
    }
    const source = `plugins:\n  '@aalis/plugin-flow-control': &shared {scopes: null}\nother: *shared\n`;
    expect(migratePluginConfig(source).manual).toEqual(['plugins.@aalis/plugin-flow-control.scopes']);
    expect(migratePluginConfig(source).text).toBe(source);
  });

  it('旧名单数组仅在能无损转回文本时自动转换，覆盖项也处理', () => {
    const result = migratePluginConfig(`plugins:
  '@aalis/plugin-trigger-policy':
    triggerNames: [Alice, Bob]
    overrides: [{scope: 'onebot:*', muteKeywords: [quiet]}]
  '@aalis/plugin-trigger-laya': {muteKeywords: ['one,two']}
`);
    const cfg = parse(result.text).plugins['@aalis/plugin-trigger-policy'];
    expect(cfg.triggerNames).toBe('Alice,Bob');
    expect(cfg.overrides[0].muteKeywords).toBe('quiet');
    expect(result.manual).toEqual(['plugins.@aalis/plugin-trigger-laya.muteKeywords']);
  });

  it('名单数字与数组成员锚点不自动改写，避免启用旧版忽略的名字或拆坏别名', () => {
    const input = `plugins:
  '@aalis/plugin-trigger-policy': {triggerNames: 123}
  '@aalis/plugin-trigger-laya': {muteKeywords: [&word quiet]}
other: *word
`;
    expect(migratePluginConfig(input)).toEqual({
      text: input,
      changed: [],
      manual: ['plugins.@aalis/plugin-trigger-policy.triggerNames', 'plugins.@aalis/plugin-trigger-laya.muteKeywords'],
    });
  });

  it('平台 think 的旧布尔值等价转成选项，MCP null 暴露范围需要人工决定', () => {
    const result = migratePluginConfig(`plugins:
  '@aalis/plugin-session-manager':
    platformProfiles: [{platform: onebot, think: true}, {platform: cli, think: false}, {platform: webui, think: null}]
  '@aalis/plugin-mcp-server': {toolGroups: null}
`);
    expect(
      parse(result.text).plugins['@aalis/plugin-session-manager'].platformProfiles.map(
        (p: { think: unknown }) => p.think,
      ),
    ).toEqual(['on', 'off', null]);
    expect(result.manual).toEqual(['plugins.@aalis/plugin-mcp-server.toolGroups']);
    expect(result.changed).toHaveLength(2);
  });

  it('命令默认检查不落盘，显式写入先备份，不输出配置值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-scopes-'));
    try {
      const file = join(dir, 'config.yaml');
      const original = `plugins:\n  '@aalis/plugin-flow-control': {scopes: null}\n  '@aalis/plugin-other': {apiKey: placeholder-secret}\n`;
      writeFileSync(file, original);
      const run = (mode: string) =>
        spawnSync(process.execPath, ['--import', 'tsx', resolve('tools/migrate-config-0.14.ts'), mode, file], {
          encoding: 'utf8',
        });
      const check = run('--check');
      expect(check.status).toBe(1);
      expect(check.stdout + check.stderr).not.toContain('placeholder-secret');
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(readdirSync(dir)).toEqual(['config.yaml']);
      const write = run('--write');
      expect(write.status).toBe(0);
      expect(write.stdout + write.stderr).not.toContain('placeholder-secret');
      expect(readFileSync(`${file}.before-schema-0.14`, 'utf8')).toBe(original);
      expect(parse(readFileSync(file, 'utf8')).plugins['@aalis/plugin-flow-control'].scopes).toEqual([]);
      expect(run('--write').status).toBe(0); // 已迁移则不重复创建备份
      writeFileSync(file, original);
      expect(run('--write').status).toBe(2); // 旧备份存在时拒绝覆盖
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(readFileSync(`${file}.before-schema-0.14`, 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入保留原权限位，不改写未转换的长字符串', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-scopes-'));
    try {
      const file = join(dir, 'config.yaml');
      // 超过 80 列且带空格：折行会让核对差异时打出与转换无关、可能含凭据的行
      const longArg = `"Authorization: Bearer ${'placeholder '.repeat(10).trim()}"`;
      const original = `plugins:\n  '@aalis/plugin-flow-control': {scopes: null}\n  '@aalis/plugin-other':\n    args: [${longArg}]\n`;
      writeFileSync(file, original);
      chmodSync(file, 0o666);
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('tools/migrate-config-0.14.ts'), '--write', file],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(statSync(file).mode & 0o777).toBe(0o666);
      expect(readFileSync(file, 'utf8')).toContain(longArg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('遇到需人工检查项时 --write 不进行部分写入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-scopes-'));
    try {
      const file = join(dir, 'config.yaml');
      const original = `plugins:\n  '@aalis/plugin-flow-control': {scopes: null}\n  '@aalis/plugin-trigger-laya': {scopes: true}\n`;
      writeFileSync(file, original);
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve('tools/migrate-config-0.14.ts'), '--write', file],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(readdirSync(dir)).toEqual(['config.yaml']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
