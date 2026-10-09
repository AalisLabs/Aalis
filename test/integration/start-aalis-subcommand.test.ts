import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { nodeProcessProbe } from '../../packages/runtime/src/instance-lock.js';

// ════════════════════════════════════════════════════════════
// startAalis 子命令模式 — 真实子进程 e2e
//
// startAalis 的编排（文件日志装载时机、重启策略注入、子命令命中/未命中后的退出）在进程内
// 无法单测：它挂全局 fatal handler、最终 process.exit。这里用 tsx 跑 test/fixtures/subcommand-entry.ts
// （只走 runtime 源码），每个用例一个临时目录，既是 cwd 也经 AALIS_HOME 当家目录，断言全部基于「进程退出后」的退出码 / 输出 / 文件内容，
// 计时相关的用例（慢激活）都留足余量。
//
// 三条被守的不变量（对应曾实测出的故障）：
// 1. 子命令进程不碰 logs/latest.log，也不轮转——否则守护进程正在写的日志被改名移走；
// 2. 未命中的子命令报错退出（exit 2），绝不进守护进程——否则打错字就起第二个实例；
// 3. 子命令进程无重启策略——否则 `restart` 在 app.stop ≥ 500ms 时 spawn 出 argv 仍带 restart 的
//    detached 子进程，无限连环（实测 5 代）。
//
// 守护路径（argv 为空）作为对照：旧日志轮转为 latest.1.log、文件日志照常写、SIGTERM 优雅退出；另守启动收敛后的 pending 告警把「等待仍在激活的
// 提供者」与「缺少」分开报。
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
    // 家目录取这个临时目录，用户主目录也指到这里：解析一旦回退到 ~/.aalis，也落在临时目录里，不碰开发者自己的实例。
    // 外面环境里的 AALIS_PROFILE 会与 AALIS_HOME 冲突，先去掉，用例显式传的照样生效。
    const inherited: Record<string, string | undefined> = { ...process.env };
    delete inherited.AALIS_PROFILE;
    const childEnv = { ...inherited, HOME: cwd, USERPROFILE: cwd, AALIS_HOME: cwd, ...env };
    const child = spawn(tsxBin, ['--tsconfig', join(repoRoot, 'tsconfig.test.json'), fixture, ...argv], {
      cwd,
      env: childEnv,
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
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'latest.log'), SENTINEL);
  return dir;
}

const readLog = (dir: string) => readFileSync(join(dir, 'logs', 'latest.log'), 'utf-8');
const hasRotated = (dir: string) => existsSync(join(dir, 'logs', 'latest.1.log'));
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

  it('命中：执行并打印结果、exit 0，不碰 logs/latest.log', async () => {
    const dir = project();
    const r = await run(dir, ['probe', 'a', 'b']);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('probe ok a b');
    expect(readLog(dir)).toBe(SENTINEL);
    expect(hasRotated(dir)).toBe(false);
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

  it('配置文件顶层的 slowThresholdMs 注入 core：激活超过它即转入后台；留空按默认处理，写错了告警并按默认处理', async () => {
    // 每次运行一个新目录：夹具的代数护栏只放行每个目录的第一次启动
    const runWith = (value: string) => {
      const dir = project();
      writeFileSync(
        join(dir, 'aalis.config.yaml'),
        `name: e2e\nlogLevel: info\nslowThresholdMs: ${value}\nplugins: {}\n`,
      );
      return run(dir, ['probe'], { AALIS_E2E_APPLY_MS: '400' });
    };
    const applied = await runWith('50');
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain('probe ok');
    expect(applied.stderr).toContain('插件 "e2e-slow" 激活超过 50ms 仍未完成，转入后台继续');

    // YAML 空键解出 null：与没写一样交给默认，不告警
    const blank = await runWith('');
    expect(blank.code).toBe(0);
    expect(blank.stderr).not.toContain('配置项 slowThresholdMs');
    expect(blank.stderr).not.toContain('转入后台继续');

    // 告警照原样显示收到的值：.inf 显示为 Infinity，不因 JSON.stringify 显示成 null
    for (const [invalid, shown] of [
      ['"abc"', '"abc"'],
      ['-1', '-1'],
      ['.inf', 'Infinity'],
    ]) {
      const r = await runWith(invalid);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`配置项 slowThresholdMs 应为不小于 0 的有限数字（毫秒），收到 ${shown}，按默认值处理`);
      expect(r.stderr).not.toContain('转入后台继续');
    }
  }, 45_000);

  it('未命中：报错 exit 2，不进守护进程，不碰 logs/latest.log', async () => {
    const dir = project();
    const r = await run(dir, ['nope']);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('未知子命令「nope」');
    expect(readLog(dir)).toBe(SENTINEL);
    expect(hasRotated(dir)).toBe(false);
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

  it('对照·守护路径：显式 argv: [] 压过非空的命令行参数，旧日志轮转为 latest.1.log、照常写文件日志，宿主提供插件来源与配置文档，SIGTERM 优雅退出', async () => {
    const dir = project();
    writeFileSync(
      join(dir, 'aalis.config.yaml'),
      'name: e2e\nlogLevel: info\nplugins:\n  e2e-probe:\n    known: 3\n    stale: 1\nservicePreferences:\n  commands: e2e-probe\n',
    );
    // argv 非空但宿主显式传了 []：不分发、进守护——空 argv 与 [] 重合时测不出这条优先级
    const r = await run(dir, ['probe'], { AALIS_E2E_MODE: 'daemon' });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    const log = readLog(dir);
    expect(log).not.toContain(SENTINEL.trim());
    expect(readFileSync(join(dir, 'logs', 'latest.1.log'), 'utf-8')).toBe(SENTINEL);
    expect(log).toContain('启动完成');
    expect(log).toContain('已停止');
    // 宿主在根上提供了 plugin-source：重扫可调，插件都已注册，新登记名单为空
    expect(JSON.parse(readFileSync(join(dir, 'rescan.json'), 'utf8'))).toEqual([]);
    // 宿主在根上提供了 host-config（插件读到的是规范化后的文档），并应用了文档里的服务偏好
    expect(JSON.parse(readFileSync(join(dir, 'host.json'), 'utf8'))).toEqual({
      probeConfig: { known: 3, nested: { filled: 9 } },
      preferred: 'e2e-probe',
    });
    // 配置同步裁掉 schema 外字段、回填默认值后落盘，服务偏好随文档写回，不被裁
    const saved = readFileSync(join(dir, 'aalis.config.yaml'), 'utf8');
    expect(saved).toContain('filled: 9');
    expect(saved).not.toContain('stale');
    expect(saved).toContain('servicePreferences:\n  commands: e2e-probe\n');
  });

  it('守护路径：启动收敛后的告警把缺的沿链追到根，仍在后台激活的插件所提供的服务报成等待，只在等的不告警', async () => {
    const dir = project();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nslowThresholdMs: 50\nplugins: {}\n');
    // e2e-slow 激活 1500ms，超过 50ms 阈值转入后台，它的 e2e-slow-svc 在完成前不对外
    const r = await run(dir, [], { AALIS_E2E_MODE: 'daemon', AALIS_E2E_APPLY_MS: '1500' });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    // 文件日志一行一条：前缀之后是 JSON
    const said = readLog(dir)
      .trim()
      .split('\n')
      .map(line => JSON.parse(line.slice(line.indexOf(' ') + 1)) as { level: string; scope: string; message: string })
      .filter(entry => entry.scope === 'aalis' && /^插件 "e2e-(waiting|patient|middle|chained)"/.test(entry.message))
      .map(({ level, message }) => `${level} ${message}`);
    expect(said).toEqual([
      'warn 插件 "e2e-waiting" 依赖未满足，未激活：缺少服务 e2e-missing-svc（没有已装的插件提供）；等待 e2e-slow 启动',
      'info 插件 "e2e-patient" 在等依赖启动：等待 e2e-slow 启动',
      'warn 插件 "e2e-middle" 依赖未满足，未激活：缺少服务 e2e-broken-svc（e2e-broken 失败：缺少配置项 apiKey）',
      'warn 插件 "e2e-chained" 依赖未满足，未激活：缺少服务 e2e-middle-svc（e2e-middle → e2e-broken 失败：缺少配置项 apiKey）',
    ]);
  });
});

describe('startAalis 家目录（真实子进程）', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-home-e2e-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('家目录没初始化：一行说明怎样初始化后 exit 1，不起空的家、不写任何文件', async () => {
    const dir = tempDir();
    const r = await run(dir, ['probe']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`家目录还没有初始化：${dir}`);
    expect(r.stderr).toContain('--init');
    expect(existsSync(join(dir, 'aalis.config.yaml'))).toBe(false);
    expect(existsSync(join(dir, 'logs'))).toBe(false);
    expect(existsSync(join(dir, 'first-config.json'))).toBe(false);
  });

  it('--init：建家目录（0700）、主配置与空的 secrets.yaml（0600）后退出，不加载插件；随后能正常启动', async () => {
    const dir = tempDir();
    const home = join(dir, 'home');
    const r = await run(dir, ['--init'], { AALIS_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`已初始化家目录：${home}`);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'secrets.yaml')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'secrets.yaml'), 'utf-8')).toBe('');
    expect(parse(readFileSync(join(home, 'aalis.config.yaml'), 'utf-8'))).toEqual({
      name: 'Aalis',
      logLevel: 'info',
      plugins: {},
      sessionConfig: { platforms: { cli: { enabledToolGroups: ['*'] }, webui: { enabledToolGroups: ['*'] } } },
    });
    for (const sub of ['state', 'logs', 'run', 'tmp', 'self/skills', 'stage/paper']) {
      expect(existsSync(join(home, sub)), sub).toBe(true);
    }
    expect(existsSync(join(dir, 'first-config.json'))).toBe(false);
    rmSync(join(dir, 'gen.txt'));
    const started = await run(dir, ['probe'], { AALIS_HOME: home });
    expect(started.code).toBe(0);
    expect(started.stdout).toContain('probe ok');
  }, 30_000);

  it('--init 遇到已初始化的家目录：拒绝并 exit 1，不覆盖', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: mine\nlogLevel: info\nplugins: {}\n');
    const r = await run(dir, ['--init']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('已经初始化过');
    expect(readFileSync(join(dir, 'aalis.config.yaml'), 'utf-8')).toBe('name: mine\nlogLevel: info\nplugins: {}\n');
  });

  it('--home 写在子命令之前：压过 AALIS_HOME，相对路径按启动时的 cwd 解析', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'other'));
    writeFileSync(
      join(dir, 'other', 'aalis.config.yaml'),
      'name: e2e\nlogLevel: info\nplugins:\n  e2e-probe:\n    known: 5\n',
    );
    const r = await run(dir, ['--home', 'other', 'probe', 'x'], { AALIS_HOME: join(dir, 'missing') });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('probe ok x');
    expect(JSON.parse(readFileSync(join(dir, 'first-config.json'), 'utf8')).known).toBe(5);
  });

  it('默认加载器的安装集里没有 package.json：说明要传 appDir 后 exit 1，不带着零个插件起来', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    const r = await run(dir, ['probe'], { AALIS_E2E_MODE: 'default-loader' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`安装集 ${join(realpathSync.native(dir), 'app')} 里没有 package.json`);
    expect(r.stderr).toContain('appDir');
    expect(existsSync(join(dir, 'logs', 'latest.log'))).toBe(false);
    // 安装集有 package.json 就照常往下走：没有插件提供指令服务，子命令按「commands 服务不可用」退出
    const app = join(dir, 'install');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{"name":"x","private":true}');
    rmSync(join(dir, 'gen.txt'));
    const ok = await run(dir, ['probe'], { AALIS_E2E_MODE: 'default-loader', AALIS_E2E_APP_DIR: app });
    expect(ok.code).toBe(2);
    expect(ok.stderr).toContain('commands 服务不可用');
  }, 30_000);

  /** 以本测试进程为持有者写一份活着的锁：pid 在、开机与进程启动标识都是真的 */
  const liveLock = (dir: string, handoffToken = 'not-handed-over') => {
    mkdirSync(join(dir, 'run'), { recursive: true });
    const startId = nodeProcessProbe.startId(process.pid);
    const bootId = nodeProcessProbe.bootId();
    writeFileSync(
      join(dir, 'run', 'instance.4.lock'),
      JSON.stringify({
        pid: process.pid,
        ...(startId ? { startId } : {}),
        ...(bootId ? { bootId } : {}),
        handoffHash: createHash('sha256').update(handoffToken).digest('hex'),
      }),
    );
  };

  it('实例锁被活着的实例占着：报占用者后 exit 1，不轮转、不写正在用的日志', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'latest.log'), SENTINEL);
    liveLock(dir);
    const r = await run(dir, [], { AALIS_E2E_MODE: 'daemon' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`已有实例在运行：pid ${process.pid}`);
    expect(r.stderr).toContain(join(dir, 'run', 'instance.4.lock'));
    // 判不了的几种情形都要提到：容器被强杀后在同一次开机内重启，新进程在另一个 pid 命名空间里
    expect(r.stderr).toContain('或容器被强杀后在同一次开机内重启');
    expect(readFileSync(join(dir, 'logs', 'latest.log'), 'utf-8')).toBe(SENTINEL);
    expect(existsSync(join(dir, 'logs', 'latest.1.log'))).toBe(false);
    expect(readdirSync(join(dir, 'run'))).toEqual(['instance.4.lock']);
  });

  it('以 --service 启动而锁被占：写一行说明后 exit 0，服务管理器不会反复拉起', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    liveLock(dir);
    const r = await run(dir, ['--service']);
    expect(r.code).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.stderr).toContain('已有实例在运行');
    expect(r.stderr).toContain('以服务形态启动，按正常退出处理');
  });

  // 靠权限位制造写不进：root 不受权限位限制，Windows 的 chmod 只切换只读属性
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    '取不了实例锁（run/ 写不进去）：一行说明后 exit 1，不往下启动',
    async () => {
      const dir = tempDir();
      writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
      mkdirSync(join(dir, 'run'), { mode: 0o500 });
      try {
        const r = await run(dir, [], { AALIS_E2E_MODE: 'daemon' });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(`无法在 ${join(realpathSync.native(dir), 'run')} 取实例锁`);
        expect(existsSync(join(dir, 'logs', 'latest.log'))).toBe(false);
      } finally {
        chmodSync(join(dir, 'run'), 0o700);
      }
    },
  );

  it('子命令不取实例锁：守护进程在跑时照常执行，不碰它的锁', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    liveLock(dir);
    const before = readFileSync(join(dir, 'run', 'instance.4.lock'), 'utf-8');
    const r = await run(dir, ['probe']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('probe ok');
    expect(readdirSync(join(dir, 'run'))).toEqual(['instance.4.lock']);
    expect(readFileSync(join(dir, 'run', 'instance.4.lock'), 'utf-8')).toBe(before);
  });

  it('/restart 经重启策略交接实例锁：第二代接手、令牌不留在环境里，第一代退出后只剩第二代持锁', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    // 第一代经 app.restart() 拉起第二代（继承本测试给的管道，run 会等到两代都退出）
    const r = await run(dir, [], { AALIS_E2E_MODE: 'restart' }, 30_000);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'gen.txt'), 'utf-8').trim()).toBe('2');
    expect(JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8'))).toEqual({
      handoffInEnv: false,
      locks: ['instance.2.lock'],
      selfHolds: true,
    });
    expect(readdirSync(join(dir, 'run')).filter(n => n.endsWith('.lock'))).toEqual([]);
  }, 45_000);

  it('以 --service 运行时 /restart 交给服务管理器：停掉后以 75 退出、放掉锁，不自己拉起新进程', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    const r = await run(dir, ['--service'], { AALIS_E2E_MODE: 'restart' });
    expect(r.code).toBe(75);
    expect(readFileSync(join(dir, 'gen.txt'), 'utf-8').trim()).toBe('1');
    expect(readdirSync(join(dir, 'run')).filter(n => n.endsWith('.lock'))).toEqual([]);
  });

  it('respawn 交接：令牌对得上就接手活着的锁；令牌随即从环境里删掉，退出时放掉自己这一代', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    liveLock(dir, 'handoff-token');
    const r = await run(dir, [], { AALIS_E2E_MODE: 'daemon', AALIS_LOCK_HANDOFF: 'handoff-token' });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8'))).toEqual({
      handoffInEnv: false,
      locks: ['instance.5.lock'],
      selfHolds: true,
    });
    expect(readdirSync(join(dir, 'run')).filter(n => n.endsWith('.lock'))).toEqual([]);
  });

  it('交给插件的家目录是真实路径；~/.aalis-<p> 不论经 --profile、--home 还是指向它的链接选中都带 profile', async () => {
    const dir = tempDir();
    const home = join(dir, '.aalis-e2e');
    mkdirSync(home);
    writeFileSync(join(home, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    symlinkSync(home, join(dir, 'link'));
    const seen = async (argv: string[]) => {
      rmSync(join(dir, 'gen.txt'), { force: true });
      const r = await run(dir, [...argv, 'probe', 'paths'], { AALIS_HOME: '' });
      expect(r.code, r.stderr).toBe(0);
      return JSON.parse(/paths (\{.*\})/.exec(r.stdout)?.[1] ?? 'null');
    };
    const real = realpathSync.native(home);
    expect(await seen(['--profile', 'e2e'])).toEqual({ home: real, profile: 'e2e' });
    expect(await seen(['--home', '~/.aalis-e2e/'])).toEqual({ home: real, profile: 'e2e' });
    // 写法认不出，按真实路径补认
    expect(await seen(['--home', 'link'])).toEqual({ home: real, profile: 'e2e' });
  });

  it('启动时配置文件或密钥文件写坏：一行报错（错误码与行列，不带原文）后 exit 1，不带调用栈', async () => {
    for (const [file, label] of [
      ['aalis.config.yaml', '配置文件'],
      ['secrets.yaml', '密钥文件'],
    ] as const) {
      const dir = tempDir();
      writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
      writeFileSync(join(dir, file), 'name: e2e\ntoken: "PLACEHOLDER-NOT-SHOWN\n');
      const r = await run(dir, ['probe']);
      expect(r.code, file).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`^\\[aalis\\] ${label}解析失败：\\S+（第 \\d+ 行第 \\d+ 列）`, 'm'));
      expect(r.stderr).not.toMatch(/^\s+at /m);
      expect(r.stderr).not.toContain('PLACEHOLDER-NOT-SHOWN');
      expect(existsSync(join(dir, 'first-config.json'))).toBe(false);
    }
  }, 30_000);

  it('配置文件里手写的密钥：启动时移进 secrets.yaml（0600），插件拿到原值，配置文件里只剩引用', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'aalis.config.yaml'),
      'name: e2e\nlogLevel: info\nplugins:\n  e2e-probe:\n    token: TOK-PLACEHOLDER\n',
    );
    const r = await run(dir, ['probe']);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'first-config.json'), 'utf8')).token).toBe('TOK-PLACEHOLDER');
    const configText = readFileSync(join(dir, 'aalis.config.yaml'), 'utf8');
    expect(configText).not.toContain('TOK-PLACEHOLDER');
    expect(parse(configText).plugins['e2e-probe'].token).toEqual({ $secret: 'e2e-probe.token' });
    expect(parse(readFileSync(join(dir, 'secrets.yaml'), 'utf8'))).toEqual({ 'e2e-probe.token': 'TOK-PLACEHOLDER' });
    expect(statSync(join(dir, 'secrets.yaml')).mode & 0o777).toBe(0o600);
  });

  it('同时给了 profile 与 AALIS_HOME：报冲突、exit 2，不静默挑一个', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'aalis.config.yaml'), 'name: e2e\nlogLevel: info\nplugins: {}\n');
    const r = await run(dir, ['--profile', 'test', 'probe']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('同时指定了 AALIS_HOME 与 --profile');
    expect(existsSync(join(dir, 'first-config.json'))).toBe(false);
  });
});
