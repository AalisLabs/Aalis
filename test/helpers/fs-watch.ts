import { renameSync, writeFileSync } from 'node:fs';

// FsYamlConfigProvider 监听测试的计时与写盘辅助。去抖时长写死在 providers.ts 里、没有导出，这里对齐同一个值。
const DEBOUNCE_MS = 300;

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 轮询等待条件成立；成立即返回，超时返回最后一次判定。 */
export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/** 静默期：等足去抖 + 余量，用于断言「不该触发」。 */
export const quiet = (): Promise<void> => sleep(DEBOUNCE_MS + 500);

/**
 * 等 fs.watch 真正武装完毕。macOS 的 FSEvents 后端建流是异步的，arm 之后立刻写
 * 有可能被漏掉——不等这一下，「没触发」既可能是缺陷也可能是竞态，测试就没有判别力了。
 * 同时等武装即对账的那一轮去抖走完，免得它与紧随其后的写入交错成两次投递。
 */
export const settle = (): Promise<void> => sleep(DEBOUNCE_MS + 150);

/** 原子替换——编辑器/`sed -i`/`vim` 默认保存的做法，会换掉 inode。 */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, path);
}
