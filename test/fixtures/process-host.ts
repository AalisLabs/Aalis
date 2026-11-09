// 扮演宿主的进程（test/plugins/process-local-lifetime.test.ts 经 `node --import tsx` 启动，@aalis/* 按 tsconfig.test.json
// 指到各包 src）。子进程 30 秒后自己退出，不留孤儿。
//   kill：经 process-local 启动两个进程组，一个照常、一个忽略 SIGTERM，在 stdout 报出两个组号后保持运行，等测试 kill -9 它；
//   bounce：经插件启动一个进程组、报出组号，bounce 本插件后正常停机并退出。
import { processService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import processLocal, { LocalProcessService } from '../../packages/plugin-process-local/src/index.js';

const [mode] = process.argv.slice(2);

if (mode === 'bounce') {
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugin(processLocal);
  await app.plugins.idle();
  const service = app.bind({ services }).services.use.get(processService);
  if (!service) throw new Error('process 服务未注册');
  process.stdout.write(`${service.spawn('sleep', ['30'], {}).pid}\n`);
  await app.plugins.bounce(processLocal.name);
  await app.stop();
  process.exit(0);
}

const service = new LocalProcessService({} as unknown as StorageService);
const plain = service.spawn('sleep', ['30'], {});
const stubborn = service.spawn('sh', ['-c', "trap '' TERM; echo trapped; sleep 30"], {});
// 等它装好 trap 再报：报完测试立刻 kill -9 宿主，此前看门进程发的 SIGTERM 会直接终止还没装 trap 的 sh
await new Promise(ready => stubborn.stdout?.once('data', ready));
process.stdout.write(`${plain.pid} ${stubborn.pid}\n`);
