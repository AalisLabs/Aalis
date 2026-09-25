import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { LogHub } from '../../packages/core/src/index.js';
import { createConfigStore } from '../../packages/runtime/src/config-store.js';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';
import { settle, sleep, waitFor } from '../helpers/fs-watch.js';

// ════════════════════════════════════════════════════════════
// 配置落盘的读-改-写竞态：save 此前不看盘上实况，整份覆写进程内的旧文档，
// 用户手改（含刚填的密钥）被静默吃掉。窗口有四种：去抖窗口内、解析失败的草稿、
// 启动期监听未武装、另一个进程（子命令）写过。
// 契约：盘上内容 ≠ 本进程最后读入或写出的那份即拒写，盘上原样保留、错误只带路径；
// 监听武装后立即对账一次；fs.watch 不可用时告警。
// ════════════════════════════════════════════════════════════

// fs.watch 不可用的平台 / 挂载无法在测试机上造出来：只在打开开关时让它抛错，其余用例走真实实现。
const watchFault = vi.hoisted(() => ({ fail: false }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    watch: (...args: Parameters<typeof fs.watch>) => {
      if (watchFault.fail) throw new Error('ENOSYS: watch unavailable');
      return fs.watch(...args);
    },
  };
});

const A = 'name: T\nlogLevel: info\nplugins:\n  llm-openai:\n    model: x\n  cli: {}\n';
const B = A.replace('model: x\n', 'model: x\n    apiKey: sk-PLACEHOLDER\n');

/** `ConfigProvider.save` 在契约上可选；缺失时立刻抛，免得用例退化成恒真。 */
function saveOf(provider: { save?: (config: AalisConfig) => void | Promise<void> }): (config: AalisConfig) => void {
  const save = provider.save;
  if (!save) throw new Error('createFsYamlConfigProvider 必须提供 save');
  return config => void save(config);
}

let dir: string;
let path: string;
let stop: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalis-cfg-conflict-'));
  path = join(dir, 'aalis.config.yaml');
  stop = undefined;
});

afterEach(() => {
  stop?.();
  watchFault.fail = false;
  rmSync(dir, { recursive: true, force: true });
});

describe('save 写前比对磁盘实况', () => {
  it('未武装监听时的外部修改：save 拒写，盘上原样，错误不带内容', () => {
    writeFileSync(path, A);
    const { provider } = createFsYamlConfigProvider(path);
    writeFileSync(path, B);
    let err: unknown;
    try {
      saveOf(provider)({ name: 'T', logLevel: 'info', plugins: {} });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toMatch(/外部修改/);
    expect(String(err)).toContain(path);
    expect(String(err)).not.toContain('sk-PLACEHOLDER');
    expect(readFileSync(path, 'utf-8')).toBe(B);
  });

  it('去抖窗口内（经 ConfigStore）：persist 拒绝，去抖到期后手改进入文档', async () => {
    writeFileSync(path, A);
    const { config, provider } = createFsYamlConfigProvider(path);
    const store = createConfigStore(config, provider);
    let changes = 0;
    stop = store.watch(() => changes++);
    await settle();

    writeFileSync(path, B);
    store.setPluginConfig('cli', { lastView: 'logs' });
    await expect(store.persist()).rejects.toThrow(/外部修改/);
    expect(await waitFor(() => changes >= 1)).toBe(true);
    expect(store.getPluginConfig('llm-openai').apiKey).toBe('sk-PLACEHOLDER');
    expect(readFileSync(path, 'utf-8')).toBe(B);
  });

  it('解析失败的草稿在去抖之后仍受保护', async () => {
    writeFileSync(path, A);
    const { provider } = createFsYamlConfigProvider(path);
    stop = provider.watch?.(() => {});
    await settle();

    const draft = 'name: T\nplugins:\n  a:\n    x: 1\n   apiKey: sk-PLACEHOLDER\n';
    writeFileSync(path, draft);
    await sleep(900);
    expect(() => saveOf(provider)({ name: 'T', logLevel: 'info', plugins: {} })).toThrow(/外部修改/);
    expect(readFileSync(path, 'utf-8')).toBe(draft);
  });

  it('两个进程（两个 provider）写同一文件：先写者成功，后写者拒写', () => {
    writeFileSync(path, A);
    const a = createFsYamlConfigProvider(path);
    const b = createFsYamlConfigProvider(path);
    saveOf(a.provider)({ ...a.config, owners: [{ platform: 'p', userId: 'u' }] });
    expect(() => saveOf(b.provider)({ ...b.config, autoConfirmUntil: -1 })).toThrow(/外部修改/);
    expect(readFileSync(path, 'utf-8')).toContain('owners');
  });

  it('武装即对账：武装前的外部修改在武装后投递，之后 save 不再拒写', async () => {
    writeFileSync(path, A);
    const { provider } = createFsYamlConfigProvider(path);
    writeFileSync(path, B);
    // macOS 的 FSEvents 会补报武装前一瞬的写入；隔开一段再武装，测到的才是对账本身。
    await sleep(200);
    const seen: AalisConfig[] = [];
    stop = provider.watch?.(c => seen.push(c));
    expect(await waitFor(() => seen.length >= 1, 2000)).toBe(true);
    expect(seen[0].plugins['llm-openai']?.apiKey).toBe('sk-PLACEHOLDER');
    expect(() => saveOf(provider)(seen[0])).not.toThrow();
  });

  it('守卫：连续自写回不误拒；外部修改生效后恢复保存；文件不存在照写', async () => {
    writeFileSync(path, A);
    const { provider } = createFsYamlConfigProvider(path);
    const save = saveOf(provider);
    save({ name: 'T', logLevel: 'debug', plugins: {} });
    save({ name: 'T', logLevel: 'warn', plugins: {} });

    const seen: AalisConfig[] = [];
    stop = provider.watch?.(c => seen.push(c));
    await settle();
    writeFileSync(path, B);
    expect(await waitFor(() => seen.length >= 1)).toBe(true);
    save({ ...seen[0], logLevel: 'error' });
    expect(readFileSync(path, 'utf-8')).toContain('apiKey');

    const fresh = join(dir, 'new.yaml');
    const created = createFsYamlConfigProvider(fresh);
    saveOf(created.provider)(created.config);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('fs.watch 不可用', () => {
  it('告警一次，说明手改需重启才生效', () => {
    const warns: string[] = [];
    const offHub = LogHub.default.onEntry(e => {
      if (e.level === 'warn' && e.scope === 'aalis:config') warns.push(e.message);
    });
    try {
      writeFileSync(path, A);
      const { provider } = createFsYamlConfigProvider(path);
      watchFault.fail = true;
      stop = provider.watch?.(() => {});
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/无法监听配置文件变更.*重启/);
    } finally {
      offHub();
    }
  });
});
