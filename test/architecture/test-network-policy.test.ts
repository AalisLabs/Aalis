import { describe, expect, it, vi } from 'vitest';
import { assertTestNetworkTarget } from '../helpers/network-policy.js';

describe('测试数据库连接限制', () => {
  it.each([
    [27017, 'localhost'],
    ['27017', '127.0.0.1'],
    [{ port: 27017, host: '::1' }],
    [[{ port: '27017', host: 'localhost' }, () => {}]],
  ])('各种连接参数形式都在连接动作前拒绝 %j', (...args) => {
    const connect = vi.fn();
    expect(() => {
      assertTestNetworkTarget(args);
      connect();
    }).toThrow('测试禁止连接 MongoDB');
    expect(connect).not.toHaveBeenCalled();
  });

  it('不影响本地 HTTP 探针或管道参数', () => {
    expect(() => assertTestNetworkTarget([{ port: 49152, host: 'localhost' }])).not.toThrow();
    expect(() => assertTestNetworkTarget(['/tmp/test.sock'])).not.toThrow();
  });
});
