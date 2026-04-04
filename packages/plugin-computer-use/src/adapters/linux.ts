/**
 * Linux 平台适配器
 *
 * 使用 scrot/gnome-screenshot/import (ImageMagick) 进行截图，
 * 使用 @nut-tree/nut-js 进行鼠标/键盘操控，
 * 使用 xdotool/wmctrl 进行窗口管理。
 */

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PlatformAdapter, Point, Region, ScreenInfo, WindowInfo, MouseButton } from '../platform.js';

const execFileAsync = promisify(execFile);

export class LinuxAdapter implements PlatformAdapter {
  readonly platform = 'linux';
  private nutjs: any = null;

  private async getNutJs() {
    if (!this.nutjs) {
      this.nutjs = await import('@nut-tree/nut-js');
    }
    return this.nutjs;
  }

  // Linux 无需特殊权限检测
  async checkPermissions(): Promise<{ accessibility: boolean; screenRecording: boolean }> {
    return { accessibility: true, screenRecording: true };
  }

  // ──────────── 屏幕 ────────────

  async captureScreen(region?: Region): Promise<Buffer> {
    const tmpPath = join(tmpdir(), `aalis-screenshot-${Date.now()}.png`);
    try {
      // 尝试多种截图工具，按优先级
      const captured = await this.tryCapture(tmpPath, region);
      if (!captured) throw new Error('未找到可用的截图工具。请安装 scrot, gnome-screenshot 或 ImageMagick (import)。');
      return await readFile(tmpPath);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  private async tryCapture(outPath: string, region?: Region): Promise<boolean> {
    // 1. scrot
    try {
      const args = region
        ? ['-a', `${region.x},${region.y},${region.width},${region.height}`, outPath]
        : [outPath];
      await execFileAsync('scrot', args, { timeout: 10000 });
      return true;
    } catch {}

    // 2. gnome-screenshot
    try {
      const args = region
        ? ['-a', `${region.x},${region.y},${region.width},${region.height}`, '-f', outPath]
        : ['-f', outPath];
      await execFileAsync('gnome-screenshot', args, { timeout: 10000 });
      return true;
    } catch {}

    // 3. ImageMagick import
    try {
      const args = region
        ? ['-window', 'root', '-crop', `${region.width}x${region.height}+${region.x}+${region.y}`, outPath]
        : ['-window', 'root', outPath];
      await execFileAsync('import', args, { timeout: 10000 });
      return true;
    } catch {}

    return false;
  }

  async getScreenInfo(): Promise<ScreenInfo> {
    try {
      const { stdout } = await execFileAsync('xdpyinfo', [], { timeout: 5000 });
      const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
      if (match) {
        return { width: Number(match[1]), height: Number(match[2]), scaleFactor: 1 };
      }
    } catch {}
    // 回退使用 xrandr
    try {
      const { stdout } = await execFileAsync('xrandr', ['--current'], { timeout: 5000 });
      const match = stdout.match(/current (\d+) x (\d+)/);
      if (match) {
        return { width: Number(match[1]), height: Number(match[2]), scaleFactor: 1 };
      }
    } catch {}
    return { width: 1920, height: 1080, scaleFactor: 1 };
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
      const { stdout } = await execFileAsync('wmctrl', ['-lG'], { timeout: 5000 });
      const windows: WindowInfo[] = [];
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue;
        // wmctrl -lG 格式: windowId desktop x y width height hostname title
        const parts = line.trim().split(/\s+/);
        if (parts.length < 8) continue;
        const [wid, , x, y, w, h, , ...titleParts] = parts;
        windows.push({
          id: wid,
          title: titleParts.join(' '),
          app: '',
          bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
        });
      }
      return windows;
    } catch {
      // 回退到 xdotool
      try {
        const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', ''], { timeout: 5000 });
        const windows: WindowInfo[] = [];
        for (const wid of stdout.trim().split('\n')) {
          if (!wid.trim()) continue;
          try {
            const { stdout: nameOut } = await execFileAsync('xdotool', ['getwindowname', wid.trim()], { timeout: 2000 });
            windows.push({ id: wid.trim(), title: nameOut.trim(), app: '' });
          } catch {}
        }
        return windows;
      } catch {}
      return [];
    }
  }

  async focusWindow(windowId: string): Promise<void> {
    try {
      await execFileAsync('wmctrl', ['-i', '-a', windowId], { timeout: 5000 });
    } catch {
      await execFileAsync('xdotool', ['windowactivate', windowId], { timeout: 5000 });
    }
  }

  async resizeWindow(windowId: string, bounds: Region): Promise<void> {
    try {
      await execFileAsync('wmctrl', ['-i', '-r', windowId, '-e', `0,${bounds.x},${bounds.y},${bounds.width},${bounds.height}`], { timeout: 5000 });
    } catch {
      await execFileAsync('xdotool', ['windowmove', windowId, String(bounds.x), String(bounds.y)], { timeout: 5000 });
      await execFileAsync('xdotool', ['windowsize', windowId, String(bounds.width), String(bounds.height)], { timeout: 5000 });
    }
  }

  // ──────────── 剪贴板 ────────────

  async clipboardRead(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { timeout: 3000 });
      return stdout;
    } catch {
      const { stdout } = await execFileAsync('xsel', ['--clipboard', '--output'], { timeout: 3000 });
      return stdout;
    }
  }

  async clipboardWrite(text: string): Promise<void> {
    try {
      const child = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.write(text);
      child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`xclip failed: ${code}`)));
        child.on('error', reject);
      });
    } catch {
      const child = spawn('xsel', ['--clipboard', '--input'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin.write(text);
      child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`xsel failed: ${code}`)));
        child.on('error', reject);
      });
    }
  }

  // ──────────── 应用 ────────────

  async launchApp(appName: string, args: string[] = []): Promise<{ pid?: number }> {
    const child = spawn(appName, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  }

  async closeApp(appName: string): Promise<void> {
    await execFileAsync('pkill', ['-f', appName], { timeout: 5000 }).catch(() => {});
  }

  // ──────────── 辅助 ────────────

  private mapButton(nut: any, button: MouseButton): any {
    switch (button) {
      case 'right': return nut.Button.RIGHT;
      case 'middle': return nut.Button.MIDDLE;
      default: return nut.Button.LEFT;
    }
  }

  private mapKey(nut: any, key: string): any {
    const keyMap: Record<string, string> = {
      'ctrl': 'LeftControl', 'control': 'LeftControl',
      'alt': 'LeftAlt', 'option': 'LeftAlt',
      'shift': 'LeftShift',
      'meta': 'LeftSuper', 'cmd': 'LeftSuper', 'command': 'LeftSuper', 'super': 'LeftSuper', 'win': 'LeftSuper',
      'enter': 'Return', 'return': 'Return',
      'tab': 'Tab', 'space': 'Space',
      'backspace': 'Backspace', 'delete': 'Delete',
      'escape': 'Escape', 'esc': 'Escape',
      'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
      'home': 'Home', 'end': 'End',
      'pageup': 'PageUp', 'pagedown': 'PageDown',
      'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4',
      'f5': 'F5', 'f6': 'F6', 'f7': 'F7', 'f8': 'F8',
      'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
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
