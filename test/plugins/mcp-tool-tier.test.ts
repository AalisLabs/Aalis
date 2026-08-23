import { describe, expect, it } from 'vitest';
import { deriveMcpToolPolicy } from '../../packages/plugin-mcp-client/src/index.js';

// ════════════════════════════════════════════════════════════
// MCP 桥接工具默认档位（用户裁定 2026-08-23：按"是否可能破坏"分档）。
//
// 不变量：
//   1. 未知即受限——无注解/有破坏提示 → restricted（等级 2），失败关闭；
//   2. 自称只读（且无破坏提示）→ sensitive（等级 1），最低也挡 level-0；
//   3. 两轴互斥——capabilityMinLevel 里 risk 遮蔽 visibility
//      （restricted+risk 门槛反降为 1），故任何返回都不得同时带两轴；
//   4. server 显式配置优先于注解。
// ════════════════════════════════════════════════════════════

describe('MCP 工具档位推导', () => {
  it('无注解 → restricted（未知按可破坏算）', () => {
    expect(deriveMcpToolPolicy(undefined)).toEqual({ visibility: 'restricted' });
    expect(deriveMcpToolPolicy({})).toEqual({ visibility: 'restricted' });
  });

  it('自称只读 → sensitive（等级 1）', () => {
    expect(deriveMcpToolPolicy({ readOnlyHint: true })).toEqual({ risk: 'sensitive' });
  });

  it('只读+破坏提示并存 → 破坏优先，restricted', () => {
    expect(deriveMcpToolPolicy({ readOnlyHint: true, destructiveHint: true })).toEqual({ visibility: 'restricted' });
  });

  it('明示破坏 → restricted', () => {
    expect(deriveMcpToolPolicy({ destructiveHint: true })).toEqual({ visibility: 'restricted' });
  });

  it('server 显式覆盖优先于注解', () => {
    expect(deriveMcpToolPolicy({ destructiveHint: true }, 'public')).toEqual({});
    expect(deriveMcpToolPolicy({ readOnlyHint: true }, 'restricted')).toEqual({ visibility: 'restricted' });
    expect(deriveMcpToolPolicy(undefined, 'sensitive')).toEqual({ risk: 'sensitive' });
    expect(deriveMcpToolPolicy({ readOnlyHint: true }, 'auto')).toEqual({ risk: 'sensitive' });
  });

  it('任何返回都不同时带两轴（防 risk 遮蔽 visibility 降档）', () => {
    const cases = [
      deriveMcpToolPolicy(undefined),
      deriveMcpToolPolicy({ readOnlyHint: true }),
      deriveMcpToolPolicy({ destructiveHint: true }),
      deriveMcpToolPolicy(undefined, 'sensitive'),
      deriveMcpToolPolicy(undefined, 'restricted'),
    ];
    for (const p of cases) {
      expect(p.risk && p.visibility, JSON.stringify(p)).toBeFalsy();
    }
  });
});
