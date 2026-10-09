// 快捷键按平台取修饰键：Mac 上是 ⌘，其余是 Ctrl，另一个按下时不算。字母照 key 认；Option、Alt 把 key 变成了别的字符时
// 按物理键位认，这样不同键盘布局下不会把别的字母误认成快捷键。不占浏览器保留的 ⌘N、⌘T、⌘W、Ctrl+Tab

interface Shortcut {
  key: string;
  shift?: boolean;
  alt?: boolean;
}

const SHORTCUTS = {
  search: { key: 'k' },
  newSession: { key: 'o', shift: true },
  toggleLeft: { key: 'b' },
  toggleRight: { key: 'b', alt: true },
} satisfies Record<string, Shortcut>;

type ShortcutName = keyof typeof SHORTCUTS;

const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** 悬停提示与菜单项右侧写的键 */
export function shortcutLabel(name: ShortcutName): string {
  const { key, shift, alt }: Shortcut = SHORTCUTS[name];
  const letter = key.toUpperCase();
  if (isMac()) return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘${letter}`;
  return ['Ctrl', alt && 'Alt', shift && 'Shift', letter].filter(Boolean).join('+');
}

export function shortcutOf(event: KeyboardEvent): ShortcutName | undefined {
  const mac = isMac();
  if (!(mac ? event.metaKey : event.ctrlKey) || (mac ? event.ctrlKey : event.metaKey)) return undefined;
  const letter = /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase();
  return (Object.keys(SHORTCUTS) as ShortcutName[]).find(name => {
    const { key, shift, alt }: Shortcut = SHORTCUTS[name];
    return key === letter && Boolean(shift) === event.shiftKey && Boolean(alt) === event.altKey;
  });
}

/** 在选中的标签上关闭它的键，按平台写：Mac 上标着 delete 的键送出 Backspace（fn+delete 才送出 Delete），两个都认 */
export function closeTabKey(): { aria: string; label: string; matches(key: string): boolean } {
  return isMac()
    ? { aria: 'Backspace', label: '⌫', matches: key => key === 'Backspace' || key === 'Delete' }
    : { aria: 'Delete', label: 'Delete', matches: key => key === 'Delete' };
}

/** 输入法组字时的按键（回车上屏、Esc 取消候选）不算：Safari 在组字结束后仍会送出这次按键的 keydown，keyCode 是 229 */
export function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
