import { describe, expect, it } from 'vitest';
import { toolSystemDisplays } from '../fixtures/tool-display.js';

// ════════════════════════════════════════════════════════════
// 系统工具声明的展示种类：命令类给出命令与工作目录在哪个参数里，改文件类给出路径与删、加两侧。
// 会话服务按它解析工具卡的展示与审批卡上的事实，前端不写工具名清单
// ════════════════════════════════════════════════════════════

describe('系统工具的展示种类', () => {
  it('exec 与 exec_background 是命令，file_edit、file_write、file_append 是改文件；其余不声明', () => {
    expect(Object.fromEntries(toolSystemDisplays())).toEqual({
      exec: { kind: 'command', fields: { command: 'command', cwd: 'cwd' } },
      exec_background: { kind: 'command', fields: { command: 'command', cwd: 'cwd' } },
      file_edit: { kind: 'file-change', fields: { path: 'path', removed: 'oldText', added: 'newText' } },
      file_write: { kind: 'file-change', fields: { path: 'path', added: 'content' } },
      file_append: { kind: 'file-change', fields: { path: 'path', added: 'content' } },
    });
  });
});
