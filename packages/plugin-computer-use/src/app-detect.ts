/**
 * 应用类型检测
 *
 * 在 macOS 上检测 .app 是否为 Electron / Chromium / CEF 应用。
 * 用于自动选择正确的操控策略（AX API vs CDP）。
 */

import { execFile as execFileCb } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export type AppType = 'electron' | 'chromium' | 'native';

export interface AppDetectResult {
  type: AppType;
  appPath: string;      // .app 完整路径
  execPath: string;     // 可执行文件路径
  bundleId?: string;
  /** Electron/Chromium 应用的建议调试端口 */
  suggestedPort?: number;
}

// 已分析过的应用缓存 (bundlePath → result)
const detectCache = new Map<string, AppDetectResult>();

// 端口分配：从 9222 开始递增，避免冲突
let nextPort = 9222;

/**
 * 根据应用名获得 .app 路径
 */
export async function resolveAppPath(appName: string): Promise<string | null> {
  // 如果已经是完整路径
  if (appName.endsWith('.app') && appName.startsWith('/')) {
    try {
      await access(appName);
      return appName;
    } catch {
      return null;
    }
  }

  // 用 mdfind 查找 (比遍历 /Applications 更快更全)
  try {
    const { stdout } = await execFile('mdfind', [
      `kMDItemKind == "Application" && kMDItemDisplayName == "${appName}"`,
    ], { timeout: 5000 });
    const firstMatch = stdout.trim().split('\n')[0];
    if (firstMatch && firstMatch.endsWith('.app')) return firstMatch;
  } catch {}

  // 回退：检查常见路径
  const candidates = [
    `/Applications/${appName}.app`,
    `/Applications/Utilities/${appName}.app`,
    `${process.env.HOME}/Applications/${appName}.app`,
  ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }

  return null;
}

/**
 * 检测应用类型（Electron / Chromium / Native）
 */
export async function detectAppType(appPath: string): Promise<AppDetectResult> {
  // 缓存
  const cached = detectCache.get(appPath);
  if (cached) return cached;

  const frameworksDir = join(appPath, 'Contents', 'Frameworks');
  const macosDir = join(appPath, 'Contents', 'MacOS');

  // 获取可执行文件名
  let execPath = '';
  try {
    const macosContents = await readdir(macosDir);
    const execName = macosContents.find(f => !f.startsWith('.'));
    if (execName) execPath = join(macosDir, execName);
  } catch {}

  // 获取 bundleId
  let bundleId: string | undefined;
  try {
    const { stdout } = await execFile('defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'], { timeout: 3000 });
    bundleId = stdout.trim();
  } catch {}

  // 检测 1: 标准 Electron（有 Electron Framework.framework）
  const hasElectronFramework = await exists(join(frameworksDir, 'Electron Framework.framework'));
  if (hasElectronFramework) {
    const result: AppDetectResult = {
      type: 'electron',
      appPath,
      execPath,
      bundleId,
      suggestedPort: nextPort++,
    };
    detectCache.set(appPath, result);
    return result;
  }

  // 检测 2: 自定义 Chromium（如 QQ 的 QQNT，有 chrome_*.pak 但不叫 Electron）
  const hasChromeResources = await findChromeResources(appPath);
  if (hasChromeResources) {
    const result: AppDetectResult = {
      type: 'chromium',
      appPath,
      execPath,
      bundleId,
      suggestedPort: nextPort++,
    };
    detectCache.set(appPath, result);
    return result;
  }

  // 检测 3: CEF（有 GPU/Renderer Helper 进程）
  const hasHelperProcesses = await findHelperProcesses(frameworksDir);
  if (hasHelperProcesses) {
    const result: AppDetectResult = {
      type: 'chromium',
      appPath,
      execPath,
      bundleId,
      suggestedPort: nextPort++,
    };
    detectCache.set(appPath, result);
    return result;
  }

  // 原生应用
  const result: AppDetectResult = {
    type: 'native',
    appPath,
    execPath,
    bundleId,
  };
  detectCache.set(appPath, result);
  return result;
}

/**
 * 检测已运行进程的应用类型
 */
export async function detectRunningAppType(pid: number): Promise<AppType> {
  try {
    // 通过 lsappinfo 获取 .app 路径
    const { stdout } = await execFile('lsappinfo', ['info', '-only', 'bundlepath', pid.toString()], { timeout: 3000 });
    const match = stdout.match(/"([^"]+\.app)"/);
    if (match) {
      const result = await detectAppType(match[1]);
      return result.type;
    }
  } catch {}

  // 回退：检查进程链接的库
  try {
    const { stdout } = await execFile('lsof', ['-p', pid.toString(), '-Fn'], { timeout: 5000 });
    if (/Electron Framework|chrome_.*\.pak|libEGL\.dylib/i.test(stdout)) {
      return 'chromium';
    }
  } catch {}

  return 'native';
}

// ──────────── 私有辅助函数 ────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 递归查找 chrome_*.pak 文件（限深度 5） */
async function findChromeResources(appPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      'find',
      [join(appPath, 'Contents'), '-name', 'chrome_*.pak', '-maxdepth', '5', '-print', '-quit'],
      { timeout: 5000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 查找 GPU/Renderer Helper 进程 */
async function findHelperProcesses(frameworksDir: string): Promise<boolean> {
  try {
    const contents = await readdir(frameworksDir);
    return contents.some(name =>
      /Helper.*\(GPU\)|Helper.*\(Renderer\)/i.test(name),
    );
  } catch {
    return false;
  }
}
