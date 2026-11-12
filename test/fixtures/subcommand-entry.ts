// startAalis 子命令模式的 e2e 入口——由 test/integration/start-aalis-subcommand.test.ts 经 tsx
// 在临时目录（cwd）里以子进程方式运行。只走 runtime **源码**（start.ts），不依赖 runtime dist。
//
// 环境变量：
//   AALIS_E2E_MODE     'subcommand'（默认；按 process.argv 分发）| 'default-loader'（不传插件加载器）| 'no-app-dir'（不传 appDir）| 'daemon'（argv 见 AALIS_E2E_ARGV，
//                      startAalis 返回后自发 AALIS_E2E_SIGNAL（缺省 SIGTERM；逗号隔开的几个依次发），验证守护路径的文件日志与优雅退出仍在；
//                      给了 AALIS_E2E_OUTPUT_ERROR 时 stdout 的底层写从此以这个错误码失败，再经 console.log 写一行，
//                      这时只在给了 AALIS_E2E_SIGNAL 时才发信号）|
//                      'tty'（守护进程，另载终端界面插件，e2e-probe 收尾时记一条 warn、经控制台日志写到 stderr；未捕获的异常
//                      当场记进 cwd/uncaught.txt，fatal handler 的崩溃日志是异步追加的，赶不上先落定的停机；startAalis
//                      返回后写 cwd/ready，不自发信号，由测试关掉它所在的伪终端）|
//                      'tty-respawn'（守护进程，启动后经 host-restart 服务启动第二代进程：respawn 出来的后代自成会话，关掉终端时收不到
//                      SIGHUP。第二代启动后当即并且之后每 100ms 记一条 warn（经控制台日志写到 stderr），随后写 cwd/ready（内容为本进程与
//                      父进程的 pid），退出时把退出码记进 cwd/gen2-exit.txt，未捕获的异常同 'tty' 记进 cwd/uncaught.txt）
//   AALIS_E2E_ARGV     'daemon'、'tty'、'tty-respawn' 传给 startAalis 的 argv（空格隔开，缺省为空），如 --service
//   AALIS_E2E_SLOW_MS  内联插件 onDispose 的延迟毫秒数（>=500 即让 app.stop 慢过重启策略的等待窗口）
//   AALIS_E2E_STARTUP_SIGNAL  startAalis 还没返回时给自己发这个信号，验证启动途中收到终止信号同样走完停机：e2e-probe 的 apply 里发，
//                      并让这次 apply 再等 1 秒；写成 `<信号>@ready` 则改在它的就绪回调里发，回调再等 1 秒。收尾时写 cwd/disposed
//   AALIS_E2E_RESTART_SIGNAL  'restart' 模式的第一代请求重启之后 800ms（重启的停机已开始，配 AALIS_E2E_SLOW_MS 让它还没停完）
//                      给自己发这个信号：验证重启途中收到终止信号时停下、不再启动第二代。写成 `<信号>@gen2` 则等第二代的 e2e-probe
//                      开始激活（它已接上信号处理，写下 cwd/gen2-applying）才发，配 AALIS_E2E_APPLY_MS 让第二代还没启动完
//   AALIS_E2E_APPLY_MS 设了才多登记几个内联插件：e2e-slow 提供 e2e-slow-svc，其 apply 延迟这么多毫秒（验证配置里的
//                      慢操作阈值）；e2e-waiting 依赖 e2e-slow-svc 与没人提供的 e2e-missing-svc，e2e-patient 只依赖
//                      e2e-slow-svc，e2e-chained 依赖 e2e-middle 提供的服务、e2e-middle 又依赖激活失败的 e2e-broken 提供的
//                      （验证启动收敛后的告警：缺的沿链追到根，只在等的不算缺）
//
// 代数护栏：cwd/gen.txt 记录本入口被启动的次数。若 host-restart 在子命令模式下被错误提供，`restart`
// 子命令会 spawn 一个 argv 仍带 restart 的 detached 子进程——第二代在这里立刻退出，不再往下走，
// 测试据 gen.txt 断言只有一代。
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, definePlugin, defineService, lifecycle, logger, provide, services } from '@aalis/core';
import { commands } from '../../packages/api-commands/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { hostLogs } from '../../packages/api-host-logs/src/index.js';
import { hostPaths } from '../../packages/api-host-paths/src/index.js';
import { hostRestart } from '../../packages/api-host-restart/src/index.js';
import { pluginSource } from '../../packages/api-plugin-source/src/index.js';
import { type StartAalisOptions, startAalis } from '../../packages/runtime/src/start.js';

const GEN_FILE = resolve(process.cwd(), 'gen.txt');
const gen = (existsSync(GEN_FILE) ? Number(readFileSync(GEN_FILE, 'utf-8').trim() || '0') : 0) + 1;
writeFileSync(GEN_FILE, String(gen));
const mode = process.env.AALIS_E2E_MODE ?? 'subcommand';
// 'restart' 与 'tty-respawn' 模式的第一代经 host-restart 服务启动第二代进程，第二代照常运行；除此之外的第二次启动都是不该发生的
const respawns = mode === 'restart' || mode === 'tty-respawn';
if (gen > (respawns ? 2 : 1)) process.exit(99);
const slowMs = Number(process.env.AALIS_E2E_SLOW_MS ?? '0');
const [startupSignal, startupAt] = (process.env.AALIS_E2E_STARTUP_SIGNAL ?? '').split('@');
const [restartSignal, restartAt] = (process.env.AALIS_E2E_RESTART_SIGNAL ?? '').split('@');
const GEN2_APPLYING = resolve(process.cwd(), 'gen2-applying');
if (mode === 'tty' || mode === 'tty-respawn') {
  process.on('uncaughtException', err => appendFileSync(resolve(process.cwd(), 'uncaught.txt'), `${String(err)}\n`));
}

const plugin = definePlugin({
  name: 'e2e-probe',
  provides: [commands],
  configSchema: {
    known: { type: 'number', label: 'K', default: 7 },
    nested: { label: 'N', fields: { filled: { type: 'number', label: 'F', default: 9 } } },
    // 密钥字段：值存进 secrets.yaml，first-config.json 记下的是解析后的原值
    token: { type: 'string', label: 'T', secret: true },
  },
  uses: { provide, lifecycle, services, config, logger },
  async apply({ provide, lifecycle, services, config, logger }) {
    writeFileSync(resolve(process.cwd(), 'first-config.json'), JSON.stringify(config.use));
    if (gen === 2 && restartAt === 'gen2') writeFileSync(GEN2_APPLYING, '');
    provide.use(commands, {
      has: (name: string) => name === 'probe' || name === 'restart',
      async execute(name: string, input: { args: string[] }) {
        // probe paths：交出宿主给插件的数据目录与 profile
        if (name === 'probe' && input.args[0] === 'paths') {
          const paths = services.use.get('host-paths') as { data: string; profile?: string };
          return `paths ${JSON.stringify({ data: paths.data, profile: paths.profile ?? null })}`;
        }
        if (name === 'probe') return `probe ok ${input.args.join(' ')}`.trim();
        // 镜像 CommandRegistry：handler 抛错折成「指令执行失败」文本，不向上抛。宿主不提供 host-restart 时指令插件
        // 拿到的是「服务不可用」
        const host = services.use.get('host-restart') as { restart(): void } | undefined;
        if (!host) return '指令执行失败: 服务 "host-restart" 不可用';
        try {
          host.restart();
          return '正在重启应用…';
        } catch (err) {
          return `指令执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as never);
    lifecycle.use.onDispose(async () => {
      if (slowMs > 0) await new Promise<void>(r => setTimeout(r, slowMs));
      if (mode === 'tty') logger.use.warn('e2e-probe 收尾');
      if (startupSignal) writeFileSync(resolve(process.cwd(), 'disposed'), '');
    });
    const interrupt = async () => {
      process.kill(process.pid, startupSignal);
      await new Promise<void>(r => setTimeout(r, 1000));
    };
    if (startupSignal && startupAt === 'ready') lifecycle.use.onReady(interrupt);
    else if (startupSignal) await interrupt();
  },
});
export default plugin;

const applyMs = process.env.AALIS_E2E_APPLY_MS;
const slowService = defineService<object>('e2e-slow-svc');
const slowPlugin = definePlugin({
  name: 'e2e-slow',
  provides: [slowService],
  uses: { provide },
  async apply({ provide }) {
    provide.use(slowService, {});
    await new Promise<void>(r => setTimeout(r, Number(applyMs)));
  },
});
const waitingPlugin = definePlugin({
  name: 'e2e-waiting',
  uses: { slow: slowService, missing: defineService<object>('e2e-missing-svc') },
  apply() {},
});
const patientPlugin = definePlugin({ name: 'e2e-patient', uses: { slow: slowService }, apply() {} });
const brokenService = defineService<object>('e2e-broken-svc');
const middleService = defineService<object>('e2e-middle-svc');
const brokenPlugin = definePlugin({
  name: 'e2e-broken',
  provides: [brokenService],
  apply() {
    throw new Error('缺少配置项 apiKey');
  },
});
const middlePlugin = definePlugin({
  name: 'e2e-middle',
  provides: [middleService],
  uses: { provide, broken: brokenService },
  apply({ provide }) {
    provide.use(middleService, {});
  },
});
const chainedPlugin = definePlugin({ name: 'e2e-chained', uses: { middle: middleService }, apply() {} });
const inline = [
  ...(applyMs === undefined
    ? [plugin]
    : [plugin, slowPlugin, waitingPlugin, patientPlugin, brokenPlugin, middlePlugin, chainedPlugin]),
  ...(mode === 'tty' ? [(await import('../../packages/plugin-cli/src/index.js')).default] : []),
];

const pluginLoader = {
  async discover() {
    return inline.map(p => ({ name: p.name, source: 'inline' }));
  },
  async load(descriptor: { name: string }) {
    return inline.find(p => p.name === descriptor.name) ?? plugin;
  },
};

// 'default-loader'：不传插件加载器，走默认的 node_modules 加载器；安装集取 AALIS_E2E_APP_DIR，不给则取 cwd。
// 'no-app-dir'：不传 appDir（经类型断言绕过必填）
const opts = {
  ...(mode === 'default-loader' ? {} : { pluginLoader }),
  ...(mode === 'no-app-dir' ? {} : { appDir: process.env.AALIS_E2E_APP_DIR ?? process.cwd() }),
  consoleSink: false,
  ...(mode === 'daemon' || mode === 'tty' || mode === 'tty-respawn'
    ? { argv: (process.env.AALIS_E2E_ARGV ?? '').split(' ').filter(Boolean) }
    : {}),
} as StartAalisOptions;
const app = await startAalis(opts);
if (mode === 'tty') writeFileSync(resolve(process.cwd(), 'ready'), String(process.pid));
// 'restart' 模式的第一代：守护进程启动后请求重启。前台由重启策略启动第二代进程并交出实例锁，第二代就绪后
// 第一代退出；以 --service 启动时第一代停掉后以服务重启的退出码结束，由服务管理器重新启动进程（这里没有服务管理器）。
if (respawns && gen === 1) {
  writeFileSync(resolve(process.cwd(), 'gen1-pid.txt'), String(process.pid));
  (app.bind({ services }).services.use.get('host-restart') as { restart(): void }).restart();
  if (restartSignal && restartAt === 'gen2') {
    const poll = setInterval(() => {
      if (!existsSync(GEN2_APPLYING)) return;
      clearInterval(poll);
      process.kill(process.pid, restartSignal);
    }, 20);
  } else if (restartSignal) setTimeout(() => process.kill(process.pid, restartSignal), 800);
}
if (mode === 'tty-respawn' && gen === 2) {
  process.on('exit', code => writeFileSync(resolve(process.cwd(), 'gen2-exit.txt'), String(code)));
  const beat = () => app.logger.warn('e2e 第二代在跑');
  beat();
  setInterval(beat, 100);
  writeFileSync(resolve(process.cwd(), 'ready'), `${process.pid} ${process.ppid}`);
}
// 守护路径：startAalis 已挂好信号处理器，自发一次走优雅退出（app.stop → flush → exit 0）。
// 退出前经宿主提供的插件来源重扫一次，记下返回的新登记名单（插件都已注册，应为空）与 e2e-probe 是不是经它加载的；
// 再记下宿主装配的配置文档：host-config 是否在根上、文档里的服务偏好是否已应用；以及宿主提供的服务里哪些拒绝再登记一个提供者。
if (mode === 'daemon' || (mode === 'restart' && gen === 2)) {
  const host = app.bind({ services }).services.use;
  const rescanned = await host.get(pluginSource)?.rescan();
  writeFileSync(resolve(process.cwd(), 'rescan.json'), JSON.stringify(rescanned ?? null));
  const loaded = host.get(pluginSource)?.loaded('e2e-probe');
  writeFileSync(resolve(process.cwd(), 'loaded.json'), JSON.stringify(loaded ?? null));
  // 实例锁：交接令牌已从环境里删掉；守护期间 run/ 里只有本进程这一代锁
  const run = host.get(hostPaths)?.run;
  const locks = run ? readdirSync(run).filter(n => n.endsWith('.lock')) : [];
  const holderOf = (name: string) =>
    (JSON.parse(readFileSync(resolve(run ?? '', name), 'utf-8')) as { pid: number }).pid;
  writeFileSync(
    resolve(process.cwd(), 'lock.json'),
    JSON.stringify({
      handoffInEnv: process.env.AALIS_LOCK_HANDOFF !== undefined,
      locks,
      selfHolds: locks.length === 1 && holderOf(locks[0]!) === process.pid,
    }),
  );
  writeFileSync(
    resolve(process.cwd(), 'host.json'),
    JSON.stringify({
      probeConfig: host.get(hostConfig)?.getPluginConfig('e2e-probe') ?? null,
      preferred: host.preferred(commands) ?? null,
    }),
  );
  const root = app.bind({ provide });
  const exclusive = [hostPaths, hostLogs, hostConfig, hostRestart, pluginSource].filter(descriptor => {
    try {
      root.provide.use(descriptor as never, {} as never)();
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'exclusive-conflict';
    }
  });
  writeFileSync(resolve(process.cwd(), 'exclusive.json'), JSON.stringify(exclusive.map(d => d.name)));
  // 写出错走 console 的真实路径：底层写失败，错误由流在下一拍发出。前面的写还在途时，排队的块经 _writev 一并写出
  const outputError = process.env.AALIS_E2E_OUTPUT_ERROR;
  if (outputError) {
    const fail = (callback: (err: Error) => void) =>
      callback(Object.assign(new Error(`write ${outputError}`), { code: outputError }));
    process.stdout._write = (_chunk, _encoding, callback) => fail(callback);
    process.stdout._writev = (_chunks, callback) => fail(callback);
    console.log('e2e 输出写出错');
    // 等写出错处理完再记一条、再发信号：用例按它与停机日志的先后分出停机是谁引起的
    await new Promise<void>(r => setImmediate(r));
    app.logger.info('e2e 写出错已处理');
  }
  const signals = process.env.AALIS_E2E_SIGNAL ?? (outputError ? '' : 'SIGTERM');
  for (const signal of signals.split(',').filter(Boolean)) process.kill(process.pid, signal);
}
