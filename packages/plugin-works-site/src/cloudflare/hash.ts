// ============================================================
// Direct Upload 的资产键。
//
// 服务器不核对上传内容与键、同一个键以第一次写入为准（实测）。wrangler 的键是 blake3(base64(内容) + 扩展名)
// 的前 32 个十六进制字符，谁都能预先算出：拿到过 token 的人可以抢先用这些键上传别的内容（包括墓碑、404 页、
// 模板这类内容固定的文件），换了 token 之后依然有效。这里改用带本机盐的 HMAC-SHA256，别人算不出我方将要
// 上传的键。服务器接受任意 32 位十六进制键是推论（它不核对内容，键只是索引），上线前在测试项目上核实。
//
// 盐是状态里的 assetSalt（32 字节随机数的十六进制），首次激活生成；丢了就重新生成，代价只是全部资产重传一次。
// 键与盐都不写日志、不进模型上下文。用全局 Web Crypto（仓库对 node:crypto 有 lint 限制，HMAC 它已覆盖）。
// ============================================================

const SALT_PATTERN = /^[0-9a-f]{64}$/;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** 新的本机盐：32 字节随机数的十六进制 */
export function newAssetSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * 资产键：HMAC-SHA256（密钥为盐，数据为扩展名、一个 `\0` 与内容）的前 32 个十六进制字符。
 * 扩展名不带点；同一内容换扩展名得到不同的键（Pages 按资产登记的 Content-Type 回应）。
 */
export async function assetKey(salt: string, ext: string, bytes: Uint8Array): Promise<string> {
  if (!SALT_PATTERN.test(salt)) throw new Error('资产键的盐格式不对（应为 64 位十六进制）');
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = Number.parseInt(salt.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const head = new TextEncoder().encode(ext);
  const data = new Uint8Array(head.byteLength + 1 + bytes.byteLength);
  data.set(head, 0);
  data.set(bytes, head.byteLength + 1);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, data))).slice(0, 32);
}
