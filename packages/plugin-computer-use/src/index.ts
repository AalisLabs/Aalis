import { resolve } from 'node:path';
import type { Context, ConfigSchema } from '@aalis/core';
import { createAdapter, detectPlatform, type PlatformAdapter } from './platform.js';
import { registerScreenshotTools } from './tools/screenshot.js';
import { registerMouseTools } from './tools/mouse.js';
import { registerKeyboardTools } from './tools/keyboard.js';
import { registerWindowTools } from './tools/window.js';
import { registerClipboardTools } from './tools/clipboard.js';
import { registerAppTools } from './tools/app.js';
import { registerUIAutomationTools } from './tools/ui-automation.js';
import { registerInteractTools } from './tools/interact.js';
import { registerWebAutomationTools } from './tools/web-automation.js';
import { CdpManager } from './cdp/client.js';
import * as axNative from './ax-native.js';
import '@aalis/plugin-tools-api';

// ════════════════════════════════════════════════════════════
// plugin-computer-use — 桌面操控工具
//
// 让 AI 像真人一样操控计算机：截屏观察、组件级 UI 交互、
// 键盘快捷键、窗口管理、剪贴板、启动关闭应用。
// macOS 优先通过 Accessibility API 进行精准 UI 操控。
// ════════════════════════════════════════════════════════════

// ──────────── 配置类型 ────────────

interface ComputerUseConfig {
  /** 屏幕截图 (screen_capture) */
  screenshot: boolean;
  /** 智能交互 (click, type_text, focus_app) — 合并了鼠标点击/键盘输入/窗口切换与 AX API */
  interact: boolean;
  /** 鼠标拖拽和滚动 (mouse_drag, mouse_scroll) — 无 AX 替代的底层操作 */
  mouse: boolean;
  /** 键盘快捷键 (keyboard_press) — 组合键/功能键 */
  keyboard: boolean;
  /** 桌面管理 (list_apps, window_resize) */
  window: boolean;
  /** 剪贴板 (clipboard_read, clipboard_write) */
  clipboard: boolean;
  /** 应用管理 (app_launch, app_close) */
  app: boolean;
  /** UI 元素树读取 (ui_tree, ui_find, ui_element_at) — 仅 macOS */
  uiAutomation: boolean;
  /** Web 自动化 (web_connect, web_inspect, web_action, web_eval) — CDP 协议 */
  webAutomation: boolean;
  maxImageWidth: number;
  screenshotDir: string;
}

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-computer-use';
export const displayName = '桌面操控';

export const configSchema: ConfigSchema = {
  screenshot: {
    type: 'boolean',
    label: '屏幕截图',
    default: true,
    description: '启用屏幕截图工具 (screen_capture)',
  },
  interact: {
    type: 'boolean',
    label: '智能交互',
    default: true,
    description: '启用智能交互工具 (click, type_text, focus_app)。自动选择 AX API 或鼠标/键盘路径。',
  },
  mouse: {
    type: 'boolean',
    label: '鼠标拖拽/滚动',
    default: true,
    description: '启用鼠标拖拽和滚动工具 (mouse_drag, mouse_scroll)',
  },
  keyboard: {
    type: 'boolean',
    label: '键盘快捷键',
    default: true,
    description: '启用键盘快捷键工具 (keyboard_press)',
  },
  window: {
    type: 'boolean',
    label: '桌面管理',
    default: true,
    description: '启用桌面管理工具 (list_apps, window_resize)',
  },
  clipboard: {
    type: 'boolean',
    label: '剪贴板',
    default: true,
    description: '启用剪贴板读写工具 (clipboard_read, clipboard_write)',
  },
  app: {
    type: 'boolean',
    label: '应用管理',
    default: true,
    description: '启用应用启动/关闭工具 (app_launch, app_close)',
  },
  uiAutomation: {
    type: 'boolean',
    label: 'UI 元素树',
    default: true,
    description: '启用 UI 元素树工具 (ui_tree, ui_find, ui_element_at)。仅 macOS 可用，基于 Accessibility API。',
  },
  webAutomation: {
    type: 'boolean',
    label: 'Web 自动化',
    default: true,
    description: '启用 Electron/CEF/Chrome 应用的 Web 自动化工具 (web_connect, web_inspect, web_action, web_eval)。基于 Chrome DevTools Protocol。',
  },
  maxImageWidth: {
    type: 'number',
    label: '最大截图宽度',
    default: 1280,
    description: '截图的最大宽度(px)，超出会自动缩放以节省 token。设为 0 不缩放。',
  },
  screenshotDir: {
    type: 'string',
    label: '截图保存目录',
    default: 'workspace/.tmp/screenshots',
    description: '截图文件保存目录（相对于工作目录）。AI 通过文件路径引用截图，再使用图片识别工具分析。',
  },
};

export const defaultConfig = {
  screenshot: true,
  interact: true,
  mouse: true,
  keyboard: true,
  window: true,
  clipboard: true,
  app: true,
  uiAutomation: true,
  webAutomation: true,
  maxImageWidth: 1280,
  screenshotDir: 'workspace/.tmp/screenshots',
};

// ──────────── 插件入口 ────────────

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('computer-use');
  const platformType = detectPlatform();

  let adapter: PlatformAdapter;
  try {
    adapter = await createAdapter();
  } catch (err) {
    logger.error(`初始化平台适配器失败 (${platformType}): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // macOS 权限检测
  if (platformType === 'macos') {
    try {
      const perms = await adapter.checkPermissions();
      if (!perms.accessibility) {
        logger.warn(
          '⚠️ 未获得辅助功能权限！鼠标/键盘操控将无法工作。\n' +
          '   请前往: 系统设置 → 隐私与安全性 → 辅助功能 → 允许当前终端/Node.js 程序'
        );
      }
      if (!perms.screenRecording) {
        logger.warn(
          '⚠️ 未获得屏幕录制权限！截图功能将无法工作。\n' +
          '   请前往: 系统设置 → 隐私与安全性 → 屏幕录制 → 允许当前终端/Node.js 程序'
        );
      }
      if (perms.accessibility && perms.screenRecording) {
        logger.info('macOS 权限检测通过 ✓');
      }
    } catch (err) {
      logger.warn(`权限检测失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 注册工具分组
  ctx.registerToolGroup({
    name: 'computer-use',
    label: '桌面操控',
    description:
      `通过 UI 组件交互、截屏观察、键盘快捷键等操作控制计算机桌面 (当前平台: ${platformType})。\n` +
      '这些工具直接控制桌面，键鼠等，请谨慎使用。',
  });

  // 创建带分组标记的上下文代理
  const groupCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (tool: Parameters<Context['registerTool']>[0]) =>
          target.registerTool({ ...tool, groups: [...(tool.groups || []), 'computer-use'] });
      }
      return Reflect.get(target, prop, target);
    },
  }) as Context;

  // CDP 管理器（web 自动化和应用启动共享）
  const cdpManager = config.webAutomation ? new CdpManager() : undefined;

  // 按配置注册各工具组
  if (config.screenshot) {
    registerScreenshotTools(groupCtx, adapter, {
      maxImageWidth: config.maxImageWidth,
      screenshotDir: resolve(process.cwd(), config.screenshotDir),
    });
    logger.info('截图工具已启用 (screen_capture)');
  }

  if (config.interact) {
    registerInteractTools(groupCtx, adapter);
    logger.info('智能交互工具已启用 (click, type_text, focus_app)');
  }

  if (config.mouse) {
    registerMouseTools(groupCtx, adapter);
    logger.info('鼠标工具已启用 (mouse_drag, mouse_scroll)');
  }

  if (config.keyboard) {
    registerKeyboardTools(groupCtx, adapter);
    logger.info('键盘工具已启用 (keyboard_press)');
  }

  if (config.window) {
    registerWindowTools(groupCtx, adapter);
    logger.info('桌面管理工具已启用 (list_apps, window_resize)');
  }

  if (config.clipboard) {
    registerClipboardTools(groupCtx, adapter);
    logger.info('剪贴板工具已启用');
  }

  if (config.app) {
    registerAppTools(groupCtx, adapter, cdpManager);
    logger.info('应用管理工具已启用');
  }

  if (config.uiAutomation) {
    if (platformType === 'macos' && axNative.isAvailable()) {
      registerUIAutomationTools(groupCtx);
      logger.info('UI 元素树工具已启用 (ui_tree, ui_find, ui_element_at)');
    } else if (platformType === 'macos') {
      const loadErr = axNative.getLoadError();
      logger.warn(`UI 元素树不可用: ${loadErr || '原生模块未编译'}`);
      logger.warn('  运行 bash packages/plugin-computer-use/native/build.sh 构建原生模块');
    } else {
      logger.info('UI 元素树工具跳过（仅 macOS 可用）');
    }
  }

  if (config.webAutomation && cdpManager) {
    registerWebAutomationTools(groupCtx, cdpManager);
    logger.info('Web 自动化工具已启用 (web_connect, web_inspect, web_action, web_eval)');
  }

  const enabledCount = [
    config.screenshot, config.interact, config.mouse, config.keyboard,
    config.window, config.clipboard, config.app, config.uiAutomation, config.webAutomation,
  ].filter(Boolean).length;

  logger.info(
    `桌面操控插件已启动 (平台: ${platformType}, 已启用 ${enabledCount} 组工具)`
  );
}

// ──────────── 辅助函数 ────────────

function resolveConfig(raw: Record<string, unknown>): ComputerUseConfig {
  return {
    screenshot: (raw.screenshot as boolean) ?? true,
    interact: (raw.interact as boolean) ?? true,
    mouse: (raw.mouse as boolean) ?? true,
    keyboard: (raw.keyboard as boolean) ?? true,
    window: (raw.window as boolean) ?? true,
    clipboard: (raw.clipboard as boolean) ?? true,
    app: (raw.app as boolean) ?? true,
    uiAutomation: (raw.uiAutomation as boolean) ?? true,
    webAutomation: (raw.webAutomation as boolean) ?? true,
    maxImageWidth: (raw.maxImageWidth as number) ?? 1280,
    screenshotDir: (raw.screenshotDir as string) || 'workspace/.tmp/screenshots',
  };
}
