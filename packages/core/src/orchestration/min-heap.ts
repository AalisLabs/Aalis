// ============================================================
// min-heap.ts — 整数小顶堆
//
// 编排里两处 Kahn 排序共用，取就绪项里编号最小的：激活次序按登记序，关闭次序按阶段的自然次序。
// 不变量：对每个下标 i > 0，heap[(i - 1) >> 1] <= heap[i]；于是 heap[0] 是最小的。
// ============================================================

/** 放进一个数：从末尾沿父链上移，直到父不大于它 */
export function heapPush(heap: number[], value: number): void {
  let at = heap.length;
  heap.push(value);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (heap[parent] <= value) break;
    heap[at] = heap[parent];
    at = parent;
  }
  heap[at] = value;
}

/** 取出最小的数（堆不得为空）：末尾那个补到堆顶，沿较小的孩子下移，直到两个孩子都不小于它 */
export function heapPop(heap: number[]): number {
  const top = heap[0];
  const last = heap.pop()!;
  const size = heap.length;
  if (size === 0) return top;
  let at = 0;
  for (let child = 2 * at + 1; child < size; child = 2 * at + 1) {
    if (child + 1 < size && heap[child + 1] < heap[child]) child++;
    if (heap[child] >= last) break;
    heap[at] = heap[child];
    at = child;
  }
  heap[at] = last;
  return top;
}
