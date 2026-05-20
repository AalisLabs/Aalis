/**
 * 聊天时间戳格式化：
 * - 今天：`HH:mm`
 * - 同年不同天：`M-D HH:mm`
 * - 跨年：`YYYY-M-D HH:mm`
 *
 * 接受 ms 时间戳；非法输入返回空串。
 */
export function formatChatTime(ts: number | undefined | null): string {
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  if (sameYear) return md;
  return `${d.getFullYear()}-${md}`;
}
