/**
 * 鼠标控制工具（仅保留无 AX API 替代方案的操作）
 */

import type { Context } from '@aalis/core';
import type { PlatformAdapter, MouseButton } from '../platform.js';

export function registerMouseTools(ctx: Context, adapter: PlatformAdapter): void {

  // ── mouse_drag ──
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'mouse_drag',
        description: '按住鼠标从起点拖拽到终点。',
        parameters: {
          type: 'object',
          properties: {
            fromX: { type: 'number', description: '起点 X 坐标' },
            fromY: { type: 'number', description: '起点 Y 坐标' },
            toX: { type: 'number', description: '终点 X 坐标' },
            toY: { type: 'number', description: '终点 Y 坐标' },
            button: {
              type: 'string',
              enum: ['left', 'right', 'middle'],
              description: '鼠标按钮（默认 left）',
            },
          },
          required: ['fromX', 'fromY', 'toX', 'toY'],
        },
      },
    },
    handler: async (args) => {
      try {
        const button = (args.button as MouseButton) || 'left';
        await adapter.mouseDrag(
          args.fromX as number, args.fromY as number,
          args.toX as number, args.toY as number, button
        );
        return JSON.stringify({
          ok: true,
          from: { x: args.fromX, y: args.fromY },
          to: { x: args.toX, y: args.toY },
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── mouse_scroll ──
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'mouse_scroll',
        description:
          '在指定位置滚动鼠标滚轮。deltaY 正值向下滚动，负值向上滚动。deltaX 正值向右，负值向左。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '鼠标 X 坐标' },
            y: { type: 'number', description: '鼠标 Y 坐标' },
            deltaX: { type: 'number', description: '水平滚动量（默认 0）' },
            deltaY: { type: 'number', description: '垂直滚动量（正=下，负=上）' },
          },
          required: ['x', 'y', 'deltaY'],
        },
      },
    },
    handler: async (args) => {
      try {
        const deltaX = (args.deltaX as number) || 0;
        const deltaY = (args.deltaY as number) || 0;
        await adapter.mouseScroll(args.x as number, args.y as number, deltaX, deltaY);
        return JSON.stringify({ ok: true, deltaX, deltaY });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

}
