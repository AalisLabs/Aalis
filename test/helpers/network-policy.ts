import { Socket } from 'node:net';
import { expect } from 'vitest';

/**
 * 本机服务的默认端口：测试连它们可能打到这台机器上在跑的生产服务。来源是第一方插件的默认配置——
 * WebUI 3000、MCP 服务 7861、OneBot 示例地址 8080、Ollama 11434、Laya 侧车 17878、MongoDB 27017，
 * 加上 NapCat 的默认端口（HTTP 3000、WebSocket 3001、WebUI 6099）。只看端口不看主机：能解析到本机的名字不止
 * localhost 与回环地址。本地桩监听在随机端口，不受影响
 */
const PRODUCTION_PORTS = new Set([3000, 3001, 6099, 7861, 8080, 11434, 17878, 27017]);

const refused: string[] = [];

/** 连向本机生产服务端口的连接在连接动作前抛出，报错写明用例与端口，并记下来留给 assertNoRefusedConnections */
export function assertTestNetworkTarget(args: readonly unknown[]): void {
  let target = args[0];
  // net.createConnection 内部可以把标准化后的参数数组交给 Socket.connect。
  while (Array.isArray(target)) target = target[0];
  const port = Number(typeof target === 'object' && target !== null ? (target as { port?: unknown }).port : target);
  if (!PRODUCTION_PORTS.has(port)) return;
  const { currentTestName, testPath } = expect.getState();
  const message = `测试「${currentTestName ?? testPath}」连了本机端口 ${port}：测试不得连本机的生产服务，先换好替身或用随机端口上的本地桩`;
  refused.push(message);
  throw new Error(message);
}

/**
 * 在 Socket.prototype.connect 现有的实现上面装一道护栏：连接动作之前先过 assertTestNetworkTarget。fetch 与 undici 的连接
 * 同样经过这里。不使用 vi.spyOn：测试里的 restoreAllMocks 不应撤掉这道连接限制
 */
export function installConnectGuard(): void {
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: Parameters<typeof connect>) {
    assertTestNetworkTarget(args);
    return Reflect.apply(connect, this, args);
  } as typeof connect;
}

/** 被测代码吞掉了被拒的连接（如插件启动时的探测失败只记日志）时，在用例结束时报出来 */
export function assertNoRefusedConnections(): void {
  if (refused.length > 0) throw new Error(refused.splice(0).join('\n'));
}
