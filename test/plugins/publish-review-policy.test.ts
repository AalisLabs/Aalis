import { describe, expect, it } from 'vitest';
import { configSchema } from '../../packages/plugin-publish-review/src/config.js';
import { decideReview } from '../../packages/plugin-publish-review/src/policy.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

describe('公开作品人工审核策略', () => {
  it('缺省关闭人工审核，自动审核放行后没有隐藏的人工关卡', () => {
    const config = parseConfig(configSchema, {});
    expect(config.manualReview).toBe(false);
    expect(decideReview(config, { verdict: 'allow', reasons: [] })).toEqual({ state: 'approved' });
  });

  it('显式开启时，自动通过的作品进入人工审核', () => {
    const config = parseConfig(configSchema, { manualReview: true });
    expect(decideReview(config, { verdict: 'allow', reasons: [] })).toEqual({ state: 'awaiting-owner' });
  });

  it.each([false, true])('人工开关 %s 下自动拒绝都转人工，处理失败仍不可批准', manualReview => {
    expect(decideReview({ manualReview }, { verdict: 'reject', reasons: ['内容不适合公开'] })).toMatchObject({
      state: 'awaiting-owner',
    });
    expect(decideReview({ manualReview }, { verdict: 'failed', reasons: ['文件处理失败'] })).toEqual({
      state: 'failed',
      reasons: ['文件处理失败'],
    });
  });

  it('自动审核不确定时，无论开关都进入人工队列', () => {
    const result = { verdict: 'unsure', reasons: ['离线渲染不可用'] } as const;
    expect(decideReview({ manualReview: false }, result)).toMatchObject({ state: 'awaiting-owner' });
    expect(decideReview({ manualReview: true }, result)).toMatchObject({ state: 'awaiting-owner' });
  });

  it('无效的人工审核设置拒绝激活，不能把本想开启的设置静默变成关闭', () => {
    expect(() => parseConfig(configSchema, { manualReview: 'sometimes' })).toThrow();
  });
});
