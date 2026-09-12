/**
 * 聊天区行缓冲：扁平行数组 + 流式块起点下标。
 *
 * 不变量：流式进行中时，流式块永远是 lines 的最后一段。
 * 流式回复靠绝对下标记位置、每个 delta 整块重建，因此任何会移动下标的操作
 * （裁头、流式期间插入历史行）都必须同步维护下标，否则重建会把下标错位处的
 * 旧行当成流式块重画（叠出阶梯副本），或把追加在块后的行抹掉。
 */
export class ChatBuffer {
  readonly lines: string[] = [];
  private streamingStart: number | null = null;

  constructor(private readonly max = 300) {}

  get streaming(): boolean {
    return this.streamingStart !== null;
  }

  /** 追加历史行（欢迎语 / 整段 assistant 回复 / 用户输入回显）；流式进行中时插到流式块之前 */
  append(incoming: string[]): void {
    if (this.streamingStart === null) {
      this.lines.push(...incoming);
    } else {
      this.lines.splice(this.streamingStart, 0, ...incoming);
      this.streamingStart += incoming.length;
    }
    this.trim();
  }

  /** 用重建后的整块内容覆写流式块；首次调用即开块（块占据 lines 末尾） */
  replaceStreamingBlock(block: string[]): void {
    if (this.streamingStart === null) this.streamingStart = this.lines.length;
    this.lines.splice(this.streamingStart, this.lines.length - this.streamingStart, ...block);
    this.trim();
  }

  /** 结束本轮流式；此后追加重新落到末尾 */
  endStreaming(): void {
    this.streamingStart = null;
  }

  /** 只裁头。流式块下标随裁掉的行数左移；裁进块内则归 0——此时剩余整段都属于该块，下个 delta 会整体重建 */
  private trim(): void {
    if (this.lines.length <= this.max) return;
    const removed = this.lines.length - this.max;
    this.lines.splice(0, removed);
    // 流式块自身超过上限时起点归零：此后流式期间的追加会被同一次裁剪吃掉（扁平模型的固有代价）
    if (this.streamingStart !== null) this.streamingStart = Math.max(0, this.streamingStart - removed);
  }
}
