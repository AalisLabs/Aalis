import { Socket } from 'node:net';
import { assertTestNetworkTarget } from '../helpers/network-policy.js';

const connect = Socket.prototype.connect;
// 不使用 vi.spyOn：测试里的 restoreAllMocks 不应撤掉这道连接限制。
Socket.prototype.connect = function (this: Socket, ...args: Parameters<typeof connect>) {
  assertTestNetworkTarget(args);
  return Reflect.apply(connect, this, args);
} as typeof connect;
