// startAalis 子命令模式的 e2e 入口——由 test/integration/start-aalis-subcommand.test.ts 经 tsx
// 在临时目录（cwd）里以子进程方式运行。只走 runtime **源码**（start.ts），不依赖 runtime dist。
//
// 环境变量：
//   AALIS_E2E_MODE     'subcommand'（默认；按 process.argv 分发）| 'default-loader'（不传插件加载器）| 'daemon'（传 argv: []，
//                      startAalis 返回后自发 SIGTERM，验证守护路径的文件日志与优雅退出仍在）
//   AALIS_E2E_SLOW_MS  内联插件 onDispose 的延迟毫秒数（>=500 即让 app.stop 慢过重启策略的等待窗口）
//   AALIS_E2E_APPLY_MS 设了才多登记两个内联插件：e2e-slow 提供 e2e-slow-svc，其 apply 延迟这么多毫秒（验证配置里的
//                      慢操作阈值）；e2e-waiting 依赖 e2e-slow-svc 与没人提供的 e2e-missing-svc（验证启动收敛后的 pending 告警）
//
// 代数护栏：cwd/gen.txt 记录本入口被启动的次数。若重启策略在子命令模式下被错误注入，`restart`
// 子命令会 spawn 一个 argv 仍带 restart 的 detached 子进程——第二代在这里立刻退出，不再往下走，
// 测试据 gen.txt 断言只有一代。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config, definePlugin, defineService, lifecycle, provide, services } from '@aalis/core';
import { commands } from '../../packages/api-commands/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import { hostPaths } from '../../packages/api-host-paths/src/index.js';
import { pluginSource } from '../../packages/api-plugin-source/src/index.js';
import { startAalis } from '../../packages/runtime/src/start.js';

const GEN_FILE = resolve(process.cwd(), 'gen.txt');
const gen = (existsSync(GEN_FILE) ? Number(readFileSync(GEN_FILE, 'utf-8').trim() || '0') : 0) + 1;
writeFileSync(GEN_FILE, String(gen));
const mode = process.env.AALIS_E2E_MODE ?? 'subcommand';
// 'restart' 模式的第一代经 app.restart() 拉起第二代，第二代照常运行；除此之外第二次启动都是被错误拉起的
if (gen > (mode === 'restart' ? 2 : 1)) process.exit(99);
const slowMs = Number(process.env.AALIS_E2E_SLOW_MS ?? '0');

const plugin = definePlugin({
  name: 'e2e-probe',
  provides: [commands],
  configSchema: {
    known: { type: 'number', label: 'K', default: 7 },
    nested: { label: 'N', fields: { filled: { type: 'number', label: 'F', default: 9 } } },
  },
  uses: { provide, lifecycle, services, config },
  apply({ provide, lifecycle, services, config }) {
    writeFileSync(resolve(process.cwd(), 'first-config.json'), JSON.stringify(config));
    provide(commands, {
      has: (name: string) => name === 'probe' || name === 'restart',
      async execute(name: string, input: { args: string[] }) {
        // probe paths：交出宿主给插件的家目录与 profile
        if (name === 'probe' && input.args[0] === 'paths') {
          const paths = services.get('host-paths') as { home: string; profile?: string };
          return `paths ${JSON.stringify({ home: paths.home, profile: paths.profile ?? null })}`;
        }
        if (name === 'probe') return `probe ok ${input.args.join(' ')}`.trim();
        // 镜像 CommandRegistry：handler 抛错折成「指令执行失败」文本，不向上抛。
        try {
          (services.get('app') as { restart(): void }).restart();
          return '正在重启应用…';
        } catch (err) {
          return `指令执行失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as never);
    lifecycle.onDispose(async () => {
      if (slowMs > 0) await new Promise<void>(r => setTimeout(r, slowMs));
    });
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
    provide(slowService, {});
    await new Promise<void>(r => setTimeout(r, Number(applyMs)));
  },
});
const waitingPlugin = definePlugin({
  name: 'e2e-waiting',
  uses: { slow: slowService, missing: defineService<object>('e2e-missing-svc') },
  apply() {},
});
const inline = applyMs === undefined ? [plugin] : [plugin, slowPlugin, waitingPlugin];

const pluginLoader = {
  async discover() {
    return inline.map(p => ({ name: p.name, source: 'inline' }));
  },
  async load(descriptor: { name: string }) {
    return inline.find(p => p.name === descriptor.name) ?? plugin;
  },
};

// 'default-loader'：不传插件加载器，走默认的 node_modules 加载器；安装集取 AALIS_E2E_APP_DIR（不给则用缺省的 <家目录>/app）
const appDir = process.env.AALIS_E2E_APP_DIR;
const app = await startAalis({
  ...(mode === 'default-loader' ? {} : { pluginLoader }),
  ...(appDir ? { appDir } : {}),
  consoleSink: false,
  terminalRestore: false,
  ...(mode === 'daemon' ? { argv: [] } : {}),
});
// 'restart' 模式的第一代：守护进程起来后调 app.restart()。前台由重启策略拉起第二代并交出实例锁，第二代就绪后
// 第一代退出；以 --service 启动时第一代停掉后以服务重启的退出码结束，由服务管理器拉起（这里没有服务管理器）。
if (mode === 'restart' && gen === 1) {
  writeFileSync(resolve(process.cwd(), 'gen1-pid.txt'), String(process.pid));
  (app.bind({ services }).services.get('app') as { restart(): void }).restart();
}
// 守护路径：startAalis 已挂好 SIGTERM 处理器，自发一次走优雅退出（app.stop → flush → exit 0）。
// 退出前经宿主提供的插件来源重扫一次，记下返回的新登记名单（插件都已注册，应为空）；
// 再记下宿主装配的配置文档：host-config 是否在根上、文档里的服务偏好是否已应用。
if (mode === 'daemon' || (mode === 'restart' && gen === 2)) {
  const host = app.bind({ services }).services;
  const rescanned = await host.get(pluginSource)?.rescan();
  writeFileSync(resolve(process.cwd(), 'rescan.json'), JSON.stringify(rescanned ?? null));
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
  process.kill(process.pid, 'SIGTERM');
}
