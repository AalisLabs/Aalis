import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// 分组过滤语义（getDefinitions / getSummaries 共用一套）：
//   无分组的通用工具恒可见；带分组的只在命中 groups 时可见；'*' = 全部分组。
//   未指定（或为空）只给通用工具——多人平台上 public 工具的可达性靠这道闸
//   （docs/concepts/security-model.md），owner 专用平台由平台档显式给 ['*']。

async function withRegistry(
  fn: (names: (f?: { groups?: string[] }) => string[], summaries: (f?: { groups?: string[] }) => string[]) => void,
): Promise<void> {
  const app = new App({ name: 'T', logLevel: 'error' });
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.idle();
  const { tools } = app.bind({ tools: toolsService });
  const def = (name: string) => ({
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  });
  tools.register({ definition: def('plain'), handler: async () => '' });
  tools.register({ definition: def('sys_a'), handler: async () => '', groups: ['system'] });
  tools.register({ definition: def('skill_a'), handler: async () => '', groups: ['skills'] });
  const reg = tools.current;
  if (!reg) throw new Error('tools 服务未注册');
  try {
    fn(
      f =>
        reg
          .getDefinitions(f)
          .map(d => d.function.name)
          .sort(),
      f =>
        reg
          .getSummaries(f)
          .map(s => s.name)
          .sort(),
    );
  } finally {
    await app.stop().catch(() => {});
  }
}

describe('ToolRegistry 分组过滤', () => {
  it('未指定 / 空 groups → 只给无分组的通用工具（分组闸默认关）', async () => {
    await withRegistry((names, summaries) => {
      expect(names()).toEqual(['plain']);
      expect(names({})).toEqual(['plain']);
      expect(names({ groups: [] })).toEqual(['plain']);
      expect(summaries()).toEqual(['plain']);
    });
  });

  it('指定 groups → 通用工具 + 命中分组', async () => {
    await withRegistry((names, summaries) => {
      expect(names({ groups: ['system'] })).toEqual(['plain', 'sys_a']);
      expect(names({ groups: ['system', 'skills'] })).toEqual(['plain', 'skill_a', 'sys_a']);
      expect(names({ groups: ['nope'] })).toEqual(['plain']);
      expect(summaries({ groups: ['skills'] })).toEqual(['plain', 'skill_a']);
    });
  });

  it("'*' → 全部分组（可与具体组名混写）", async () => {
    await withRegistry((names, summaries) => {
      expect(names({ groups: ['*'] })).toEqual(['plain', 'skill_a', 'sys_a']);
      expect(names({ groups: ['system', '*'] })).toEqual(['plain', 'skill_a', 'sys_a']);
      expect(summaries({ groups: ['*'] })).toEqual(['plain', 'skill_a', 'sys_a']);
    });
  });
});
