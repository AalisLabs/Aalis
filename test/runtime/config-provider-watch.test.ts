import { existsSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';

// ════════════════════════════════════════════════════════════
// FsYamlConfigProvider.watch —— 配置文件外部变更监听
//
// 回归焦点：**监听的必须是目录，不是文件**。fs.watch 绑定的是那一刻的 inode，
// 而编辑器保存普遍是「写临时文件 → rename 覆盖」；一旦发生原子替换，绑在旧
// inode 上的 watcher 就永久失聪——无异常、无日志，文件说一套、进程做一套。
// 而 save() 是原地写（inode 不变），所以这条死路只有「人改配置」会踩到。
// ════════════════════════════════════════════════════════════

const DEBOUNCE_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 轮询等待条件成立；成立即返回，超时返回最后一次判定。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** 静默期：等足去抖 + 余量，用于断言「不该触发」。 */
const quiet = (): Promise<void> => sleep(DEBOUNCE_MS + 500);

/**
 * 等 fs.watch 真正武装完毕。macOS 的 FSEvents 后端建流是异步的，arm 之后立刻写
 * 有可能被漏掉——不等这一下，「没触发」既可能是缺陷也可能是竞态，测试就没有判别力了。
 */
const settle = (): Promise<void> => sleep(250);

/** 原子替换——编辑器/`sed -i`/`vim` 默认保存的做法，会换掉 inode。 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}

describe('FsYamlConfigProvider.watch', () => {
  let dir: string;
  let path: string;
  let unwatch: (() => void) | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-cfg-watch-'));
    path = join(dir, 'aalis.config.yaml');
    unwatch = null;
  });

  afterEach(() => {
    unwatch?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('原子替换（编辑器保存）之后，后续变更仍然能被监听到', async () => {
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    const seen: Array<Record<string, unknown>> = [];
    unwatch = provider.watch?.(cfg => seen.push(cfg as unknown as Record<string, unknown>)) ?? null;
    await settle();
    expect(unwatch).not.toBeNull();

    // ① 原地写：修复前后都能触发（基线）
    writeFileSync(path, 'name: T\nlogLevel: debug\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => seen.length >= 1)).toBe(true);
    expect(seen.at(-1)?.logLevel).toBe('debug');

    // ② 原子替换：inode 变了
    const inodeBefore = statSync(path).ino;
    atomicWrite(path, 'name: T\nlogLevel: warn\nplugins: {}\n');
    expect(statSync(path).ino).not.toBe(inodeBefore);
    expect(await waitFor(() => seen.length >= 2)).toBe(true);
    expect(seen.at(-1)?.logLevel).toBe('warn');

    // ③ 关键回归：替换之后再改一次。监听文件本身的旧实现在这里永久失聪。
    writeFileSync(path, 'name: T\nlogLevel: error\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => seen.length >= 3)).toBe(true);
    expect(seen.at(-1)?.logLevel).toBe('error');

    // ④ 再来一次原子替换 + 原地写，确认不是侥幸活过一轮
    atomicWrite(path, 'name: T\nlogLevel: silent\nplugins: {}\n');
    expect(await waitFor(() => seen.length >= 4)).toBe(true);
    writeFileSync(path, 'name: T2\nlogLevel: silent\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => seen.length >= 5)).toBe(true);
    expect(seen.at(-1)?.name).toBe('T2');
  });

  it('save() 自写回不触发 onChange（不自激）', async () => {
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    let hits = 0;
    unwatch = provider.watch?.(() => hits++) ?? null;
    await settle();

    expect(provider.save).toBeDefined();
    provider.save?.({ name: 'T', logLevel: 'debug', plugins: { p: { a: 1 } } });
    await quiet();
    expect(hits).toBe(0);

    // 自写回之后，外部改动仍然要能触发（抑制不能是单向阀）
    writeFileSync(path, 'name: X\nlogLevel: debug\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => hits >= 1)).toBe(true);
    expect(hits).toBe(1);
  });

  it('内容未变的写入 / touch 不触发 onChange，且改回旧内容仍算真变更', async () => {
    const first = 'name: T\nlogLevel: info\nplugins: {}\n';
    const second = 'name: T\nlogLevel: debug\nplugins: {}\n';
    writeFileSync(path, first, 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    const seen: Array<Record<string, unknown>> = [];
    unwatch = provider.watch?.(cfg => seen.push(cfg as unknown as Record<string, unknown>)) ?? null;
    await settle();

    // 负向断言**必须**先经过一次真实变更。否则它们全落在「回调从未触发过」的初始态——
    // 那一刻 rawYaml 恰好等于磁盘内容，即便回调内忘了刷新 rawYaml，比对也照样成立，
    // 三条断言全部假通过（实测：删掉 providers.ts 回调里的 `rawYaml = current` 后 7 条仍全绿）。
    writeFileSync(path, second, 'utf-8');
    expect(await waitFor(() => seen.length >= 1)).toBe(true);
    expect(seen.at(-1)?.logLevel).toBe('debug');

    writeFileSync(path, second, 'utf-8'); // 写入完全相同的内容
    await quiet();
    expect(seen).toHaveLength(1);

    const now = new Date();
    utimesSync(path, now, now); // 纯 touch
    await quiet();
    expect(seen).toHaveLength(1);

    atomicWrite(path, second); // 原子替换但内容不变
    await quiet();
    expect(seen).toHaveLength(1);

    // 改回**先前**的内容：磁盘内容确实变了，必须投递。
    // rawYaml 若停在装载时的旧值，这一次会被误判为「没变」而静默丢弃——
    // 插件继续跑着已经被改掉的配置，正是本次修复要消灭的失败形状。
    writeFileSync(path, first, 'utf-8');
    expect(await waitFor(() => seen.length >= 2)).toBe(true);
    expect(seen.at(-1)?.logLevel).toBe('info');
  });

  it('同目录下其它文件的变动不触发 onChange', async () => {
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    let hits = 0;
    unwatch = provider.watch?.(() => hits++) ?? null;
    await settle();

    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n', 'utf-8');
    writeFileSync(join(dir, 'aalis.config.yaml.bak'), 'name: NOPE\n', 'utf-8');
    writeFileSync(join(dir, '.aalis.config.yaml.swp'), 'name: NOPE\n', 'utf-8');
    await quiet();
    expect(hits).toBe(0);

    // 正向对照：同一个 watcher 对真正的配置文件必须有反应
    writeFileSync(path, 'name: REAL\nlogLevel: info\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => hits >= 1)).toBe(true);
  });

  it('配置文件初始不存在时也武装监听，文件建出来即接上', async () => {
    expect(existsSync(path)).toBe(false);
    const { provider, config } = createFsYamlConfigProvider(path);
    expect(config.plugins).toEqual({});

    const seen: Array<Record<string, unknown>> = [];
    unwatch = provider.watch?.(cfg => seen.push(cfg as unknown as Record<string, unknown>)) ?? null;
    await settle();
    expect(unwatch).not.toBeNull();

    writeFileSync(path, 'name: Late\nlogLevel: info\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => seen.length >= 1)).toBe(true);
    expect(seen[0]?.name).toBe('Late');
  });

  it('unwatch 之后不再触发，且可重新武装', async () => {
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    let hits = 0;
    const stop = provider.watch?.(() => hits++);
    expect(stop).toBeDefined();
    await settle();

    // 先证明它确实在响——否则「停掉后没触发」可能只是它从来没武装成功
    writeFileSync(path, 'name: A\nlogLevel: info\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => hits >= 1)).toBe(true);

    stop?.();
    writeFileSync(path, 'name: A2\nlogLevel: info\nplugins: {}\n', 'utf-8');
    await quiet();
    expect(hits).toBe(1);

    // 重新武装：`if (watcher) return` 的守卫在 unwatch 后必须已经放开
    unwatch = provider.watch?.(() => hits++) ?? null;
    await settle();
    writeFileSync(path, 'name: B\nlogLevel: info\nplugins: {}\n', 'utf-8');
    expect(await waitFor(() => hits >= 2)).toBe(true);
  });

  it('同级无关文件的持续写入不会饿死真实配置变更', async () => {
    // 文件名过滤不只是省一次读盘：没有它，目录里任何文件的写入都会重置 300ms 去抖，
    // 只要无关写入的间隔小于去抖窗口（pnpm 装包、编辑器落 swap 文件、日志轮转），
    // 真实的配置变更就永远等不到落地——而且照例是静默的。
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    let hits = 0;
    unwatch = provider.watch?.(() => hits++) ?? null;
    await settle();

    let n = 0;
    const noise = setInterval(() => writeFileSync(join(dir, 'package.json'), `{"n":${n++}}\n`, 'utf-8'), 40);
    try {
      writeFileSync(path, 'name: T\nlogLevel: debug\nplugins: {}\n', 'utf-8');
      expect(await waitFor(() => hits >= 1, 2500)).toBe(true);
    } finally {
      clearInterval(noise);
    }
  });

  it('去抖：连续多次写入只回调一次，且拿到最后一次的内容', async () => {
    writeFileSync(path, 'name: T\nlogLevel: info\nplugins: {}\n', 'utf-8');
    const { provider } = createFsYamlConfigProvider(path);

    const seen: Array<Record<string, unknown>> = [];
    unwatch = provider.watch?.(cfg => seen.push(cfg as unknown as Record<string, unknown>)) ?? null;
    await settle();

    for (let i = 1; i <= 5; i++) {
      writeFileSync(path, `name: T${i}\nlogLevel: info\nplugins: {}\n`, 'utf-8');
      await sleep(30);
    }
    expect(await waitFor(() => seen.length >= 1)).toBe(true);
    await quiet();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('T5');
  });
});
