const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** 列表与表格里的时间：今天写时分，今年写月/日，更早写年/月/日 */
export function listTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  if (sameDay(date, today)) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}/${day}`;
}

/** 时间线里的时刻：今天写时分，别的日子前面加上月/日（不是今年再加年） */
export function clockTime(at: number): string {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay(date, new Date()) ? time : `${listTime(at)} ${time}`;
}

/** 耗时：一分钟以内写到 0.1 秒，再长写分与秒 */
export function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** token 数：千以上写成 k，百万以上写成 M */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

/** 比例写成百分数，取整 */
export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
