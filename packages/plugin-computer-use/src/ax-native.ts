/**
 * macOS Accessibility 原生模块的 TypeScript 绑定
 *
 * 动态加载编译好的 .node 文件，暴露 UI 元素树读取和操作 API。
 * 仅在 macOS 上可用。
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ──────────── 类型定义 ────────────

export interface AXElementInfo {
  path: string;
  role: string;
  roleDescription?: string;
  title?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  focused?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  actions: string[];
  childrenCount: number;
  children: AXElementInfo[];
}

export interface AXProcessInfo {
  pid: number;
  name: string;
  bundleId?: string;
}

export interface AXNativeModule {
  checkAccessibilityPermission(): boolean;
  requestAccessibilityPermission(): boolean;
  getUiTree(pid: number, maxDepth: number, includeInvisible?: boolean): AXElementInfo[];
  findElements(pid: number, role?: string, title?: string, maxDepth?: number): AXElementInfo[];
  performAction(pid: number, elementPath: string, action: string): boolean;
  setElementValue(pid: number, elementPath: string, value: string): boolean;
  getElementAtPosition(pid: number, x: number, y: number): AXElementInfo | null;
  listUiProcesses(): AXProcessInfo[];
}

// ──────────── 模块加载 ────────────

let _module: AXNativeModule | null = null;
let _loadError: string | null = null;

function getNativeModule(): AXNativeModule | null {
  if (_module) return _module;
  if (_loadError) return null;

  if (platform() !== 'darwin') {
    _loadError = 'UI 自动化原生模块仅支持 macOS';
    return null;
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);

  // 查找 .node 文件
  const archName = arch() === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    join(__dirname, '..', `ax-native.darwin-${archName}.node`),
    join(__dirname, '..', 'ax-native.node'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        _module = require(candidate) as AXNativeModule;
        return _module;
      } catch (err) {
        _loadError = `加载原生模块失败 (${candidate}): ${err instanceof Error ? err.message : String(err)}`;
        return null;
      }
    }
  }

  _loadError = '未找到原生模块。请运行 bash native/build.sh 构建原生模块。';
  return null;
}

// ──────────── 公开 API ────────────

export function isAvailable(): boolean {
  return getNativeModule() !== null;
}

export function getLoadError(): string | null {
  getNativeModule(); // 触发加载尝试
  return _loadError;
}

export function checkAccessibilityPermission(): boolean {
  const mod = getNativeModule();
  return mod?.checkAccessibilityPermission() ?? false;
}

export function requestAccessibilityPermission(): boolean {
  const mod = getNativeModule();
  return mod?.requestAccessibilityPermission() ?? false;
}

export function getUiTree(pid: number, maxDepth: number = 3, includeInvisible: boolean = false): AXElementInfo[] {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.getUiTree(pid, maxDepth, includeInvisible);
}

export function findElements(pid: number, role?: string, title?: string, maxDepth?: number): AXElementInfo[] {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.findElements(pid, role, title, maxDepth);
}

export function performAction(pid: number, elementPath: string, action: string): boolean {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.performAction(pid, elementPath, action);
}

export function setElementValue(pid: number, elementPath: string, value: string): boolean {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.setElementValue(pid, elementPath, value);
}

export function getElementAtPosition(pid: number, x: number, y: number): AXElementInfo | null {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.getElementAtPosition(pid, x, y);
}

export function listUiProcesses(): AXProcessInfo[] {
  const mod = getNativeModule();
  if (!mod) throw new Error(_loadError || 'UI 自动化不可用');
  return mod.listUiProcesses();
}
