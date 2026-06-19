import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';

// ════════════════════════════════════════════════════════════
// checkpoint 回合状态按会话隔离：两会话并发回合互不串台/覆盖，各自独立提交。
// （回归：此前全局单份 current 会被并发 begin/end 冲掉、错记或丢失保护。）
// ════════════════════════════════════════════════════════════

function makeService() {
  const writes: string[] = [];
  const storage = {
    writeFile: async (uri: string) => {
      writes.push(uri);
    },
    list: async () => [], // gc 用，返回空即 no-op
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const cfg = { rootUri: 'ckpt:/', maxFileSize: 1024 * 1024, keepSessions: 10, scopes: ['*'] };
  // 不注入 memory：commitTurn 跳过消息时间戳，仅凭文件改动判断是否落盘
  const svc = new CheckpointServiceImpl(cfg, logger as never, storage as never);
  return { svc, writes };
}

describe('checkpoint 回合按会话隔离', () => {
  it('两会话并发：begin/end 互不冲掉，各自独立提交 manifest', async () => {
    const { svc, writes } = makeService();
    svc.beginTurn('sessA');
    svc.beginTurn('sessB'); // 全局单份时代：B 的开始会把 A 的回合提前提交/冲掉
    expect(svc.isActive()).toBe(true);

    // 一次文件改动 → 记进所有活跃回合（A、B 各存一份 blob 到各自 turn 目录）
    await svc.beforeMutate('data:/x.txt', 'write', async () => ({ data: Buffer.from('orig'), size: 4 }));
    expect(writes.filter(u => u.includes('/blobs/')).length).toBe(2);

    await svc.endTurn('sessA');
    expect(svc.isActive()).toBe(true); // B 仍活跃，未被 A 的结束冲掉

    await svc.endTurn('sessB');
    expect(svc.isActive()).toBe(false);

    // A、B 各落一个 manifest
    expect(writes.filter(u => u.endsWith('manifest.json')).length).toBe(2);
  });

  it('endTurn 只结束指定会话；结束不存在的会话是幂等 no-op', async () => {
    const { svc } = makeService();
    svc.beginTurn('sessA');
    svc.beginTurn('sessB');
    await svc.endTurn('sessA');
    expect(svc.isActive()).toBe(true); // B 还在
    await svc.endTurn('sessC'); // 不存在的会话
    expect(svc.isActive()).toBe(true);
    await svc.endTurn('sessB');
    expect(svc.isActive()).toBe(false);
  });
});
