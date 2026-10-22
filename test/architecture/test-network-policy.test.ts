import { connect, Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { assertNoRefusedConnections, assertTestNetworkTarget, installConnectGuard } from '../helpers/network-policy.js';

/**
 * 在一层只拦不连的哨兵上面另装一道护栏，跑完 fn 再撤掉，返回哨兵被走到的次数。护栏万一失效，连接落到哨兵上，
 * 不会真连到这些端口
 */
async function overSentinel(fn: () => unknown): Promise<number> {
  const installed = Socket.prototype.connect;
  let hits = 0;
  Socket.prototype.connect = (() => {
    hits++;
    throw new Error('哨兵：连接越过了护栏');
  }) as typeof installed;
  try {
    installConnectGuard();
    await fn();
  } finally {
    Socket.prototype.connect = installed;
  }
  return hits;
}

describe('测试连接本机生产服务的限制', () => {
  it.each([
    [27017, 'localhost'],
    ['27017', '127.0.0.1'],
    [{ port: 27017, host: '::1' }],
    [[{ port: '27017', host: 'localhost' }, () => {}]],
  ])('各种连接参数形式都认得出端口并拒绝 %j', (...args) => {
    expect(() => assertTestNetworkTarget(args)).toThrow('连了本机端口 27017');
    expect(assertNoRefusedConnections).toThrow('27017');
  });

  it.each([3000, 3001, 6099, 7861, 8080, 11434, 17878, 27017])('端口 %i 被拒，报错写明用例与端口', port => {
    expect(() => assertTestNetworkTarget([{ port, host: '127.0.0.1' }])).toThrow(
      `测试「${expect.getState().currentTestName}」连了本机端口 ${port}`,
    );
    expect(assertNoRefusedConnections).toThrow(String(port));
  });

  it('不影响随机端口上的本地桩或管道参数', () => {
    expect(() => assertTestNetworkTarget([{ port: 49152, host: 'localhost' }])).not.toThrow();
    expect(() => assertTestNetworkTarget(['/tmp/test.sock'])).not.toThrow();
  });

  it('fetch 连本机生产服务端口立即失败', async () => {
    const hits = await overSentinel(() =>
      expect(fetch('http://127.0.0.1:17878/')).rejects.toMatchObject({
        cause: { message: expect.stringContaining('连了本机端口 17878') },
      }),
    );
    expect(hits).toBe(0);
    expect(assertNoRefusedConnections).toThrow('17878');
  });

  it('node:net 连本机生产服务端口在连接动作前抛出', async () => {
    const hits = await overSentinel(() =>
      expect(() => connect({ host: '127.0.0.1', port: 7861 }).on('error', () => {})).toThrow('连了本机端口 7861'),
    );
    expect(hits).toBe(0);
    expect(assertNoRefusedConnections).toThrow('7861');
  });
});
