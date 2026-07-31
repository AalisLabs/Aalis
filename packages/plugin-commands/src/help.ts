// ============================================================
// help.ts — 指令帮助的渲染（纯函数，无副作用，便于单测）
//
// 两段式：概览只回答"有哪些能力"，详情回答"这条怎么用"。
//
// 载体约束（已核实 packages/plugin-webui-client/src/components/markdownConfig.tsx）：
// WebUI 的 ReactMarkdown 只挂 remarkGfm + remarkMath + rehypeHighlight/Katex——
// 既**无 remark-breaks**（裸换行会被合并成一段），也**无 rehype-raw**（`<type>`
// 这类占位符是合法 HTML 标签名，会被当 HTML 节点整段丢弃）。故：
// - 概览用 markdown 列表（`- ` 前缀），换行由列表语义保证；
// - 详情的结构化正文整体包进代码块，占位符原样呈现且等宽对齐。
// 纯文本载体（QQ / CLI）看到的是 markdown 源码，可读性不受损。
// ============================================================

import type { Command } from '@aalis/api-commands';

/** 描述里的句读——概览截断到首个句读之前 */
const CLAUSE_BREAK = /[。；;，,、（(：:\n]/;
/** 概览描述的硬上限（code point 计），防止无句读的长描述撑爆一行 */
const BRIEF_MAX = 24;

/**
 * 概览用的描述摘要：先切到首个句读之前，再硬截。
 *
 * 不引入 summary/shortDesc 新字段——那要 60+ 个包配合填写。实测全仓真实描述
 * （"舞萌 DX 查分。子指令：…" / "自动确认模式：临时免…"）首句读切分即可切净。
 */
export function brief(desc: string): string {
  const raw = desc.trim();
  if (!raw) return '';
  const idx = raw.search(CLAUSE_BREAK);
  let out = idx > 0 ? raw.slice(0, idx) : raw;
  const chars = [...out];
  if (chars.length > BRIEF_MAX) out = `${chars.slice(0, BRIEF_MAX).join('')}…`;
  return out.replace(/[\s/·、\-—]+$/, '');
}

/** 自动分组节点（无人显式注册，描述是 ensureGroups 塞的"xxx 命令组"占位）不值得展示描述 */
function isPlaceholderGroup(cmd: Command): boolean {
  return cmd.isGroup && !cmd.handler;
}

/**
 * 显示宽度：CJK / 全角标点按 2 格算。详情正文在代码块里是等宽字体，
 * 按 code point 数补空格会让中英混排的列歪掉。
 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/** 两列布局：左列按最宽项补齐（代码块内等宽字体下才对得上） */
function twoColumn(rows: Array<[string, string]>, indent = '  '): string[] {
  const width = Math.max(...rows.map(([l]) => displayWidth(l)));
  return rows.map(([l, r]) => `${indent}${l}${' '.repeat(width - displayWidth(l) + 2)}${r}`.trimEnd());
}

/**
 * 概览：只列顶层节点（深度 0），子指令折成计数。
 *
 * 深度 ≥1 的节点（`session.set` / `clear.all` 等）一律不进概览——它们占了原先
 * 六成篇幅而信息价值近零（看到 `/session` 就该知道进去看）。
 */
export function renderOverview(all: Command[], prefix: string, childCount: (name: string) => number): string {
  const tops = all.filter(c => !c.name.includes('.') && c.name !== 'help');
  const lines = [`**Aalis 指令**（${tops.length} 条）`, ''];
  for (const cmd of tops) {
    const head = `\`${prefix}${cmd.name}\``;
    const n = childCount(cmd.name);
    if (isPlaceholderGroup(cmd)) {
      // 占位描述是噪音，改报子指令数——它才是这个节点的全部信息
      lines.push(`- ${head} — ${n} 个子指令`);
      continue;
    }
    const sub = n > 0 ? ` · ${n} 个子指令` : '';
    lines.push(`- ${head} — ${brief(cmd.description)}${sub}`);
  }
  lines.push('', `详情：\`${prefix}help 指令名\``);
  return lines.join('\n');
}

/**
 * 详情：标题行（markdown）+ 结构化正文（代码块）。
 *
 * 正文进代码块的理由见文件头：保住 `<type>` 这类占位符不被 WebUI 吞掉，
 * 同时让选项/子指令在等宽字体下对齐。描述、选项说明、示例**不截断**——
 * 用户正是为细节才敲的第二段（如 plugin-maimai 把用法编码在描述里）。
 */
export function renderDetail(cmd: Command, children: Command[], prefix: string): string {
  const head = `${prefix}${cmd.name.replace(/\./g, ' ')}`;
  const body: string[] = [];

  const argText = cmd.positionalArgs
    .map(a => (a.required ? `<${a.name}:${a.type}>` : `[${a.name}:${a.type}]`))
    .join(' ');
  const subText = children.length > 0 && !cmd.handler ? ' <子指令>' : '';
  const optText = cmd.options.length > 0 ? ' [选项]' : '';
  body.push(`用法: ${head}${subText}${argText ? ` ${argText}` : ''}${optText}`);

  if (cmd.positionalArgs.length > 0) {
    body.push('', '参数：');
    for (const a of cmd.positionalArgs) {
      const label = a.required ? `<${a.name}:${a.type}>` : `[${a.name}:${a.type}]`;
      body.push(`  ${label}`);
    }
  }

  if (cmd.options.length > 0) {
    body.push('', '选项：');
    body.push(
      ...twoColumn(
        cmd.options.map(o => {
          const flags = [`--${o.name}`, ...o.aliases.map(a => `-${a}`)].join(', ');
          const val =
            o.type === 'boolean' ? '' : o.valueOptional ? ` [${o.valueName ?? o.name}]` : ` <${o.valueName ?? o.name}>`;
          const choices = o.choices && o.choices.length > 0 ? `（${o.choices.join(' | ')}）` : '';
          return [`${flags}${val}`, `${o.description ?? o.type}${choices}`];
        }),
      ),
    );
  }

  if (children.length > 0) {
    body.push('', '子指令：');
    body.push(...twoColumn(children.map(c => [`${prefix}${c.name.replace(/\./g, ' ')}`, brief(c.description)])));
  }

  if (cmd.aliases.length > 0) {
    body.push('', `别名：${cmd.aliases.map(a => `${prefix}${a.replace(/\./g, ' ')}`).join(', ')}`);
  }

  if (cmd.examples && cmd.examples.length > 0) {
    body.push('', '示例：');
    for (const e of cmd.examples) body.push(`  ${e}`);
  }

  const title = isPlaceholderGroup(cmd) ? `**${head}**` : `**${head}** — ${cmd.description}`;
  return `${title}\n\n\`\`\`\n${body.join('\n')}\n\`\`\``;
}
