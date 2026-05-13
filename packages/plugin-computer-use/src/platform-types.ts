/**
 * 平台层公共类型 —— 与 platform.ts 解耦的纯 TS 类型出口。
 *
 * 拆分动机：原本 platform.ts 既导出类型又通过 dynamic import 加载 adapter，
 * adapter 又 `import type` 这些类型，构成 platform.ts ↔ adapters/* 的循环图谱
 * （madge 报真循环；尽管 `import type` 在 tsc emit 后被完全擦除，运行时无环，
 * 但 ESM/bundler/类型工具仍可能在分析阶段拒绝）。
 *
 * 解法：把不依赖 node:os 的纯类型集中到本文件。
 *  - adapter 只 `import type` 这里，不再 import platform.ts
 *  - platform.ts re-export 这里的类型 + 自己负责 detect/create 的运行时
 *  - tools/* 仍可 `import type` platform.ts（透传 re-export），不需要改动
 */

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

export type PlatformType = 'macos' | 'linux' | 'windows';

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
