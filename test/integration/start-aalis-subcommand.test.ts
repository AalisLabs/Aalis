import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// ════════════════════════════════════════════════════════════
// startAalis 子命令模式 — 真实子进程 e2e
//
// startAalis 的编排（文件日志装载时机、重启策略注入、子命令命中/未命中后的退出）在进程内
// 无法单测：它挂全局 fatal handler、最终 process.exit。这里用 tsx 跑 test/fixtures/subcommand-entry.ts
// （只走 runtime 源码），每个用例一个临时 cwd，断言全部基于「进程退出后」的退出码 / 输出 / 文件内容，
// 不含计时竞态。
//
// 三条被守的不变量（对应曾实测出的故障）：
// 1. 子命令进程不碰 data/latest.log——否则守护进程正在写的日志被截断；
// 2. 未命中的子命令报错退出（exit 2），绝不进守护进程——否则打错字就起第二个实例；
// 3. 子命令进程无重启策略——否则 `restart` 在 app.stop ≥ 500ms 时 spawn 出 argv 仍带 restart 的
//    detached 子进程，无限连环（实测 5 代）。
//
// 守护路径（argv 为空）作为对照：文件日志照常写、SIGTERM 优雅退出。
// ════════════════════════════════════════════════════════════

const repoRoot = resolve(import.meta.dirname, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const fixture = join(repoRoot, 'test', 'fixtures', 'subcommand-entry.ts');
const SENTINEL = 'SENTINEL: daemon log must survive\n';

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(cwd: string, argv: string[], env: Record<string, string> = {}, timeoutMs = 12_000): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    // detached：让 tsx 包装脚本自成进程组。`.bin/tsx` 会再起一个真正跑夹具的 node 子进程，超时时
    // 只杀包装层会留下孤儿守护进程（变异验证时实测），必须按进程组整体 SIGKILL。
    // 与进程内测试同一源码映射，避免 runtime 源码搭配陈旧的 core dist。
    const child = spawn(tsxBin, ['--tsconfig', join(repoRoot, 'tsconfig.test.json'), fixture, ...argv], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += String(d);
    });
    child.stderr.on('data', d => {
      stderr += String(d);
    });
    // 回归成「进守护进程」时子进程不会自己退出；超时杀掉整个进程组，让用例以退出码/信号不符而红，而不是挂死。
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-subcommand-e2e-'));
  writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'latest.log'), SENTINEL);
  return dir;
}

const readLog = (dir: string) => readFileSync(join(dir, 'data', 'latest.log'), 'utf-8');
const readGen = (dir: string) => readFileSync(join(dir, 'gen.txt'), 'utf-8').trim();

describe('startAalis 子命令模式（真实子进程）', () => {
  const dirs: string[] = [];
  const project = () => {
    const dir = makeProject();
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('命中：执行并打印结果、exit 0，不碰 data/latest.log', async () => {
    const dir = project();
    const r = await run(dir, ['probe', 'a', 'b']);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('probe ok a b');
    expect(readLog(dir)).toBe(SENTINEL);
    expect(readGen(dir)).toBe('1');
  });

  it('真实启动入口在首次 apply 前完成裁剪和默认值合并，并保存同一份配置', async () => {
    const dir = project();
    writeFileSync(
      join(dir, 'aalis.config.yaml'),
      'name: e2e\nlogLevel: info\nplugins:\n  e2e-probe:\n    known: 2\n    unknown: true\n    nested:\n      typo: 1\n',
    );
    const r = await run(dir, ['probe']);
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
    const expected = { known: 2, nested: { filled: 9 } };
    expect(JSON.parse(readFileSync(join(dir, 'first-config.json'), 'utf8'))).toEqual(expected);
    const stored = parse(readFileSync(join(dir, 'aalis.config.yaml'), 'utf8'));
    expect(stored.plugins['e2e-probe']).toEqual(expected);
    expect(r.stderr).toContain('unknown');
    expect(r.stderr).toContain('nested.typo');
  });

  it('未命中：报错 exit 2，不进守护进程，不碰 data/latest.log', async () => {
    const dir = project();
    const r = await run(dir, ['nope']);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('未知子命令「nope」');
    expect(readLog(dir)).toBe(SENTINEL);
  });

  it('restart 子命令：无重启策略，慢拆卸下也不 spawn 第二代', async () => {
    const dir = project();
    // onDispose 1500ms > 重启策略的 500ms 等待窗口——策略若被注入，必然 spawn。
    const r = await run(dir, ['restart'], { AALIS_E2E_SLOW_MS: '1500' }, 15_000);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('指令执行失败');
    expect(r.stdout).toContain('未注入 restartStrategy');
    expect(readGen(dir)).toBe('1');
    expect(readLog(dir)).toBe(SENTINEL);
  }, 20_000);

  it('对照·守护路径：显式 subcommands: [] 压过非空 argv，照常写文件日志，宿主提供插件来源与配置文档，SIGTERM 优雅退出', async () => {
    const dir = project();
    writeFileSync(
      join(dir, 'aalis.config.yaml'),
      'name: e2e\nlogLevel: info\nplugins:\n  e2e-probe:\n    known: 3\nservicePreferences:\n  commands: e2e-probe\n',
    );
    // argv 非空但宿主显式传了 []：不分发、进守护——空 argv 与 [] 重合时测不出这条优先级
    const r = await run(dir, ['probe'], { AALIS_E2E_MODE: 'daemon' });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    const log = readLog(dir);
    expect(log).not.toContain(SENTINEL.trim());
    expect(log).toContain('启动完成');
    expect(log).toContain('已停止');
    // 宿主在根上提供了 plugin-source：重扫可调，插件都已注册，新登记名单为空
    expect(JSON.parse(readFileSync(join(dir, 'rescan.json'), 'utf8'))).toEqual([]);
    // 宿主在根上提供了 host-config（插件读到的是规范化后的文档），并应用了文档里的服务偏好
    expect(JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8'))).toEqual({
      probeConfig: { known: 3, nested: { filled: 9 } },
      preferred: 'e2e-probe',
    });
  });
});
