import type { Context } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { apply } from '../../packages/plugin-skills/src/index.js';

// ════════════════════════════════════════════════════════════
// skills 工具权限档定格。
//
// 删除类（skill_delete 递归删整个 skill 目录 / skill_remove_file 删 skill 内文件）
// 按「写删=restricted+confirm」约定抬档（用户拍板 2026-08-17）——data 根可删后
// 它们是真会落盘的破坏性操作，此前 sensitive(等级 1)无确认偏松。
// 关键陷阱：capabilityMinLevel 里 risk 遮蔽 visibility——restricted 工具若同时
// 带 risk，门槛从 2 反降到 1，因此删除类必须**不带** risk（有锚）。
// 其余读/写类维持原档，不被本批顺手改动。
// ════════════════════════════════════════════════════════════

interface Captured {
  name: string;
  risk?: string;
  visibility?: string;
  confirm?: string;
}

function runApply(): Captured[] {
  const captured: Captured[] = [];
  const fakeTools = {
    register: (tool: {
      definition: { function: { name: string } };
      risk?: string;
      visibility?: string;
      confirm?: string;
    }) => {
      captured.push({
        name: tool.definition.function.name,
        risk: tool.risk,
        visibility: tool.visibility,
        confirm: tool.confirm,
      });
      return () => {};
    },
    registerGroup: () => {},
  };
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child: () => logger,
  };
  const ctx = {
    id: '@aalis/plugin-skills',
    logger,
    getService: (name: string) => (name === 'tools' ? fakeTools : undefined),
    whenService: (name: string, cb: (svc: unknown) => void) => {
      if (name === 'tools') cb(fakeTools);
      return () => {};
    },
    onDispose: () => {},
    provide: () => {},
    on: () => () => {},
    contribute: () => () => {},
    middleware: () => () => {},
    runHook: async () => {},
  } as unknown as Context;
  apply(ctx, {});
  return captured;
}

describe('skills 工具权限档', () => {
  const tools = runApply();
  const byName = new Map(tools.map(t => [t.name, t]));

  it('删除类：restricted + session 确认，且不带 risk（防遮蔽降档）', () => {
    for (const name of ['skill_delete', 'skill_remove_file']) {
      const t = byName.get(name);
      expect(t, `${name} 未注册`).toBeDefined();
      expect(t?.visibility, name).toBe('restricted');
      expect(t?.confirm, name).toBe('session');
      expect(t?.risk, `${name} 不得带 risk（会把门槛从 2 降到 1）`).toBeUndefined();
    }
  });

  it('非删除类不被顺手改动（仍无 restricted+confirm 组合变化）', () => {
    for (const t of tools) {
      if (t.name === 'skill_delete' || t.name === 'skill_remove_file') continue;
      expect(t.confirm, `${t.name} 不应在本批被加 confirm`).toBeUndefined();
    }
  });
});
