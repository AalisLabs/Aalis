/**
 * UI 自动化工具
 *
 * 基于 macOS Accessibility API 的 UI 元素树读取和查找。
 * 相比纯截图+鼠标/键盘方式，提供更精准可靠的 UI 交互：
 * - 直接读取 UI 元素树（按钮、文本框、菜单等）
 * - 按角色/名称查找元素
 * - 按坐标定位元素
 *
 * 注：组件操作 (AXPress/设值等) 已合并到 interact.ts 的 click / type_text。
 *     进程列表已合并到 window.ts 的 list_apps。
 */

import type { Context } from '@aalis/core';
import type { AXElementInfo } from '../ax-native.js';
import * as axNative from '../ax-native.js';

/** 将 UI 树精简为 AI 友好的摘要格式 */
function summarizeElement(el: AXElementInfo, indent: number = 0): string {
  const pad = '  '.repeat(indent);
  const parts: string[] = [];

  let line = `${pad}[${el.role}]`;
  if (el.title) line += ` "${el.title}"`;
  if (el.description && el.description !== el.title) line += ` (${el.description})`;
  if (el.value) {
    const val = el.value.length > 50 ? `${el.value.slice(0, 50)}...` : el.value;
    line += ` = "${val}"`;
  }
  if (el.x != null && el.y != null) {
    line += ` @(${Math.round(el.x)},${Math.round(el.y)}`;
    if (el.width != null && el.height != null) {
      line += ` ${Math.round(el.width)}x${Math.round(el.height)}`;
    }
    line += ')';
  }
  if (el.actions.length > 0) {
    line += ` actions:[${el.actions.join(',')}]`;
  }
  if (el.enabled === false) line += ' [DISABLED]';
  if (el.focused) line += ' [FOCUSED]';
  line += ` path="${el.path}"`;

  parts.push(line);

  for (const child of el.children) {
    parts.push(summarizeElement(child, indent + 1));
  }

  return parts.join('\n');
}

/** 统计 UI 树中各类元素的数量，评估信息质量 */
function assessTreeQuality(elements: AXElementInfo[]): {
  total: number;
  labeled: number; // 有 title/description/value 的
  actionable: number; // 有可执行 action 的
  opaque: number; // 无标签的 AXGroup/AXUnknown
  quality: 'good' | 'partial' | 'poor';
} {
  let total = 0,
    labeled = 0,
    actionable = 0,
    opaque = 0;

  function walk(el: AXElementInfo) {
    total++;
    if (el.title || el.description || el.value) labeled++;
    if (el.actions.length > 0) actionable++;
    if (!el.title && !el.description && !el.value && (el.role === 'AXGroup' || el.role === 'AXUnknown')) opaque++;
    for (const child of el.children) walk(child);
  }
  for (const el of elements) walk(el);

  // 质量判定：至少 30% 元素有标签且有可操作元素 → good
  // 有一些可操作元素但标签率低 → partial
  // 几乎没有有意义信息 → poor
  const labelRatio = total > 0 ? labeled / total : 0;
  const quality: 'good' | 'partial' | 'poor' =
    actionable >= 3 && labelRatio >= 0.3 ? 'good' : actionable >= 1 || labelRatio >= 0.15 ? 'partial' : 'poor';

  return { total, labeled, actionable, opaque, quality };
}

/** 根据树质量生成 AI 引导提示 */
function buildHint(quality: ReturnType<typeof assessTreeQuality>): string {
  if (quality.quality === 'good') {
    return '使用 click(pid, element_path) 点击元素，或 type_text(pid, element_path, text) 输入文本。';
  }
  if (quality.quality === 'partial') {
    return (
      '⚠️ UI 树信息不够完整（部分元素缺少标签）。建议：\n' +
      '1. 尝试增大 max_depth 获取更深层元素\n' +
      '2. 用 ui_find 按角色搜索特定元素（如 AXButton, AXTextField）\n' +
      '3. 如果仍不足，使用 screen_capture 截图后配合图片识别工具分析界面\n' +
      '4. 如果是 Electron/Web 应用，使用 web_connect + web_inspect（CDP 协议）获取完整 DOM'
    );
  }
  // poor
  return (
    '⚠️ 该应用的 UI 元素树几乎没有有用信息（可能是自绘界面或 Electron 应用）。\n' +
    '请勿猜测坐标！改用以下方式：\n' +
    '1. 【推荐】如果是 Electron/CEF 应用 → web_connect 连接 CDP 调试端口，然后用 web_inspect 读取 DOM\n' +
    '2. 使用 screen_capture 截屏，然后用图片识别工具分析 UI 布局，获取准确坐标后再操作\n' +
    '3. 切勿凭空猜测坐标进行点击'
  );
}

export function registerUIAutomationTools(ctx: Context): void {
  // ── ui_tree ──
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ui_tree',
        description:
          '读取指定应用程序的 UI 元素树（按钮、文本框、菜单等）。\n' +
          '返回结构化的 UI 层级信息，包括每个元素的角色、名称、位置、可执行的操作。\n' +
          '使用此工具可以精确了解应用界面布局，而无需依赖截图。\n' +
          '每个元素有一个 path（如 "AXWindow[0]/AXGroup[1]/AXButton[0]"），可用于 click 和 type_text。',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: '目标进程 PID（可通过 list_apps 获取）' },
            max_depth: { type: 'number', description: '最大递归深度（默认 3，建议 2-5）' },
            include_invisible: { type: 'boolean', description: '是否包含隐藏元素（默认 false）' },
          },
          required: ['pid'],
        },
      },
    },
    handler: async args => {
      try {
        const pid = args.pid as number;
        const maxDepth = (args.max_depth as number) || 3;
        const includeInvisible = (args.include_invisible as boolean) || false;

        const tree = axNative.getUiTree(pid, maxDepth, includeInvisible);

        // 生成 AI 友好的摘要
        const summary = tree.map(el => summarizeElement(el)).join('\n\n');

        // 评估 UI 树质量，生成针对性引导
        const quality = assessTreeQuality(tree);
        const hint = buildHint(quality);

        return JSON.stringify({
          pid,
          windowCount: tree.length,
          treeQuality: quality.quality,
          stats: {
            total: quality.total,
            labeled: quality.labeled,
            actionable: quality.actionable,
            opaque: quality.opaque,
          },
          summary,
          hint,
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── ui_find ──
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ui_find',
        description:
          '在指定应用中查找匹配条件的 UI 元素。\n' +
          '可按角色（如 AXButton, AXTextField）和/或标题/名称进行过滤。\n' +
          '返回匹配元素的列表及其路径，可直接用于 ui_action。',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: '目标进程 PID' },
            role: {
              type: 'string',
              description: '按角色过滤（如 "AXButton", "AXTextField", "AXStaticText", "AXMenuItem"）',
            },
            title: {
              type: 'string',
              description: '按标题/名称模糊匹配（不区分大小写）',
            },
            max_depth: { type: 'number', description: '搜索深度（默认 10）' },
          },
          required: ['pid'],
        },
      },
    },
    handler: async args => {
      try {
        const pid = args.pid as number;
        const role = args.role as string | undefined;
        const title = args.title as string | undefined;
        const maxDepth = (args.max_depth as number) || 10;

        const elements = axNative.findElements(pid, role, title, maxDepth);

        const results = elements.map(el => ({
          path: el.path,
          role: el.role,
          title: el.title,
          value: el.value,
          description: el.description,
          position: el.x != null ? { x: el.x, y: el.y, width: el.width, height: el.height } : null,
          actions: el.actions,
          enabled: el.enabled,
          focused: el.focused,
        }));

        // 根据查找结果给出引导
        let hint: string;
        if (results.length === 0) {
          hint =
            '未找到匹配元素。建议：\n' +
            '1. 检查应用是否处于预期界面状态\n' +
            '2. 尝试不同的 role 或 title 关键词\n' +
            '3. 使用 ui_tree 查看完整元素树了解可用元素\n' +
            '4. 如果是 Electron/Web 应用，使用 web_connect + web_inspect 通过 CDP 读取 DOM\n' +
            '5. 使用 screen_capture 截图后用图片识别分析界面';
        } else {
          hint = '使用 click(pid, element_path) 点击元素，或 type_text(pid, element_path, text) 输入文本。';
        }

        return JSON.stringify({
          pid,
          matchCount: results.length,
          elements: results,
          hint,
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── ui_element_at ──
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'ui_element_at',
        description:
          '获取屏幕上指定坐标处的 UI 元素信息。\n' +
          '用于确认某个位置上是什么元素，辅助精确操作。\n' +
          'pid 传 0 表示系统级查询（不限应用）。',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: '目标进程 PID（0=系统级）' },
            x: { type: 'number', description: '屏幕 X 坐标' },
            y: { type: 'number', description: '屏幕 Y 坐标' },
          },
          required: ['pid', 'x', 'y'],
        },
      },
    },
    handler: async args => {
      try {
        const pid = args.pid as number;
        const x = args.x as number;
        const y = args.y as number;

        const element = axNative.getElementAtPosition(pid, x, y);
        if (!element) {
          return JSON.stringify({ found: false, x, y });
        }
        return JSON.stringify({
          found: true,
          x,
          y,
          element: {
            path: element.path,
            role: element.role,
            title: element.title,
            value: element.value,
            description: element.description,
            position:
              element.x != null ? { x: element.x, y: element.y, width: element.width, height: element.height } : null,
            actions: element.actions,
          },
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}
