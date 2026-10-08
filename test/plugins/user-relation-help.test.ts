import { describe, expect, it } from 'vitest';
import { type AuthorityService, capabilityMinLevel } from '../../packages/api-authority/src/index.js';
import type { BoundCommands } from '../../packages/api-commands/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { type EvictionConfig, registerRelationCommands } from '../../packages/plugin-user-relation/src/commands.js';
import type { RelationService } from '../../packages/plugin-user-relation/src/index.js';

// ════════════════════════════════════════════════════════════
// /relation 与 /relation cleanup 两个分组登记了描述，帮助里不出现自动分组的占位文字；
// 0 级用户只看到四条公开的子指令，全是受限指令的清理分组整个不列。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
const caller = { platform: 'onebot', userId: '30001' };

/** 按声明的等级裁决：level 0 的人只过默认等级的指令；owner 全过 */
const authorityAt = (level: number) =>
  ({ authorize: (_who: unknown, req) => (capabilityMinLevel(req) > level ? '权限不足' : null) }) as AuthorityService;

function relationRegistry(level: number): CommandRegistry {
  const registry = new CommandRegistry(silent, () => authorityAt(level));
  const commands = {
    command: (name: string, description?: string, meta?: object) =>
      registry.command(name, description, { ...meta, pluginName: 'relation' }),
  } as unknown as BoundCommands;
  registerRelationCommands({ commands, platform: {}, llm: {}, logger: silent } as never, {} as RelationService, {
    eviction: {} as EvictionConfig,
    consolidateAutoLink: false,
    consolidateSkipLowScorePairs: false,
    consolidateLowScoreThreshold: 0,
  });
  return registry;
}

describe('/help relation', () => {
  it('0 级用户只看到公开的子指令，清理分组整个不列', () => {
    expect(relationRegistry(0).detail(['relation'], caller)).toBe(
      [
        '/relation — 关系图的查看、清理与维护',
        '',
        '用法：/relation <子指令>',
        '',
        '子指令：',
        '- /relation consolidation-status — 查看最近一次关系图整理的结果',
        '- /relation forget-me — 清理我自己在关系图中的节点与直接关联',
        '- /relation orphans — 列出图中所有孤立点（不被任何边引用）',
        '- /relation show — 查看关系图中某节点及其直连边',
      ].join('\n'),
    );
  });

  it('owner 看到全部；清理分组带自己的描述', () => {
    const registry = relationRegistry(Number.POSITIVE_INFINITY);
    expect(registry.detail(['relation'], caller)).toContain('- /relation cleanup — 清理关系图里的节点 · 6 个子指令');
    expect(registry.detail(['relation', 'cleanup'], caller).split('\n')[0]).toBe(
      '/relation cleanup — 清理关系图里的节点',
    );
  });
});

describe('/relation show', () => {
  it('id 是空串时回这一句，不回手写的用法', async () => {
    const reply = await relationRegistry(0).execute('relation', {
      sessionId: 's',
      platform: 'onebot',
      userId: '30001',
      args: ['show', 'person', ''],
      raw: '',
    });
    expect(reply).toBe('id 不能为空');
  });
});
