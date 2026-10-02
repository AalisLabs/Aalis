// 媒体地址：条目附件与 Markdown 里的图片、音频、视频多半是存储地址（<根名>:/<路径>），浏览器经 /api/media 按地址取；
// 已经是 /api/media 的地址原样用。别的写法（网址、相对路径）都不算媒体地址，由调用方决定怎么显示

const STORAGE_URI = /^[A-Za-z][\w-]*:\/[^\0]*$/;
const WEB_URL = /^https?:\/\//i;

export const isWebUrl = (src: string) => WEB_URL.test(src);

export function mediaUrl(src: string): string | undefined {
  if (src.startsWith('/api/media?')) return src;
  if (STORAGE_URI.test(src) && !/^https?:/i.test(src)) return `/api/media?uri=${encodeURIComponent(src)}`;
  return undefined;
}
