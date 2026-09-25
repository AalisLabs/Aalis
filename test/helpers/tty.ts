/** 伪造 TTY：stdout/stdin 的 isTTY、终端行列与 setRawMode，供起真 TUI 的测试用；restore 还原 */
export function fakeTty(rows: number, columns: number): { restore(): void } {
  const prev = {
    out: process.stdout.isTTY,
    in: process.stdin.isTTY,
    rows: process.stdout.rows,
    columns: process.stdout.columns,
  };
  const stdin = process.stdin as unknown as { setRawMode?: (v: boolean) => unknown };
  const hadRawMode = typeof stdin.setRawMode === 'function';
  if (!hadRawMode) stdin.setRawMode = () => stdin;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  return {
    restore() {
      if (!hadRawMode) delete stdin.setRawMode;
      Object.defineProperty(process.stdout, 'isTTY', { value: prev.out, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: prev.in, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: prev.rows, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: prev.columns, configurable: true });
    },
  };
}
