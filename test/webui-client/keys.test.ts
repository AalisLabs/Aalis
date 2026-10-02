// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composing, shortcutLabel, shortcutOf } from '../../packages/plugin-webui-client/src/keys.js';
import { stubPlatform } from '../helpers/browser.js';

// 快捷键只有六项：Cmd/Ctrl+K 搜索、Cmd/Ctrl+Shift+O 新会话、Cmd/Ctrl+B 与 Cmd/Ctrl+Alt+B 收起两侧，加上输入框自己的
// Enter 与 Esc。按平台取 ⌘ 或 Ctrl，另一个修饰键按下时不算；不占浏览器保留的 ⌘N、⌘T、⌘W、Ctrl+Tab

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

afterEach(() => vi.restoreAllMocks());

describe('快捷键', () => {
  it('Mac 上用 ⌘，悬停提示按 Mac 的写法', () => {
    stubPlatform('MacIntel');
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('search');
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))).toBe('newSession');
    expect(shortcutOf(key({ key: 'b', code: 'KeyB', metaKey: true }))).toBe('toggleLeft');
    // Option 改变了 key（⌥B 打出 ∫）时按物理键位认
    expect(shortcutOf(key({ key: '∫', code: 'KeyB', metaKey: true, altKey: true }))).toBe('toggleRight');
    expect(shortcutLabel('search')).toBe('⌘K');
    expect(shortcutLabel('newSession')).toBe('⇧⌘O');
    expect(shortcutLabel('toggleRight')).toBe('⌥⌘B');
  });

  it('Windows 与 Linux 上用 Ctrl', () => {
    stubPlatform('Win32');
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe('search');
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true }))).toBe('toggleRight');
    expect(shortcutLabel('newSession')).toBe('Ctrl+Shift+O');
    expect(shortcutLabel('toggleRight')).toBe('Ctrl+Alt+B');
    stubPlatform('Linux x86_64');
    expect(shortcutOf(key({ key: 'o', code: 'KeyO', ctrlKey: true, shiftKey: true }))).toBe('newSession');
  });

  it('修饰键要完全对上；字母照 key 认，不同键盘布局下不按物理键位误认', () => {
    stubPlatform('Win32');
    expect(shortcutOf(key({ key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'k', code: 'KeyK' }))).toBeUndefined();
    // 某些布局下物理 B 键打出 x：Ctrl+X 是剪切，不当成收起左栏
    expect(shortcutOf(key({ key: 'x', code: 'KeyB', ctrlKey: true }))).toBeUndefined();
  });

  it('不占浏览器保留的键', () => {
    stubPlatform('MacIntel');
    for (const letter of ['n', 't', 'w']) {
      expect(shortcutOf(key({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true }))).toBeUndefined();
    }
    stubPlatform('Win32');
    expect(shortcutOf(key({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBeUndefined();
    expect(shortcutOf(key({ key: 'n', code: 'KeyN', ctrlKey: true }))).toBeUndefined();
  });
});

describe('输入法组字', () => {
  it('组字中的按键与 Safari 组字结束后补发的按键（keyCode 229）都算组字', () => {
    expect(composing(key({ key: 'Enter', isComposing: true, keyCode: 13 }))).toBe(true);
    expect(composing(key({ key: 'Enter', keyCode: 229 }))).toBe(true);
    expect(composing(key({ key: 'Escape', keyCode: 229 }))).toBe(true);
    expect(composing(key({ key: 'Enter', keyCode: 13 }))).toBe(false);
  });
});
