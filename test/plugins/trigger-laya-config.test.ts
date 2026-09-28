import { describe, expect, it } from 'vitest';
import { trigger } from '../../packages/api-trigger/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import { configSchema, normalizeConfig } from '../../packages/plugin-trigger-laya/src/config.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

const readConfig = (raw: unknown) => normalizeConfig(parseConfig(configSchema, raw));

describe('trigger-laya 配置解析', () => {
  it('保留默认 sidecar 管理方式、阈值哨兵与逗号名单派生', () => {
    expect(readConfig({})).toMatchObject({
      endpoint: 'http://127.0.0.1:17878',
      sidecarDir: '',
      scopes: ['*:group'],
      triggerNames: [],
      muteKeywords: [],
    });
    expect(readConfig({}).threshold).toBeUndefined();
    expect(
      readConfig({
        endpoint: ' http://127.0.0.1:17879/ ',
        sidecarDir: ' /tmp/fake-sidecar/ ',
        triggerNames: 'a, b',
        muteKeywords: '静音\n停止',
        muteTimeSeconds: 0,
        overrides: [{ scope: ' onebot:group ', threshold: null }, { scope: '   ' }],
      }),
    ).toMatchObject({
      endpoint: 'http://127.0.0.1:17879',
      sidecarDir: '/tmp/fake-sidecar',
      triggerNames: ['a', 'b'],
      muteKeywords: ['静音', '停止'],
      muteTimeSeconds: 60,
      overrides: [{ scope: 'onebot:group' }],
    });
  });

  it('scopes 的 null 取默认，空数组保持空，空白成员被丢弃；坏地址提前拒绝', () => {
    expect(readConfig({ scopes: null }).scopes).toEqual(['*:group']);
    expect(readConfig({ scopes: [] }).scopes).toEqual([]);
    expect(readConfig({ scopes: ['   ', 'onebot:group'] }).scopes).toEqual(['onebot:group']);
    expect(readConfig({ scopes: 'onebot:group,cli:*' }).scopes).toEqual(['*:group']);
    for (const endpoint of [{ host: 'bad' }, 'ftp://localhost/path', 'http://localhost/?key=secret']) {
      const err = (() => {
        try {
          readConfig({ endpoint });
        } catch (e) {
          return e as Error;
        }
        throw new Error('预期地址错误');
      })();
      expect(err.message).toContain('endpoint');
      expect(err.message).not.toContain('secret');
    }
  });

  it('真实 App 激活在注册 trigger 服务前拒绝无效 endpoint', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    try {
      await registerHubs(app);
      await app.plugins.register(layaPlugin, { endpoint: { host: 'bad' }, sidecarDir: '/tmp/fake-sidecar' });
      await app.plugins.idle();
      expect(app.plugins.getPlugin(layaPlugin.name)?.state).toBe('error');
      expect(app.bind({ services }).services.get(trigger)).toBeUndefined();
    } finally {
      await app.stop();
    }
  });
});
