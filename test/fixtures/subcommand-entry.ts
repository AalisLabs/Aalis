// startAalis 子命令模式的 e2e 入口——由 test/integration/start-aalis-subcommand.test.ts 经 tsx
// 在临时目录（cwd）里以子进程方式运行。只走 runtime **源码**（start.ts），不依赖 runtime dist。
//
// 环境变量：
//   AALIS_E2E_MODE     'subcommand'（默认；按 process.argv 分发）| 'daemon'（传 subcommands: []，
//                      startAalis 返回后自发 SIGTERM，验证守护路径的文件日志与优雅退出仍在）
//   AALIS_E2E_SLOW_MS  内联插件 onDispose 的延迟毫秒数（>=500 即让 app.stop 慢过重启策略的等待窗口）
//
// 代数护栏：cwd/gen.txt 记录本入口被启动的次数。若重启策略在子命令模式下被错误注入，`restart`
// 子命令会 spawn 一个 argv 仍带 restart 的 detached 子进程——第二代在这里立刻退出，不再往下走，
// 测试据 gen.txt 断言只有一代。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commands } from '../../packages/api-commands/src/index.js';
import { definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import { startAalis } from '../../packages/runtime/src/start.js';

const GEN_FILE = resolve(process.cwd(), 'gen.txt');
const gen = (existsSync(GEN_FILE) ? Number(readFileSync(GEN_FILE, 'utf-8').trim() || '0') : 0) + 1;
writeFileSync(GEN_FILE, String(gen));
if (gen > 1) process.exit(99);

const mode = process.env.AALIS_E2E_MODE ?? 'subcommand';
const slowMs = Number(process.env.AALIS_E2E_SLOW_MS ?? '0');

const plugin = definePlugin({
  name: 'e2e-probe',
  provides: [commands],
  uses: { provide, lifecycle, services },
  apply({ provide, lifecycle, services }) {
    provide(commands, {
      has: (name: string) => name === 'probe' || name === 'restart',
      async execute(name: string, input: { args: string[] }) {
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

const pluginLoader = {
  async discover() {
    return [{ name: plugin.name, source: 'inline' }];
  },
  async load() {
    return plugin;
  },
};

const app = await startAalis({
  pluginLoader,
  consoleSink: false,
  terminalRestore: false,
  ...(mode === 'daemon' ? { subcommands: [] } : {}),
});
// 守护路径：startAalis 已挂好 SIGTERM 处理器，自发一次走优雅退出（app.stop → flush → exit 0）。
if (mode === 'daemon') {
  void app;
  process.kill(process.pid, 'SIGTERM');
}
