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

  // resolveConfig 只做透传，不填默认——静态 YAML 的 owner 缺省补在配置载入处（见 apply()），
  // 触发路径不再为空 actor 发明身份。守这条的是 scheduler-actor-identity.test.ts。
  it('缺省字段不报错、actor 留空（默认由配置载入处补，非透传层）', () => {
    const cfg = resolveConfig({ jobs: [{ name: 'j2', interval: 60, content: 'x' }] });
    expect(cfg.jobs[0].actorPlatform).toBeUndefined();
    expect(cfg.jobs[0].timeZone).toBeUndefined();
  });

  // YAML 反序列化不受 TS 类型约束 —— schema 声明 string 不代表拿到的是 string。
  // QQ 号在 YAML 里天然写成不带引号的 `actorUserId: 10001`，于是拿到 number，
  // 下游 `.trim()` 抛 "is not a function"。而那个 .trim() 在 apply() 顶层（无 try），
  // 一抛就是 `ctx.provide('scheduler', ...)` 不执行 → **所有定时任务全死**。
  //
  // 这类用例此前整类缺失：写测试时手上是 TS 类型，就只喂合法值。凡是「schema 声明
  // string、来源是 YAML/JSON」的字段，都该有一条非字符串的用例。
  it('数字型 actorUserId（YAML 里不带引号的 QQ 号）被转成字符串，不留给下游 .trim() 去炸', () => {
    const cfg = resolveConfig({
      jobs: [{ name: 'j3', interval: 60, content: 'x', actorPlatform: 'onebot', actorUserId: 10001 }],
    });
    expect(cfg.jobs[0].actorUserId).toBe('10001');
    expect(() => cfg.jobs[0].actorUserId?.trim()).not.toThrow();
  });

  it('null 不被转成字符串 "null"（那会变成一个真实存在的、谁也不是的身份）', () => {
    const cfg = resolveConfig({
      jobs: [{ name: 'j4', interval: 60, content: 'x', actorPlatform: null, actorUserId: null }],
    });
    expect(cfg.jobs[0].actorPlatform).toBeUndefined();
    expect(cfg.jobs[0].actorUserId).toBeUndefined();
  });
});
