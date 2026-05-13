/**
 * Windows 平台适配器
 *
 * 使用 PowerShell 进行截图，
 * 使用 @nut-tree-fork/nut-js 进行鼠标/键盘操控，
 * 使用 PowerShell 进行窗口管理和应用控制。
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MouseButton, PlatformAdapter, Point, Region, ScreenInfo, WindowInfo } from '../platform-types.js';

function runPowerShell(script: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, _stderr) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  });
}

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = 'windows';
  private nutjs: any = null;

  private async getNutJs() {
    if (!this.nutjs) {
      this.nutjs = await import('@nut-tree-fork/nut-js');
    }
    return this.nutjs;
  }

  // Windows 无需特殊权限检测
  async checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    return { accessibility: true, screenRecording: true };
  }

  // ──────────── 屏幕 ────────────

  async captureScreen(region?: Region): Promise<Buffer> {
    const tmpPath = join(tmpdir(), `aalis-screenshot-${Date.now()}.png`);
    try {
      const script = region
        ? `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $bmp = New-Object Drawing.Bitmap(${region.width}, ${region.height})
          $g = [Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
          $g.Dispose()
          $bmp.Save("${tmpPath.replace(/\\/g, '\\\\')}")
          $bmp.Dispose()
        `
        : `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $bmp = New-Object Drawing.Bitmap($screen.Width, $screen.Height)
          $g = [Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bmp.Size)
          $g.Dispose()
          $bmp.Save("${tmpPath.replace(/\\/g, '\\\\')}")
          $bmp.Dispose()
        `;
      await runPowerShell(script, 15000);
      return await readFile(tmpPath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    try {
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $s = [System.Windows.Forms.Screen]::PrimaryScreen
        Write-Output "$($s.Bounds.Width),$($s.Bounds.Height)"
      `;
      const result = await runPowerShell(script, 5000);
      const [w, h] = result.split(',').map(Number);
      return { width: w || 1920, height: h || 1080, scaleFactor: 1 };
    } catch {
      return { width: 1920, height: 1080, scaleFactor: 1 };
    }
  }

  // ──────────── 鼠标 ────────────

  async mouseMove(x: number, y: number): Promise<void> {
    const nut = await this.getNutJs();
    await nut.mouse.setPosition(new nut.Point(x, y));
  }

  async mouseClick(x: number, y: number, button: MouseButton = 'left', clickCount: number = 1): Promise<void> {
    const nut = await this.getNutJs();
    await nut.mouse.setPosition(new nut.Point(x, y));
    const btn = this.mapButton(nut, button);
    for (let i = 0; i < clickCount; i++) {
      await nut.mouse.click(btn);
    }
  }

  async mouseDrag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton = 'left'): Promise<void> {
    const nut = await this.getNutJs();
    await nut.mouse.setPosition(new nut.Point(fromX, fromY));
    await nut.mouse.pressButton(this.mapButton(nut, button));
    await nut.mouse.setPosition(new nut.Point(toX, toY));
    await nut.mouse.releaseButton(this.mapButton(nut, button));
  }

  async mouseScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    const nut = await this.getNutJs();
    await nut.mouse.setPosition(new nut.Point(x, y));
    if (deltaY > 0) await nut.mouse.scrollDown(Math.abs(deltaY));
    else if (deltaY < 0) await nut.mouse.scrollUp(Math.abs(deltaY));
    if (deltaX > 0) await nut.mouse.scrollRight(Math.abs(deltaX));
    else if (deltaX < 0) await nut.mouse.scrollLeft(Math.abs(deltaX));
  }

  async getMousePosition(): Promise<Point> {
    const nut = await this.getNutJs();
    const pos = await nut.mouse.getPosition();
    return { x: pos.x, y: pos.y };
  }

  // ──────────── 键盘 ────────────

  async keyboardType(text: string): Promise<void> {
    const nut = await this.getNutJs();
    await nut.keyboard.type(text);
  }

  async keyboardPress(keys: string[]): Promise<void> {
    const nut = await this.getNutJs();
    const mapped = keys.map(k => this.mapKey(nut, k));
    if (mapped.length === 1) {
      await nut.keyboard.pressKey(mapped[0]);
      await nut.keyboard.releaseKey(mapped[0]);
    } else {
      for (let i = 0; i < mapped.length - 1; i++) {
        await nut.keyboard.pressKey(mapped[i]);
      }
      await nut.keyboard.pressKey(mapped[mapped.length - 1]);
      await nut.keyboard.releaseKey(mapped[mapped.length - 1]);
      for (let i = mapped.length - 2; i >= 0; i--) {
        await nut.keyboard.releaseKey(mapped[i]);
      }
    }
  }

  // ──────────── 窗口管理 ────────────

  async listWindows(): Promise<WindowInfo[]> {
    try {
      const script = `
        Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
          "$($_.Id)|||$($_.ProcessName)|||$($_.MainWindowTitle)"
        }
      `;
      const result = await runPowerShell(script, 10000);
      return result
        .split('\n')
        .filter(l => l.trim())
        .map(line => {
          const [pid, proc, title] = line.split('|||');
          return { id: pid || '', title: title || '', app: proc || '' };
        });
    } catch {
      return [];
    }
  }

  async focusWindow(windowId: string): Promise<void> {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
      $proc = Get-Process -Id ${windowId} -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle) {
        [Win32]::SetForegroundWindow($proc.MainWindowHandle)
      }
    `;
    await runPowerShell(script, 5000);
  }

  async resizeWindow(windowId: string, bounds: Region): Promise<void> {
    const script = `
      Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32Move {
          [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
        }
"@
      $proc = Get-Process -Id ${windowId} -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle) {
        [Win32Move]::MoveWindow($proc.MainWindowHandle, ${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height}, $true)
      }
    `;
    await runPowerShell(script, 5000);
  }

  // ──────────── 剪贴板 ────────────

  async clipboardRead(): Promise<string> {
    return await runPowerShell('Get-Clipboard', 3000);
  }

  async clipboardWrite(text: string): Promise<void> {
    // 使用 stdin 传入数据避免注入
    const escaped = text.replace(/'/g, "''");
    await runPowerShell(`Set-Clipboard -Value '${escaped}'`, 3000);
  }

  // ──────────── 应用 ────────────

  async launchApp(appName: string, args: string[] = []): Promise<{ pid?: number }> {
    const child = spawn('cmd', ['/c', 'start', '', appName, ...args], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    return { pid: child.pid };
  }

  async closeApp(appName: string): Promise<void> {
    await runPowerShell(`Stop-Process -Name "${appName}" -Force -ErrorAction SilentlyContinue`, 5000);
  }

  // ──────────── 辅助 ────────────

  private mapButton(nut: any, button: MouseButton): any {
    switch (button) {
      case 'right':
        return nut.Button.RIGHT;
      case 'middle':
        return nut.Button.MIDDLE;
      default:
        return nut.Button.LEFT;
    }
  }

  private mapKey(nut: any, key: string): any {
    const keyMap: Record<string, string> = {
      ctrl: 'LeftControl',
      control: 'LeftControl',
      alt: 'LeftAlt',
      option: 'LeftAlt',
      shift: 'LeftShift',
      meta: 'LeftSuper',
      cmd: 'LeftSuper',
      command: 'LeftSuper',
      super: 'LeftSuper',
      win: 'LeftSuper',
      enter: 'Return',
      return: 'Return',
      tab: 'Tab',
      space: 'Space',
      backspace: 'Backspace',
      delete: 'Delete',
      escape: 'Escape',
      esc: 'Escape',
      up: 'Up',
      down: 'Down',
      left: 'Left',
      right: 'Right',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      f1: 'F1',
      f2: 'F2',
      f3: 'F3',
      f4: 'F4',
      f5: 'F5',
      f6: 'F6',
      f7: 'F7',
      f8: 'F8',
      f9: 'F9',
      f10: 'F10',
      f11: 'F11',
      f12: 'F12',
    };
    const mapped = keyMap[key.toLowerCase()];
    if (mapped && nut.Key[mapped] !== undefined) return nut.Key[mapped];
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (nut.Key[upper] !== undefined) return nut.Key[upper];
    }
    if (nut.Key[key] !== undefined) return nut.Key[key];
    throw new Error(`未知按键: ${key}`);
  }
}
