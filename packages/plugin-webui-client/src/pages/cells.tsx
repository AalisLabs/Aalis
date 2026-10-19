import type { CellKind, CellValue, FileCell, StatusValue } from '@aalis/api-webui';
import type { Localized } from '@aalis/schema-i18n';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Picture } from '../components/Picture';
import { StatusText } from '../components/StatusText';
import { clockTime, fullTime, listText, numberText } from '../format';
import { tr } from '../language';
import { isRecord } from '../rest';

// 单元格按显示种类显示，键值组件的值同样走这里。插件给的文字一律当纯文本，数字按千位分组，表格里同一列的小数位对齐，数字、
// 真假与时间按界面的语言写，字符串数组按界面的语言连成一句；链接只认 http、https，新标签打开；图片只认宿主换好的 /api/media
// 地址，文件只认宿主签发的句柄，别的按文字或名字显示

const isStatus = (value: unknown): value is Localized<StatusValue> => isRecord(value) && typeof value.text === 'string';
const isFile = (value: unknown): value is FileCell => isRecord(value) && typeof value.name === 'string';

/** 带时区偏移（Z 或 ±HH:MM）的 ISO 日期时间：不带偏移的串 Date.parse 按浏览器的时区解析，换算到服务进程的时区就错位了 */
const ZONED_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** 时间值：毫秒时间戳或带时区偏移的 ISO 串；认不出时为 undefined，按文字显示 */
function timeOf(value: unknown): number | undefined {
  const at = typeof value === 'string' && ZONED_ISO.test(value) ? Date.parse(value) : value;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

/** 单元格写成一句：搜索与详情的标题用它。真假与数组按界面的语言写 */
export function cellText(value: Localized<CellValue> | FileCell): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return listText(value);
  if (isStatus(value)) return value.text;
  if (isFile(value)) return value.name;
  if (typeof value === 'boolean') return tr(value ? 'yes' : 'no');
  return String(value);
}

/** 排序用的值：时间按时刻，数字按大小，其余按文字；图片与文件不排序 */
export function sortValue(kind: CellKind | undefined, value: Localized<CellValue> | FileCell): string | number {
  if (kind === 'time' || kind === 'countdown') return timeOf(value) ?? 0;
  if (typeof value === 'number') return value;
  return cellText(value);
}

/** 小数位，最多算到 3 位：数字默认的格式最多显示 3 位 */
export const fractionDigits = (value: number) => Math.min(3, String(value).split('.')[1]?.length ?? 0);

/** 剩下的时间：一分钟内写秒，一小时内写分与秒，一天内写时与分，再长写天与时 */
function remaining(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return tr('countdownSeconds', { seconds });
  if (seconds < 3600) return tr('countdownMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  if (seconds < 86_400) {
    return tr('countdownHours', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
  }
  return tr('countdownDays', { days: Math.floor(seconds / 86_400), hours: Math.floor((seconds % 86_400) / 3600) });
}

/** 倒计时：只显示，到零写「已到时间」，不重取 */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= at) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [at]);
  const left = at - now;
  return <time dateTime={new Date(at).toISOString()}>{left > 0 ? remaining(left) : tr('countdownDue')}</time>;
}

/** 长文本：单行省略，点开看全文 */
function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className="page-long-text" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{text}</span>
    </button>
  );
}

/** 一个值按显示种类显示；label 是图片的替代文字（列名或键值的名称），digits 是数字至少写几位小数 */
export function Cell({
  kind = 'text',
  value,
  label,
  digits,
}: {
  kind?: CellKind;
  value: Localized<CellValue> | FileCell;
  label: string;
  digits?: number;
}) {
  if (value === undefined || value === null || value === '') return null;
  // 数组连成一句再显示：代码等宽，长文本可展开，别的种类按文字（几个网址连起来不是一个链接）；空数组连成空串，按空值
  if (Array.isArray(value)) {
    const shown = kind === 'code' || kind === 'long-text' ? kind : 'text';
    return <Cell kind={shown} value={cellText(value)} label={label} />;
  }
  if (kind === 'status' && isStatus(value)) return <StatusText state={value.state}>{value.text}</StatusText>;
  if (kind === 'file' && isFile(value)) {
    return value.handle ? (
      <a className="page-file" href={`/api/page-file?${new URLSearchParams({ handle: value.handle })}`} download>
        <Download aria-hidden />
        {value.name}
      </a>
    ) : (
      value.name
    );
  }
  const text = cellText(value);
  const at = kind === 'time' || kind === 'countdown' ? timeOf(value) : undefined;
  if (kind === 'time' && at !== undefined) {
    return (
      <time dateTime={new Date(at).toISOString()} title={fullTime(at)}>
        {clockTime(at)}
      </time>
    );
  }
  if (kind === 'countdown' && at !== undefined) return <Countdown at={at} />;
  if (kind === 'link' && /^https?:\/\//i.test(text)) {
    return (
      <a href={text} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    );
  }
  if (kind === 'image' && text.startsWith('/api/media?')) {
    return <Picture className="page-image" src={text} alt={label} />;
  }
  if (kind === 'code') return <code>{text}</code>;
  if (kind === 'long-text') return <LongText text={text} />;
  return typeof value === 'number' ? numberText(value, digits) : text;
}
