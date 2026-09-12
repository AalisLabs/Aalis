/**
 * 终端确认的排队器。agent 同一轮会并行执行多个工具调用，其中不止一个可能需要确认；
 * 单槽位会让后到者覆盖先到者，先到的 Promise 永不结算、整轮挂死。这里按到达顺序逐个问、按序结算。
 */
export class ConfirmQueue {
  private readonly pending: Array<{ text: string; resolve: (ok: boolean) => void }> = [];

  get size(): number {
    return this.pending.length;
  }

  /** 当前正在问的文案；没有待确认时为 undefined */
  get current(): string | undefined {
    return this.pending[0]?.text;
  }

  ask(text: string): Promise<boolean> {
    return new Promise(resolve => {
      this.pending.push({ text, resolve });
    });
  }

  /** 结算队头；没有待确认时返回 false */
  answer(ok: boolean): boolean {
    const head = this.pending.shift();
    if (!head) return false;
    head.resolve(ok);
    return true;
  }

  /** 全部按同一结果结算（TUI 停止时按取消） */
  settleAll(ok = false): void {
    for (const item of this.pending.splice(0)) item.resolve(ok);
  }
}
