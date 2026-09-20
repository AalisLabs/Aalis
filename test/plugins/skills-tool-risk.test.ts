import { beforeAll, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import skillsPlugin from '../../packages/plugin-skills/src/index.js';

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

/** 装载插件、用桩 tools 提供者收下它登记的全部工具 */
async function collectTools(): Promise<Captured[]> {
  const captured: Captured[] = [];
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  const host = app.bind({ provide, services });
  host.provide(tools, {
    register(tool: Captured & { definition: { function: { name: string } } }) {
      captured.push({
        name: tool.definition.function.name,
        risk: tool.risk,
        visibility: tool.visibility,
        confirm: tool.confirm,
      });
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(skillsPlugin, {});
  await app.plugins.idle();
  await app.stop();
  return captured;
}

describe('skills 工具权限档', () => {
  let registered: Captured[];
  let byName: Map<string, Captured>;

  beforeAll(async () => {
    registered = await collectTools();
    byName = new Map(registered.map(t => [t.name, t]));
  });

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
    for (const t of registered) {
      if (t.name === 'skill_delete' || t.name === 'skill_remove_file') continue;
      expect(t.confirm, `${t.name} 不应在本批被加 confirm`).toBeUndefined();
    }
  });
});
