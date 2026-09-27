import { describe, expect, it } from 'vitest';
import { inferSessionScope, resolveSessionOrigin } from '../../packages/api-gateway/src/index.js';

// 出生平台解析：只看会话 id，给选档与会话分区一个同步判据。

describe('resolveSessionOrigin', () => {
  it('房间会话取第一个冒号之前的一段为出生平台，类型段为 private 的是私聊，其余一律按群', () => {
    expect(resolveSessionOrigin('onebot:10000:group:20001')).toEqual({ platform: 'onebot', audience: 'group' });
    expect(resolveSessionOrigin('onebot:10000:private:30001')).toEqual({ platform: 'onebot', audience: 'private' });
    expect(resolveSessionOrigin('onebot:10000:channel:40001:50001')).toEqual({ platform: 'onebot', audience: 'group' });
    // 不按四段约定写的 id 同样钉死，不认识的类型段往保守的方向按群算
    expect(resolveSessionOrigin('someplatform:x')).toEqual({ platform: 'someplatform', audience: 'group' });
    expect(resolveSessionOrigin('onebot:10000:GUILD:20001')).toEqual({ platform: 'onebot', audience: 'group' });
  });

  it('子任务按父会话算', () => {
    expect(resolveSessionOrigin('onebot:10000:group:20001::abcd1234')).toEqual({
      platform: 'onebot',
      audience: 'group',
    });
    expect(resolveSessionOrigin('onebot:10000:private:30001::abcd1234')).toEqual({
      platform: 'onebot',
      audience: 'private',
    });
    expect(resolveSessionOrigin('onebot:10000:group:20001::abcd1234::efgh5678')).toEqual({
      platform: 'onebot',
      audience: 'group',
    });
  });

  it('截掉 :: 之后不含冒号的 id 不是房间，返回 undefined', () => {
    for (const id of [
      'session-abcd1234',
      'session-abcd1234::efgh5678',
      'webui-default',
      'cli-default',
      'mcp-server',
      'workflow::wf-1',
      'workflow::run-1::node-a',
      ':x',
    ]) {
      expect(resolveSessionOrigin(id), id).toBeUndefined();
    }
  });

  it('与 inferSessionScope 分工不同：子任务有出生平台，但不推断触发闸门里的会话类型', () => {
    const child = 'onebot:10000:group:20001::abcd1234';
    expect(resolveSessionOrigin(child)?.platform).toBe('onebot');
    expect(inferSessionScope('onebot', child)).toBeUndefined();
  });
});
