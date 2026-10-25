/**
 * 经一个临时的下载链接把文件交给浏览器：地址照原样，字节先做成对象地址。立即撤销对象地址时有的浏览器（WebKit）来不及
 * 开始下载：留一分钟
 */
export function download(source: string | Blob, name: string): void {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  if (typeof source !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
