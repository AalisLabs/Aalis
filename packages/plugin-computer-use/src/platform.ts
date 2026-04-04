/**
 * 平台检测与适配器接口
 *
 * 定义跨平台桌面操控的统一接口，各平台提供独立实现。
 */

import { platform } from 'node:os';

// ──────────── 类型定义 ────────────

export interface Point {
  x: number;
  y: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string;
  app: string;
  bounds?: Region;
  focused?: boolean;
}

export interface ScreenInfo {
  width: number;
  height: number;
  scaleFactor: number;
}

export type MouseButton = 'left' | 'right' | 'middle';

// ──────────── 适配器接口 ────────────

export interface PlatformAdapter {
  readonly platform: string;

  // 权限检测（macOS 需要辅助功能和屏幕录制权限）
  checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }>;

  // 屏幕
  captureScreen(region?: Region): Promise<Buffer>;
  getScreenInfo(): Promise<ScreenInfo>;

  // 鼠标
  mouseMove(x: number, y: number): Promise<void>;
  mouseClick(x: number, y: number, button?: MouseButton, clickCount?: number): Promise<void>;
  mouseDrag(fromX: number, fromY: number, toX: number, toY: number, button?: MouseButton): Promise<void>;
  mouseScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  getMousePosition(): Promise<Point>;

  // 键盘
  keyboardType(text: string): Promise<void>;
  keyboardPress(keys: string[]): Promise<void>;

  // 窗口
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(windowId: string): Promise<void>;
  resizeWindow(windowId: string, bounds: Region): Promise<void>;

  // 剪贴板
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;

  // 应用
  launchApp(appName: string, args?: string[]): Promise<{ pid?: number }>;
  closeApp(appName: string): Promise<void>;
}

// ──────────── 平台检测 ────────────

export type PlatformType = 'macos' | 'linux' | 'windows';

export function detectPlatform(): PlatformType {
  switch (platform()) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

export async function createAdapter(): Promise<PlatformAdapter> {
  const p = detectPlatform();
  switch (p) {
    case 'macos': {
      const { MacOSAdapter } = await import('./adapters/macos.js');
      return new MacOSAdapter();
    }
    case 'linux': {
      const { LinuxAdapter } = await import('./adapters/linux.js');
      return new LinuxAdapter();
    }
    case 'windows': {
      const { WindowsAdapter } = await import('./adapters/windows.js');
      return new WindowsAdapter();
    }
  }
}
