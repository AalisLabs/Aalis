const TERMINAL_RESTORE_SEQUENCE = '\x1b[?1006l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l';

let installed = false;

export function restoreTerminalState(): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    /* ignore */
  }
}

export function installTerminalStateRestorer(): void {
  if (installed) return;
  installed = true;
  process.once('exit', restoreTerminalState);
}
