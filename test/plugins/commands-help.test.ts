import { describe, expect, it } from 'vitest';
import type { Command } from '../../packages/api-commands/src/index.js';
import { brief, renderDetail, renderOverview } from '../../packages/plugin-commands/src/help.js';

function mk(name: string, description: string, extra: Partial<Command> = {}): Command {
  return {
    name,
    description,
    pluginName: 'p',
    visibility: 'public',
    aliases: [],
    positionalArgs: [],
    options: [],
    isGroup: false,
    handler: async () => '',
    ...extra,
  } as Command;
}

const childCount =
  (all: Command[]) =>
  (top: string): number =>
    all.filter(c => c.name.startsWith(`${top}.`) && !c.name.slice(top.length + 1).includes('.')).length;

describe('help: brief 描述摘要', () => {
  it('切到首个句读之前', () => {
    expect(brief('舞萌 DX 查分。子指令：info/b50')).toBe('舞萌 DX 查分');
    expect(brief('自动确认模式：临时免确认')).toBe('自动确认模式');
    expect(brief('设定当前对话的模型（会话级覆盖）')).toBe('设定当前对话的模型');
  });

  it('无句读时硬截并加省略号，且不留尾部标点', () => {
    const out = brief('列出所有已注册的机器交互工具以及它们的分组与调用方式说明');
    expect(out.endsWith('…')).toBe(true);
    expect([...out].length).toBeLessThanOrEqual(25);
  });

  it('短描述原样返回', () => {
    expect(brief('运行系统诊断')).toBe('运行系统诊断');
  });
});

describe('help: 概览', () => {
  const all = [
    mk('clear', '清空当前会话记忆；用 --type 选择类型'),
    mk('clear.all', '清空全部'),
    mk('clear.list', '列出类型'),
    mk('help', '显示指令列表'),
    mk('relation', 'relation 命令组', { isGroup: true, handler: undefined }),
    mk('relation.show', '查看节点'),
    mk('status', '显示系统状态'),
  ];
  const out = renderOverview(all, '/', childCount(all));

  it('只列顶层，子指令不平铺', () => {
    expect(out).toContain('`/clear`');
    expect(out).toContain('`/status`');
    expect(out).not.toContain('/clear all');
    expect(out).not.toContain('clear.all');
  });

  it('排除 help 自身（正在看它的输出）', () => {
    expect(out).not.toContain('`/help`');
    expect(out).toContain('**Aalis 指令**（3 条）');
  });

  it('有子指令的顶层报计数', () => {
    expect(out).toContain('`/clear` — 清空当前会话记忆 · 2 个子指令');
  });

  it('自动分组节点不显示占位描述，只报子指令数', () => {
    expect(out).toContain('`/relation` — 1 个子指令');
    expect(out).not.toContain('命令组');
  });

  it('尾部给出二段查询提示', () => {
    expect(out).toContain('详情：`/help 指令名`');
  });
});

describe('help: 详情', () => {
  const cmd = mk('clear', '清空当前会话记忆；用 --type 选择消息、摘要等类型', {
    options: [
      {
        name: 'type',
        aliases: ['t'],
        type: 'string',
        valueName: 'type',
        description: '清理类型',
        choices: ['all', 'context'],
        takesValue: true,
        valueOptional: false,
        required: false,
      },
      {
        name: 'force',
        aliases: [],
        type: 'boolean',
        description: '跳过确认',
        takesValue: false,
        valueOptional: false,
        required: false,
      },
    ] as Command['options'],
    examples: ['/clear', '/clear --type context'],
    aliases: ['cls'],
  });
  const children = [mk('clear.list', '列出可清理类型'), mk('clear.all', '【危险】清空全部会话')];
  const out = renderDetail(cmd, children, '/');

  it('标题含完整描述（不截断——用户正为细节而来）', () => {
    expect(out).toContain('**/clear** — 清空当前会话记忆；用 --type 选择消息、摘要等类型');
  });

  it('结构化正文包在代码块里（WebUI 无 rehype-raw，占位符否则被吞）', () => {
    expect(out).toContain('```');
    expect(out).toContain('<type>'); // 占位符原样保留
  });

  it('列出用法、选项、子指令、别名、示例', () => {
    expect(out).toContain('用法: /clear [选项]');
    expect(out).toContain('--type, -t <type>');
    expect(out).toContain('（all | context）');
    expect(out).toContain('--force');
    expect(out).toContain('/clear list');
    expect(out).toContain('别名：/cls');
    expect(out).toContain('/clear --type context');
  });

  it('两列按显示宽度对齐（中英混排下列不歪）', () => {
    const lines = out.split('\n').filter(l => l.includes('/clear list') || l.includes('/clear all'));
    expect(lines).toHaveLength(2);
    const col = lines.map(l => l.indexOf(l.trim().split(/\s{2,}/)[1]));
    expect(col[0]).toBe(col[1]);
  });

  it('boolean 选项不带取值占位', () => {
    const line = out.split('\n').find(l => l.includes('--force'));
    expect(line).toBeDefined();
    expect(line).toMatch(/--force\s+跳过确认$/); // 无 <value>；间隔由对齐决定
  });

  it('无 handler 的分组：用法带 <子指令>，标题不带占位描述', () => {
    const group = mk('relation', 'relation 命令组', { isGroup: true, handler: undefined });
    const g = renderDetail(group, [mk('relation.show', '查看节点')], '/');
    expect(g).toContain('用法: /relation <子指令>');
    expect(g).toContain('**/relation**');
    expect(g).not.toContain('命令组');
  });
});
