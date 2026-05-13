/**
 * 窗口/桌面管理工具
 *
 * 合并了旧的 window_list + ui_processes → list_apps
 * 保留 window_resize（无 AX 替代）
 * window_focus 已合并到 interact.ts 的 focus_app
 */

import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { detectRunningAppType } from '../app-detect.js';
import * as axNative from '../ax-native.js';
import type { PlatformAdapter } from '../platform.js';
import { detectPlatform } from '../platform.js';

export function registerWindowTools(tools: ScopedToolService, adapter: PlatformAdapter): void {
  const axAvailable = axNative.isAvailable();

  // ── list_apps ── (合并 window_list + ui_processes)
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'list_apps',
        description:
          '列出桌面上所有打开的应用和窗口。\n' +
          '返回每个应用的名称、PID、窗口标题、位置大小和应用类型（native/electron/chromium）。\n' +
          '应用类型决定操控方式：\n' +
          '- native → ui_tree + click/type_text（AX API）\n' +
          '- electron/chromium → web_connect + web_inspect（CDP 协议）\n\n' +
          '可直接用于 ui_tree / click / focus_app / web_connect 等工具。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    handler: async () => {
      try {
        // 获取窗口列表
        const windows = await adapter.listWindows();

        // 如果 AX 可用，补充 PID 和 bundleId
        let processes: Array<{ pid: number; name: string; bundleId?: string }> = [];
        if (axAvailable) {
          processes = axNative.listUiProcesses().map(p => ({
            pid: p.pid,
            name: p.name,
            bundleId: p.bundleId,
          }));
        }

        // 合并：以进程为维度，关联其窗口
        const processMap = new Map<
          string,
          {
            name: string;
            pid?: number;
            bundleId?: string;
            appType?: string;
            windows: typeof windows;
          }
        >();

        // 先用 AX 进程建索引
        for (const proc of processes) {
          processMap.set(proc.name, {
            name: proc.name,
            pid: proc.pid,
            bundleId: proc.bundleId,
            windows: [],
          });
        }

        // 关联窗口
        for (const win of windows) {
          const appName = win.app || win.title;
          let entry = processMap.get(appName);
          if (!entry) {
            entry = { name: appName, windows: [] };
            processMap.set(appName, entry);
          }
          entry.windows.push(win);
        }

        // macOS: 异步检测应用类型
        if (detectPlatform() === 'macos') {
          const entries = Array.from(processMap.values()).filter(e => e.pid);
          const detectPromises = entries.map(async entry => {
            try {
              entry.appType = await detectRunningAppType(entry.pid!);
            } catch {
              entry.appType = 'native';
            }
          });
          await Promise.all(detectPromises);
        }

        const apps = Array.from(processMap.values());

        return JSON.stringify({ count: apps.length, apps });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── window_resize ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'window_resize',
        description: '调整指定窗口的位置和大小。',
        parameters: {
          type: 'object',
          properties: {
            windowId: { type: 'string', description: '窗口 ID' },
            x: { type: 'number', description: '窗口左上角 X 坐标' },
            y: { type: 'number', description: '窗口左上角 Y 坐标' },
            width: { type: 'number', description: '窗口宽度' },
            height: { type: 'number', description: '窗口高度' },
          },
          required: ['windowId', 'x', 'y', 'width', 'height'],
        },
      },
    },
    handler: async args => {
      try {
        await adapter.resizeWindow(args.windowId as string, {
          x: args.x as number,
          y: args.y as number,
          width: args.width as number,
          height: args.height as number,
        });
        return JSON.stringify({ ok: true, windowId: args.windowId });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}
