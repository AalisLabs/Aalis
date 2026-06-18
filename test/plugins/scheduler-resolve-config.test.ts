import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../packages/plugin-scheduler/src/index.js';

// ════════════════════════════════════════════════════════════
// scheduler resolveConfig：静态 YAML job 的 runAt/actor/timeZone 透传
//   回归此前 resolveConfig 静默丢弃这些 schema 已声明字段的 bug。
// ════════════════════════════════════════════════════════════

describe('resolveConfig 静态任务字段透传', () => {
  it('保留 runAt / actorPlatform / actorUserId / timeZone（此前被丢弃）', () => {
    const cfg = resolveConfig({
      jobs: [
        {
          name: 'j1',
          cron: '@daily',
          content: '提醒',
          runAt: '2030-01-01T00:00:00Z',
          actorPlatform: 'onebot',
          actorUserId: '123',
          timeZone: 'Asia/Shanghai',
        },
      ],
    });
    expect(cfg.jobs[0]).toMatchObject({
      name: 'j1',
      runAt: '2030-01-01T00:00:00Z',
      actorPlatform: 'onebot',
      actorUserId: '123',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('缺省字段不报错、actor 留空（由触发时回填默认）', () => {
    const cfg = resolveConfig({ jobs: [{ name: 'j2', interval: 60, content: 'x' }] });
    expect(cfg.jobs[0].actorPlatform).toBeUndefined();
    expect(cfg.jobs[0].timeZone).toBeUndefined();
  });
});
