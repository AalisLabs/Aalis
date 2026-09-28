/** 即使数据库模块替身失效，测试也不得连接本机生产 MongoDB。 */
export function assertTestNetworkTarget(args: readonly unknown[]): void {
  let target = args[0];
  // net.createConnection 内部可以把标准化后的参数数组交给 Socket.connect。
  while (Array.isArray(target)) target = target[0];
  const port = typeof target === 'object' && target !== null ? (target as { port?: unknown }).port : target;
  if (Number(port) === 27017) throw new Error('测试禁止连接 MongoDB 端口 27017，请使用显式替身');
}
