import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isConfigSaveRefused } from '../../packages/api-host-config/src/index.js';
import { LogHub } from '../../packages/core/src/index.js';
import { createFsSecretsProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// @aalis/runtime — secrets.yaml
//
// 与配置文件共用读写与监听（写前比对、原子写、按目录监听、按内容去重），另有两处不同：文件不存在按空映射、
// 不告警；临时文件一律以 0600 创建，不沿用原文件的权限位。解析出错只记错误码与行列，不记 yaml 的报错原文。
// ════════════════════════════════════════════════════════════

let dir: string;
let file: string;
let warns: string[];
let detach: () => void;
let unwatch: (() => void) | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aalis-secrets-'));
  file = join(dir, 'secrets.yaml');
  warns = [];
  detach = LogHub.default.onEntry(entry => {
    if (entry.level === 'warn' && entry.scope === 'aalis:secrets') warns.push(entry.message);
  });
});

afterEach(() => {
  unwatch?.();
  unwatch = null;
  detach();
  rmSync(dir, { recursive: true, force: true });
});

const settle = () => new Promise(resolve => setTimeout(resolve, 450));

describe('createFsSecretsProvider', () => {
  it('运行中改成空文件或只剩注释：按空的密钥文件投递，之后照常写回，不拒写', async () => {
    writeFileSync(file, 'k: v\n');
    const { provider } = createFsSecretsProvider(file);
    const seen: unknown[] = [];
    unwatch = provider.watch?.(next => seen.push(next)) ?? null;
    await settle();
    const tmp = `${file}.edit`;
    writeFileSync(tmp, '# 全部注释掉了\n');
    renameSync(tmp, file);
    await settle();
    expect(seen).toEqual([{}]);
    expect(() => provider.save?.({ k: 'new' })).not.toThrow();
  });

  it('YAML 警告（把 !xxx 当成标签）只记错误码与行列，不经 process.emitWarning 把原文打到 stderr', () => {
    const emitted: unknown[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((warning: unknown) => void emitted.push(warning)) as typeof process.emitWarning;
    try {
      writeFileSync(file, 'k: !sk-LEAK-PLACEHOLDER\n');
      const { values } = createFsSecretsProvider(file);
      expect(values).toEqual({ k: '' });
    } finally {
      process.emitWarning = original;
    }
    expect(emitted).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^密钥文件有可疑写法：TAG_RESOLVE_FAILED（第 1 行第 \d+ 列）$/);
  });

  it('文件不存在：按空映射，不告警；第一次保存时建出，权限 0600', () => {
    const { values, provider } = createFsSecretsProvider(file);
    expect(values).toEqual({});
    expect(warns).toEqual([]);
    provider.save?.({ 'p.apiKey': 'sk-PLACEHOLDER' });
    expect(readFileSync(file, 'utf-8')).toBe('p.apiKey: sk-PLACEHOLDER\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('原文件权限更宽（0644）时，写回后仍是 0600，不沿用原文件的权限位', () => {
    writeFileSync(file, 'k: v\n');
    chmodSync(file, 0o644);
    const { values, provider } = createFsSecretsProvider(file);
    expect(values).toEqual({ k: 'v' });
    provider.save?.({ k: 'v2' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('启动时解析失败：拒启，消息只有错误码与行列，不带原文', () => {
    writeFileSync(file, 'k: >- sk-LEAK-PLACEHOLDER\n');
    let thrown: Error | undefined;
    try {
      createFsSecretsProvider(file);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/^密钥文件解析失败：UNEXPECTED_TOKEN（第 1 行第 \d+ 列）/);
    expect(thrown?.message).not.toContain('sk-LEAK');
  });

  it('有尚未生效的外部修改时拒写（ConfigSaveRefusedError，只带路径）', () => {
    writeFileSync(file, 'k: v\n');
    const { provider } = createFsSecretsProvider(file);
    writeFileSync(file, 'k: edited\n');
    let thrown: unknown;
    try {
      provider.save?.({ k: 'mine' });
    } catch (err) {
      thrown = err;
    }
    expect(isConfigSaveRefused(thrown)).toBe(true);
    expect((thrown as Error).message).toBe(`密钥文件有尚未生效的外部修改，为免覆盖已拒绝本次保存（${file}）`);
    expect(readFileSync(file, 'utf-8')).toBe('k: edited\n');
  });

  it('监听：自写回不触发；外部修改投递新内容；解析失败只告警错误码与行列', async () => {
    writeFileSync(file, 'k: v\n');
    const { provider } = createFsSecretsProvider(file);
    const seen: unknown[] = [];
    unwatch = provider.watch?.(next => seen.push(next)) ?? null;
    await settle();
    provider.save?.({ k: 'self' });
    await settle();
    expect(seen).toEqual([]);

    const tmp = `${file}.edit`;
    writeFileSync(tmp, 'k: external\n');
    renameSync(tmp, file);
    await settle();
    expect(seen).toEqual([{ k: 'external' }]);

    writeFileSync(tmp, 'k: >- sk-LEAK-PLACEHOLDER\n');
    renameSync(tmp, file);
    await settle();
    expect(seen).toHaveLength(1);
    const warning = warns.find(w => w.includes('密钥文件解析失败'));
    expect(warning).toMatch(/UNEXPECTED_TOKEN（第 1 行第 \d+ 列）/);
    expect(warning).not.toContain('sk-LEAK');
    expect(existsSync(tmp)).toBe(false);
  });
});
