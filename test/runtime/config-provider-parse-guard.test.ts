import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogHub } from '../../packages/core/src/index.js';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// FsYamlConfigProvider 解析守卫 —— 坏配置必须有信号，好配置不受影响。
//
// 事故背景：watch 回调曾用一个 catch 罩住读盘+解析，重复键等语法错误被
// 静默吞掉、进程无声用旧配置跑（压缩静默死亡烧一天半的根因链一环）。
// 契约：读不到安静返回；解析失败告警且不投递；空/非映射同一道闸拒收；
// rawYaml 只在解析成功后推进（同一份坏内容每次保存都重新告警）。
// ════════════════════════════════════════════════════════════

const DEBOUNCE_MS = 300;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

const quiet = (): Promise<void> => sleep(DEBOUNCE_MS + 500);
const settle = (): Promise<void> => sleep(250);

/** 原子替换——编辑器默认保存的做法。 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

describe('FsYamlConfigProvider 解析守卫', () => {
  let dir: string;
  let file: string;
  let warns: string[];
  let offHub: () => void;
  let unwatch: (() => void) | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-parse-guard-'));
    file = join(dir, 'aalis.config.yaml');
    warns = [];
    offHub = LogHub.default.onEntry(e => {
      if (e.level === 'warn' && e.scope === 'aalis:config') warns.push(e.message);
    });
  });

  afterEach(() => {
    unwatch?.();
    unwatch = null;
    offHub();
    rmSync(dir, { recursive: true, force: true });
  });

  it('语法错误：告警点名且不投递，进程继续用旧配置；改对后恢复投递', async () => {
    writeFileSync(file, 'name: Aalis\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(file);
    const received: unknown[] = [];
    unwatch = provider.watch?.(cfg => received.push(cfg)) ?? null;
    await settle();

    atomicWrite(file, 'name: Aalis\n\tplugins: {}\n'); // tab 缩进
    expect(await waitFor(() => warns.some(w => w.includes('解析失败')))).toBe(true);
    await quiet();
    expect(received).toHaveLength(0);

    atomicWrite(file, 'name: Fixed\nlogLevel: info\nplugins: {}\n');
    expect(await waitFor(() => received.length === 1)).toBe(true);
    expect((received[0] as { name: string }).name).toBe('Fixed');
  });

  it('同一份坏内容保存两次告警两次（rawYaml 只在解析成功后推进）', async () => {
    writeFileSync(file, 'name: Aalis\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(file);
    unwatch = provider.watch?.(() => {}) ?? null;
    await settle();

    const bad = 'name: Aalis\n\tplugins: {}\n';
    atomicWrite(file, bad);
    expect(await waitFor(() => warns.length === 1)).toBe(true);
    atomicWrite(file, bad); // 编辑器自动保存同样的坏内容
    expect(await waitFor(() => warns.length === 2)).toBe(true);
  });

  it('空文件与裸标量：同一道闸拒收（不再按默认值 bounce、不写回垃圾）', async () => {
    writeFileSync(file, 'name: Aalis\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(file);
    const received: unknown[] = [];
    unwatch = provider.watch?.(cfg => received.push(cfg)) ?? null;
    await settle();

    atomicWrite(file, '');
    expect(await waitFor(() => warns.some(w => w.includes('得到 empty')))).toBe(true);
    atomicWrite(file, 'foo\n');
    expect(await waitFor(() => warns.some(w => w.includes('得到 string')))).toBe(true);
    await quiet();
    expect(received).toHaveLength(0);
  });

  it('启动时裸标量：响亮拒启，不进 core 摊字符', () => {
    writeFileSync(file, 'foo\n', 'utf-8');
    expect(() => createFsYamlConfigProvider(file)).toThrowError(/不是一个配置对象（得到 string）/);
  });

  it('启动时缺文件：warn 点名绝对路径并回落内存默认（不再无声）', () => {
    const { config } = createFsYamlConfigProvider(join(dir, 'nope.yaml'));
    expect(config.name).toBe('Aalis');
    expect(warns.some(w => w.includes('配置文件不存在') && w.includes('nope.yaml'))).toBe(true);
  });
});
