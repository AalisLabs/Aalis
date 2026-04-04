/**
 * 智能交互工具
 *
 * 合并了重复的键鼠/UI 自动化操作，自动选择最佳路径：
 * - 如果提供了 element_path → 走 AX API（精准、可靠）
 * - 如果提供了 x/y 坐标 → 走鼠标/键盘（兜底）
 *
 * 合并了以下旧工具：
 * - mouse_click + ui_action(AXPress) → click
 * - keyboard_type + ui_set_value → type_text
 * - window_focus + ui_action(AXRaise) → focus_app
 */

import type { Context } from '@aalis/core';
import type { PlatformAdapter, MouseButton } from '../platform.js';
import * as axNative from '../ax-native.js';

export function registerInteractTools(ctx: Context, adapter: PlatformAdapter): void {
  const axAvailable = axNative.isAvailable();

  // ── click ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'click',
        description:
          '点击一个 UI 元素或屏幕坐标。\n' +
          '两种使用方式（优先用第一种）：\n' +
          '1. 组件方式（推荐）：提供 pid + element_path，直接对 UI 组件执行 AXPress 操作，精准可靠\n' +
          '2. 坐标方式（兜底）：提供 x + y，通过鼠标点击屏幕坐标\n' +
          '   ⚠️ 坐标方式必须先用 screen_capture 截图并通过图片识别确定准确坐标，禁止凭猜测点击！\n' +
          '支持左键/右键/中键，单击/双击。也可指定其他 AX action（如 AXShowMenu, AXConfirm）。',
        parameters: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: '目标进程 PID（组件方式必填）' },
            element_path: {
              type: 'string',
              description: '元素路径，如 "AXWindow[0]/AXGroup[1]/AXButton[0]"（组件方式必填）',
            },
            action: {
              type: 'string',
              description: '要执行的 AX 操作（默认 "AXPress"）。其他常用值：AXShowMenu, AXConfirm, AXCancel, AXPick',
            },
            x: { type: 'number', description: '屏幕 X 坐标（坐标方式必填）' },
            y: { type: 'number', description: '屏幕 Y 坐标（坐标方式必填）' },
            button: {
              type: 'string',
              enum: ['left', 'right', 'middle'],
              description: '鼠标按钮（坐标方式，默认 left）',
            },
            clickCount: {
              type: 'number',
              description: '点击次数（坐标方式，1=单击, 2=双击，默认 1）',
            },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      try {
        const pid = args.pid as number | undefined;
        const elementPath = args.element_path as string | undefined;
        const x = args.x as number | undefined;
        const y = args.y as number | undefined;

        // 路径 1: AX API
        if (pid !== undefined && elementPath) {
          if (!axAvailable) {
            return JSON.stringify({ error: 'UI 自动化不可用（原生模块未加载或非 macOS）' });
          }
          const action = (args.action as string) || 'AXPress';
          const success = axNative.performAction(pid, elementPath, action);
          return JSON.stringify({ ok: success, method: 'ax', pid, elementPath, action });
        }

        // 路径 2: 鼠标点击
        if (x !== undefined && y !== undefined) {
          const button = (args.button as MouseButton) || 'left';
          const clickCount = (args.clickCount as number) || 1;
          await adapter.mouseClick(x, y, button, clickCount);
          return JSON.stringify({ ok: true, method: 'mouse', x, y, button, clickCount });
        }

        return JSON.stringify({ error: '请提供 pid+element_path（组件方式）或 x+y（坐标方式）' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── type_text ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'type_text',
        description:
          '向指定的文本框输入文字。\n' +
          '两种使用方式（优先用第一种）：\n' +
          '1. 组件方式（推荐）：提供 pid + element_path，直接设置 UI 元素的值，无需焦点，不依赖键盘布局\n' +
          '2. 键盘方式（兜底）：仅提供 text，模拟键盘逐字输入到当前焦点位置',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文本内容' },
            pid: { type: 'number', description: '目标进程 PID（组件方式）' },
            element_path: {
              type: 'string',
              description: '目标文本框的元素路径，如 "AXWindow[0]/AXTextField[0]"（组件方式）',
            },
          },
          required: ['text'],
        },
      },
    },
    handler: async (args) => {
      try {
        const text = args.text as string;
        const pid = args.pid as number | undefined;
        const elementPath = args.element_path as string | undefined;

        // 路径 1: AX API 直接设值
        if (pid !== undefined && elementPath && axAvailable) {
          const success = axNative.setElementValue(pid, elementPath, text);
          return JSON.stringify({ ok: success, method: 'ax', pid, elementPath, length: text.length });
        }

        // 路径 2: 键盘模拟输入
        await adapter.keyboardType(text);
        return JSON.stringify({ ok: true, method: 'keyboard', length: text.length });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── focus_app ──
  ctx.registerTool({
    safety: 'dangerous',
    authority: 3,
    definition: {
      type: 'function',
      function: {
        name: 'focus_app',
        description:
          '将指定应用/窗口切换到前台。\n' +
          '两种使用方式：\n' +
          '1. 按应用名（推荐）：提供 appName 或 windowId，自动激活\n' +
          '2. 按元素路径：提供 pid + element_path，对窗口执行 AXRaise',
        parameters: {
          type: 'object',
          properties: {
            windowId: {
              type: 'string',
              description: '窗口 ID（macOS: "应用名::窗口标题"）。可通过 list_apps 获取。',
            },
            pid: { type: 'number', description: '目标进程 PID（AX 方式）' },
            element_path: {
              type: 'string',
              description: '窗口元素路径，如 "AXWindow[0]"（AX 方式）',
            },
          },
          required: [],
        },
      },
    },
    handler: async (args) => {
      try {
        const windowId = args.windowId as string | undefined;
        const pid = args.pid as number | undefined;
        const elementPath = args.element_path as string | undefined;

        // 路径 1: AX API
        if (pid !== undefined && elementPath && axAvailable) {
          const success = axNative.performAction(pid, elementPath, 'AXRaise');
          return JSON.stringify({ ok: success, method: 'ax', pid, elementPath });
        }

        // 路径 2: 平台窗口管理
        if (windowId) {
          await adapter.focusWindow(windowId);
          return JSON.stringify({ ok: true, method: 'window', windowId });
        }

        return JSON.stringify({ error: '请提供 windowId 或 pid+element_path' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}
