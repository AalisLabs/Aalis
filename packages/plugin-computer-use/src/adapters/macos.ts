/**
 * macOS 平台适配器
 *
 * 使用 screencapture CLI 进行截图，
 * 使用 @nut-tree-fork/nut-js 进行鼠标/键盘操控，
 * 使用 AppleScript (osascript) 进行窗口管理和应用控制。
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MouseButton, PlatformAdapter, Point, Region, ScreenInfo, WindowInfo } from '../platform.js';

const execFileAsync = promisify(execFile);

export class MacOSAdapter implements PlatformAdapter {
  readonly platform = 'macos';
  private nutjs: any = null;

  private async getNutJs() {
    if (!this.nutjs) {
      this.nutjs = await import('@nut-tree-fork/nut-js');
    }
    return this.nutjs;
  }

  // ──────────── 权限检测 ────────────

  async checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    let accessibility = false;
    let screenRecording = false;

    // 检测辅助功能权限：尝试获取鼠标位置
    try {
      const nut = await this.getNutJs();
      await nut.mouse.getPosition();
      accessibility = true;
    } catch {}

    // 检测屏幕录制权限：尝试截一张小图
    try {
      const tmpPath = join(tmpdir(), `aalis-perm-check-${Date.now()}.png`);
      await execFileAsync('screencapture', ['-x', '-t', 'png', tmpPath], { timeout: 5000 });
      const { size } = await import('node:fs/promises').then(fs => fs.stat(tmpPath));
      await unlink(tmpPath).catch(() => {});
      // 如果截图文件非常小（<1KB），可能是权限不足导致的空文件
      screenRecording = size > 1000;
    } catch {}

    return { accessibility, screenRecording };
  }

  // ──────────── 屏幕 ────────────

  async captureScreen(region?: Region): Promise<Buffer> {
    const tmpPath = join(tmpdir(), `aalis-screenshot-${Date.now()}.png`);
    try {
      const args = ['-x', '-t', 'png']; // -x 不播放快门声
      if (region) {
        args.push('-R', `${region.x},${region.y},${region.width},${region.height}`);
      }
      args.push(tmpPath);
      await execFileAsync('screencapture', args, { timeout: 10000 });
      const buffer = await readFile(tmpPath);
      return buffer;
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    const script = `
      tell application "Finder"
        set _bounds to bounds of window of desktop
        return (item 3 of _bounds) & "," & (item 4 of _bounds)
      end tell
    `;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
      const [w, h] = stdout.trim().split(',').map(Number);
      // 获取 Retina 缩放因子
      const { stdout: sysInfo } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], {
        timeout: 10000,
      });
      let scaleFactor = 2; // macOS 默认 Retina
      try {
        const data = JSON.parse(sysInfo);
        const displays = data?.SPDisplaysDataType?.[0]?.spdisplays_ndrvs;
        if (displays?.[0]?._spdisplays_resolution) {
          const res = displays[0]._spdisplays_resolution as string;
          if (res.includes('Retina')) scaleFactor = 2;
          else scaleFactor = 1;
        }
      } catch {}
      return { width: w || 1920, height: h || 1080, scaleFactor };
    } catch {
      return { width: 1920, height: 1080, scaleFactor: 2 };
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
      // 组合键：按住所有修饰键，按最后一个键，再释放
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
    const script = `
      set output to ""
      tell application "System Events"
        set allProcesses to every process whose background only is false
        repeat with proc in allProcesses
          set procName to name of proc
          try
            set allWindows to every window of proc
            repeat with win in allWindows
              set winTitle to name of win
              set winPos to position of win
              set winSz to size of win
              set output to output & procName & "|||" & winTitle & "|||" & (item 1 of winPos) & "," & (item 2 of winPos) & "," & (item 1 of winSz) & "," & (item 2 of winSz) & linefeed
            end repeat
          end try
        end repeat
      end tell
      return output
    `;
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10000 });
      const windows: WindowInfo[] = [];
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('|||');
        if (parts.length < 3) continue;
        const [app, title, boundsStr] = parts;
        const [bx, by, bw, bh] = (boundsStr || '').split(',').map(Number);
        windows.push({
          id: `${app}::${title}`,
          title: title || '',
          app: app || '',
          bounds: !Number.isNaN(bx) ? { x: bx, y: by, width: bw, height: bh } : undefined,
        });
      }
      return windows;
    } catch {
      return [];
    }
  }

  async focusWindow(windowId: string): Promise<void> {
    const [app, title] = windowId.split('::');
    const script = title
      ? `tell application "${this.escapeAppleScript(app)}" to activate
         tell application "System Events"
           tell process "${this.escapeAppleScript(app)}"
             set frontmost to true
             try
               perform action "AXRaise" of (first window whose name is "${this.escapeAppleScript(title)}")
             end try
           end tell
         end tell`
      : `tell application "${this.escapeAppleScript(app)}" to activate`;
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  }

  async resizeWindow(windowId: string, bounds: Region): Promise<void> {
    const [app, title] = windowId.split('::');
    const script = `
      tell application "System Events"
        tell process "${this.escapeAppleScript(app)}"
          set frontmost to true
          try
            set targetWin to first window whose name is "${this.escapeAppleScript(title || '')}"
            set position of targetWin to {${bounds.x}, ${bounds.y}}
            set size of targetWin to {${bounds.width}, ${bounds.height}}
          end try
        end tell
      end tell
    `;
    await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
  }

  // ──────────── 剪贴板 ────────────

  async clipboardRead(): Promise<string> {
    const { stdout } = await execFileAsync('pbpaste', [], { timeout: 3000 });
    return stdout;
  }

  async clipboardWrite(text: string): Promise<void> {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(text);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`pbcopy failed: ${code}`))));
      child.on('error', reject);
    });
  }

  // ──────────── 应用 ────────────

  async launchApp(appName: string, args: string[] = []): Promise<{ pid?: number }> {
    // 尝试用 open 打开 .app
    try {
      await execFileAsync('open', ['-a', appName, ...args], { timeout: 10000 });
      return {};
    } catch {
      // 也可能是命令行工具
      const child = spawn(appName, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { pid: child.pid };
    }
  }

  async closeApp(appName: string): Promise<void> {
    const script = `tell application "${this.escapeAppleScript(appName)}" to quit`;
    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    } catch {
      // 回退到 killall
      await execFileAsync('killall', [appName], { timeout: 5000 }).catch(() => {});
    }
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
      // 修饰键
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
      // 功能键
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
      // F 键
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
    // 单字符键
    if (key.length === 1) {
      const upper = key.toUpperCase();
      if (nut.Key[upper] !== undefined) return nut.Key[upper];
    }
    // 直接查找
    if (nut.Key[key] !== undefined) return nut.Key[key];
    throw new Error(`未知按键: ${key}`);
  }

  private escapeAppleScript(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
