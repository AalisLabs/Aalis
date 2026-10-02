// 浏览器存储：界面偏好（栏的收起、外观的选择）只经这里读写，存在本浏览器，值是 JSON。
// 隐私模式与部分封装会禁用存储，读写失败一律按没存过处理，页面照常可用。
// 键都加前缀 aalis.；首帧主题脚本（public/theme.js）在打包的脚本之前执行，直接读 aalis.appearance。

const PREFIX = 'aalis.';

/** 读出存过的值；没存过、存坏了、存储不可用时为 undefined。取出的值由调用方按形状校验 */
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存不了只是下次打开时不记得，这次照常生效
  }
}
