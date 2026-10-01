// 实例锁竞争测试的参赛进程（test/integration/instance-lock-race.test.ts 经 tsx 起多份）：
// 起来后在 stdout 报 READY，等发令文件出现再一起取锁，报 OK 或 BUSY；取到的一直持锁，直到收场文件出现再放，
// 保证慢一步的参赛者看到的是活着的持有者。两个文件都等不到时 30 秒后自己退出，不留孤儿进程。
import { existsSync } from 'node:fs';
import { acquireInstanceLock } from '../../packages/runtime/src/instance-lock.js';

const [runDir, goFile, doneFile] = process.argv.slice(2) as [string, string, string];
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const deadline = Date.now() + 30_000;
async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) {
    if (Date.now() > deadline) process.exit(3);
    await sleep(2);
  }
}

process.stdout.write('READY\n');
await waitFor(goFile);
const r = acquireInstanceLock(runDir);
process.stdout.write(r.ok ? 'OK\n' : 'BUSY\n');
if (r.ok) {
  await waitFor(doneFile);
  r.lock.release();
}
