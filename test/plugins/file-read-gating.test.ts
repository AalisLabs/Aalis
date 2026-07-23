import { describe, expect, it } from 'vitest';
import { registerFileTools } from '../../packages/plugin-tool-system/src/tools/file.js';
import type { RegisteredTool, ScopedToolService } from '../../packages/plugin-tools-api/src/index.js';

// ════════════════════════════════════════════════════════════
// file 读类能力闸回归：
//   读文件/内容 = 信息暴露向量（可读跨会话日志 data:/latest.log、记忆库等）。
//   默认 public 会让 level-0 群成员经聊天读到私密数据 → 收敛为 sensitive(级 1)：
//   挡住 level-0，但保留「朋友档只读、不写/不 exec」的粒度，且读不弹确认。
//   写删类保持 restricted + confirm（信任档 + 意图确认），不被本批下调。
// ════════════════════════════════════════════════════════════

function captureFileTools(): Record<string, Omit<RegisteredTool, 'pluginName'>> {
  const tools: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  const svc = {
    register: (t: Omit<RegisteredTool, 'pluginName'>) => {
      tools[t.definition.function.name] = t;
      return () => undefined;
    },
    registerGroup: () => () => undefined,
  } as unknown as ScopedToolService;
  // 注册期不触碰 storage/cwd（仅构造工具声明），最小 config 即可 capture。
  registerFileTools(svc, {
    maxReadSize: 1048576,
    maxSearchBytes: 1048576,
    maxWriteSize: 10485760,
    allowedRoots: ['*'],
    storage: {} as never,
    cwdState: {} as never,
  } as never);
  return tools;
}

describe('file 读类能力闸（sensitive 级 1）', () => {
  it('读/枚举类挂 sensitive：file_read/list/search/tree/info', () => {
    const tools = captureFileTools();
    for (const name of ['file_read', 'file_list', 'file_search', 'file_tree', 'file_info']) {
      expect(tools[name], `${name} 未注册`).toBeDefined();
      expect(tools[name].risk, `${name} 应为 sensitive(挡 level-0)`).toBe('sensitive');
      // 读不弹确认（sensitive 展开无 confirm）
      expect(tools[name].confirm).toBeUndefined();
    }
  });

  it('写删类保持 restricted + confirm，不被下调', () => {
    const tools = captureFileTools();
    for (const name of ['file_write', 'file_edit', 'file_append', 'file_delete']) {
      expect(tools[name], `${name} 未注册`).toBeDefined();
      expect(tools[name].visibility, `${name} 应保持 restricted`).toBe('restricted');
      expect(tools[name].confirm, `${name} 应保持 session 确认`).toBe('session');
    }
  });
});
