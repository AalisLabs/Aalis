import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckResult, type CheckSpec, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { ConfigSaveRefusedError, hostConfig, isConfigSaveRefused } from '../../packages/api-host-config/src/index.js';
import { type App, definePlugin, provide, type Services } from '../../packages/core/src/index.js';
import { createFsSecretsProvider, createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';
import { tryDispatchSubcommand } from '../../packages/runtime/src/subcommand.js';
import {
  catalogEntries,
  checkTexts,
  isTextError,
  resolveText,
  type TextRef,
} from '../../packages/schema-i18n/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime 给人看的文字
//
// 经 WebUI 显示的（配置文件与密钥文件的拒写说明、配置文档的报错、诊断项 config.secrets）带本包字典的文字对象：
// 英文读者拿到英文，中文读者拿到原文（抛错时与 message 相同），错误的类与 name 不变。
// 插件加载之前与插件体系之外打到终端的话一律英文。
// ════════════════════════════════════════════════════════════

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 错误挂着的文字对象按中文与英文读者各渲染一次 */
function rendered(err: unknown): { zh: string; en: string } {
  expect(isTextError(err), '挂着文字对象').toBe(true);
  const text = (err as { text: TextRef }).text;
  return { zh: resolveText(text, ['zh-CN']), en: resolveText(text, ['en']) };
}

it('本包字典没有问题', () => {
  const runtime = catalogEntries().find(entry => entry.ns === '@aalis/runtime');
  expect(runtime, '已登记').toBeDefined();
  expect(checkTexts(runtime!)).toEqual([]);
});

describe('拒写说明', () => {
  it.each([
    ['aalis.config.yaml', createFsYamlConfigProvider, 'config file'],
    ['secrets.yaml', createFsSecretsProvider, 'secrets file'],
  ] as const)('%s：英文读者看到英文的文件称呼，中文读者看到原文；仍是 ConfigSaveRefusedError', (name, open, label) => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-runtime-i18n-'));
    dirs.push(dir);
    const file = join(dir, name);
    writeFileSync(file, 'name: a\n');
    const { provider } = open(file);
    writeFileSync(file, 'name: b\n');
    let thrown: unknown;
    try {
      provider.save?.({ name: 'c', logLevel: 'info', plugins: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigSaveRefusedError);
    expect(isConfigSaveRefused(thrown)).toBe(true);
    const { zh, en } = rendered(thrown);
    expect(zh).toBe((thrown as Error).message);
    expect(en).toBe(
      `The ${label} has external changes that have not taken effect yet; this save was refused so they are not overwritten (${file})`,
    );
  });
});

describe('配置文档的报错与诊断项', () => {
  it('applyPluginConfig 找不到实例：英文读者看到英文，中文读者看到原文', async () => {
    const { app } = hostedApp();
    apps.push(app);
    let thrown: unknown;
    try {
      await app.bind({ hostConfig }).hostConfig.use.applyPluginConfig('nobody', {});
    } catch (err) {
      thrown = err;
    }
    const { zh, en } = rendered(thrown);
    expect(zh).toBe((thrown as Error).message);
    expect(en).toBe(
      'Plugin nobody does not exist, and no definition of the same module is available to create it (the module must be registered and declare reusable)',
    );
  });

  it('诊断项 config.secrets 的说明按读者语言显示', async () => {
    const { app, store } = hostedApp({ plugins: { p: { apiKey: { $secret: 'gone' } } } });
    apps.push(app);
    const schema = { apiKey: { type: 'string', label: 'Key', secret: true } } as const;
    await registerFromDoc(app, store, definePlugin({ name: 'p', configSchema: schema, apply() {} }));
    const checks: CheckSpec[] = [];
    app.bind({ provide }).provide.use(doctor, {
      registerCheck: (spec: CheckSpec) => {
        checks.push(spec);
        return () => {};
      },
    } as unknown as DoctorService);
    await new Promise(resolve => setTimeout(resolve, 0));
    const [result] = (await checks.find(c => c.id === 'config.secrets')?.run()) as CheckResult[];
    expect(resolveText(result!.message as TextRef, ['en'])).toBe(
      'p references secrets missing from secrets.yaml: apiKey (key gone); plugins that read their config with parseConfig fail to activate. Enter the values again in the WebUI, or add these keys to secrets.yaml',
    );
  });
});

it('未知子命令：终端里的报错是英文', async () => {
  const errors: string[] = [];
  const services = { get: () => ({ has: () => false }) } as unknown as Services;
  const code = await tryDispatchSubcommand(services, ['nope'], undefined, msg => void errors.push(msg));
  expect(code).toBe(2);
  expect(errors).toEqual([
    'Unknown subcommand "nope". A subcommand runs like /nope in chat; start without arguments to run the daemon.',
  ]);
});
