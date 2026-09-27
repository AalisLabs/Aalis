import { describe, expect, it } from 'vitest';
import { configSchema, readConfig } from '../../packages/plugin-works-site/src/config.js';
import { defaultsFrom, validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// plugin-works-site 的配置：两个密钥必填且标 secret；主站网址缺省为 https://<项目名>.pages.dev，
// 只收 https 的源；生产分支不能与作品分支（p- 前缀）撞上；项目名按 Pages 的命名规则收。
// ════════════════════════════════════════════════════════════

const warnings: string[] = [];
const logger = { warn: (m: string) => warnings.push(m) };
const REQUIRED = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'placeholder-token' };

function read(raw: Record<string, unknown>) {
  return readConfig({ ...defaultsFrom(configSchema), ...raw }, logger);
}

function expectConfigError(fn: () => unknown, mention: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, `应抛配置错误（${mention}）`).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe('ConfigError');
  expect((caught as Error).message).toContain(mention);
}

describe('works-site 配置', () => {
  it('缺省值：项目 aalis、生产分支 main、主站 https://aalis.pages.dev、failOpen 为 false', () => {
    const cfg = read(REQUIRED);
    expect(cfg).toMatchObject({
      accountId: REQUIRED.accountId,
      apiToken: REQUIRED.apiToken,
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      failOpen: false,
    });
    expect(cfg.mainOrigins).toEqual(['https://aalis.pages.dev']);
    expect(cfg.siteTitle).not.toBe('');
  });

  it('两个密钥标 secret、必填；缺了按配置错误报，不回显值', () => {
    for (const key of ['accountId', 'apiToken'] as const) {
      const field = configSchema[key] as { secret?: boolean; required?: boolean };
      expect(field.secret, key).toBe(true);
      expect(field.required, key).toBe(true);
      expectConfigError(() => read({ ...REQUIRED, [key]: '' }), key);
      expectConfigError(() => read({ ...REQUIRED, [key]: undefined }), key);
    }
    expect(read({ accountId: ` ${REQUIRED.accountId} `, apiToken: ' t ' })).toMatchObject({
      accountId: REQUIRED.accountId,
      apiToken: 't',
    });
  });

  it('自定义主站网址：规范成源，主站源列表另含 <项目名>.pages.dev；不是 https 的源按配置错误报', () => {
    const cfg = read({ ...REQUIRED, siteOrigin: 'https://Works.Example.invalid/' });
    expect(cfg.siteOrigin).toBe('https://works.example.invalid');
    expect(cfg.mainOrigins).toEqual(['https://works.example.invalid', 'https://aalis.pages.dev']);
    for (const bad of [
      'http://works.example.invalid',
      'https://works.example.invalid/w/',
      'https://works.example.invalid?x=1',
      'https://user@works.example.invalid',
      'https://works.example.invalid:8443',
      'works.example.invalid',
    ]) {
      expectConfigError(() => read({ ...REQUIRED, siteOrigin: bad }), 'siteOrigin');
    }
  });

  it('项目名按 Pages 规则；生产分支不能是作品分支的形状', () => {
    expect(read({ ...REQUIRED, projectName: 'aalis-e2e-x1' }).siteOrigin).toBe('https://aalis-e2e-x1.pages.dev');
    for (const bad of ['Aalis', '-aalis', 'a/b', 'a'.repeat(59), '']) {
      expectConfigError(() => read({ ...REQUIRED, projectName: bad }), 'projectName');
    }
    expect(read({ ...REQUIRED, productionBranch: 'production' }).productionBranch).toBe('production');
    for (const bad of ['p-abcdefgh', 'P-x', 'a b', '']) {
      expectConfigError(() => read({ ...REQUIRED, productionBranch: bad }), 'productionBranch');
    }
  });

  it('写坏的开关与文字告警后取缺省', () => {
    warnings.length = 0;
    const cfg = read({ ...REQUIRED, failOpen: 'yes', siteTitle: 42 });
    expect(cfg.failOpen).toBe(false);
    expect(cfg.siteTitle).toBe(read(REQUIRED).siteTitle);
    expect(warnings.length).toBe(2);
    expect(read({ ...REQUIRED, failOpen: true, siteTitle: '  作品集标题  ', siteIntro: '简介' })).toMatchObject({
      failOpen: true,
      siteTitle: '作品集标题',
      siteIntro: '简介',
    });
  });

  it('schema 自身能过配置校验（缺省值加两个密钥）', () => {
    expect(validateConfig(configSchema, { ...defaultsFrom(configSchema), ...REQUIRED })).toEqual([]);
  });
});
