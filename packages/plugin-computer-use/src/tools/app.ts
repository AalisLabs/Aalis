/**
 * 应用管理工具
 *
 * 智能启动：自动检测 Electron/Chromium 应用并以调试模式启动，
 * 返回的提示引导 agent 使用正确的工具（CDP vs AX API）。
 */

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScopedToolService } from '@aalis/plugin-tools-api';
import { type AppDetectResult, detectAppType, resolveAppPath } from '../app-detect.js';
import type { CdpManager } from '../cdp/client.js';
import type { PlatformAdapter } from '../platform.js';
import { detectPlatform } from '../platform.js';

const execFile = promisify(execFileCb);

export function registerAppTools(tools: ScopedToolService, adapter: PlatformAdapter, cdpManager?: CdpManager): void {
  // ── app_launch ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'app_launch',
        description:
          '启动一个应用程序。\n' +
          '会自动检测应用类型（原生 / Electron / Chromium），并为 Electron/Chromium 类应用自动开启 CDP 调试端口。\n' +
          '启动后会告知你该应用的操控方式：\n' +
          '- 原生应用 → 使用 ui_tree + click/type_text（AX API）\n' +
          '- Electron/Chromium 应用 → 使用 web_connect + web_inspect + web_action（CDP 协议）\n\n' +
          '⚠️ 如果需要以自定义参数启动（如指定 URL），可通过 args 传入。',
        parameters: {
          type: 'object',
          properties: {
            appName: { type: 'string', description: '应用名称（如 "QQ"、"Safari"、"Visual Studio Code"）' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: '额外启动参数（可选）',
            },
            debug_port: {
              type: 'number',
              description: 'CDP 调试端口（仅 Electron/Chromium 应用，默认自动分配）',
            },
            force_native: {
              type: 'boolean',
              description: '强制以普通方式启动，不开启调试模式（默认 false）',
            },
          },
          required: ['appName'],
        },
      },
    },
    handler: async args => {
      try {
        const appName = args.appName as string;
        const extraArgs = (args.args as string[]) || [];
        const forceNative = (args.force_native as boolean) || false;
        const debugPort = args.debug_port as number | undefined;

        // macOS 智能启动
        if (detectPlatform() === 'macos' && !forceNative) {
          const appPath = await resolveAppPath(appName);

          if (appPath) {
            const detection = await detectAppType(appPath);

            if (detection.type === 'electron' || detection.type === 'chromium') {
              return await launchElectronApp(detection, extraArgs, debugPort, cdpManager);
            }
          }
        }

        // 原生应用 / 非 macOS / 强制原生
        const result = await adapter.launchApp(appName, extraArgs);
        return JSON.stringify({
          ok: true,
          appName,
          appType: 'native',
          ...result,
          hint:
            '这是原生应用。操控工作流：\n' +
            '1. list_apps 获取 PID\n' +
            '2. ui_tree(pid) 查看 UI 元素\n' +
            '3. click(pid, element_path) / type_text(pid, element_path, text) 操作',
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // ── app_close ──
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'app_close',
        description: '关闭指定的应用程序。',
        parameters: {
          type: 'object',
          properties: {
            appName: { type: 'string', description: '要关闭的应用名称' },
          },
          required: ['appName'],
        },
      },
    },
    handler: async args => {
      try {
        await adapter.closeApp(args.appName as string);
        return JSON.stringify({ ok: true, appName: args.appName });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
}

// ──────────── 智能启动 Electron/Chromium 应用 ────────────

async function launchElectronApp(
  detection: AppDetectResult,
  extraArgs: string[],
  debugPort: number | undefined,
  cdpManager?: CdpManager,
): Promise<string> {
  const port = debugPort || detection.suggestedPort || 9222;
  const appName = detection.appPath.split('/').pop()?.replace('.app', '') || 'App';

  // 用可执行文件直接启动（而非 open -a），以便附加调试参数
  const execPath = detection.execPath;
  if (!execPath) {
    // 降级：普通启动
    await execFile('open', ['-a', detection.appPath, ...extraArgs], { timeout: 10000 });
    return JSON.stringify({
      ok: true,
      appName,
      appType: detection.type,
      warning: '无法找到可执行文件，已以普通方式启动。如需 CDP 调试，请手动指定 --remote-debugging-port。',
    });
  }

  const launchArgs = [`--remote-debugging-port=${port}`, ...extraArgs];

  const child = spawn(execPath, launchArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 等待应用启动并尝试自动连接 CDP
  let cdpConnected = false;
  if (cdpManager) {
    try {
      await waitForPort(port, 8000);
      await cdpManager.connect(port);
      cdpConnected = true;
    } catch {
      // 连接失败不阻止返回
    }
  }

  return JSON.stringify({
    ok: true,
    appName,
    appType: detection.type,
    pid: child.pid,
    cdpPort: port,
    cdpConnected,
    hint: cdpConnected
      ? `已检测到 ${detection.type} 应用并自动连接 CDP（端口 ${port}）。\n` +
        '操控工作流：\n' +
        '1. web_inspect() 查看 DOM 结构\n' +
        '2. web_inspect(selector=".class", mode="query") 查找元素\n' +
        '3. web_action(selector, action="click") 点击元素\n' +
        '4. web_action(selector, action="type", text="...") 输入文本\n' +
        '5. web_eval(code="...") 执行 JS'
      : `已检测到 ${detection.type} 应用并以调试模式启动（端口 ${port}）。\n` +
        `请先使用 web_connect(port=${port}) 连接，然后用 web_inspect 查看页面结构。`,
  });
}

// ──────────── 辅助 ────────────

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
        sock.setTimeout(500, () => {
          sock.destroy();
          reject(new Error('timeout'));
        });
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`等待端口 ${port} 超时`);
}
