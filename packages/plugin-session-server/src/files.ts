// ════════════════════════════════════════════════════════════
// 文件句柄：条目里她发出的文件不给存储地址，给本服务签发的句柄；传输层下发文件之前请这里核验。
//
// 句柄是「载荷.签名」两段 base64url：载荷是存储地址与文件名，签名是密钥对会话 id 与载荷的 HMAC-SHA256。
// 用签名而不用服务端的表：同一会话同一文件每次算出同一个句柄，历史翻多少遍都不必记下什么，内存不随之增长。
// 密钥每次启动随机生成、只在内存里，重启之后旧句柄一律失效：重启也换了 epoch，客户端本来就要重新订阅，拿到新句柄；
// 换来的是不必把密钥落盘。
// 插件状态与插件私有数据的根里的文件不签发：data 映射到家目录的 state/，里面有 WebUI 的 token 与审计。
// ════════════════════════════════════════════════════════════

// biome-ignore lint/style/noRestrictedImports: 条目在拼出的同一拍里带上句柄，推送按 seq 排序、历史按页同步归并，签名与核验都要同步；Web Crypto 的 HMAC 只有异步接口
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isStorageUri, parseUriRoot, type StorageRootInfo } from '@aalis/api-storage';

/** 不签发的存储根种类 */
const PRIVATE_KINDS: ReadonlySet<string> = new Set(['data', 'pluginData']);

/** roots 现取存储服务的根表：签发时按地址的根名查它的种类 */
export function createFileHandles(roots: () => StorageRootInfo[]) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const signature = (sessionId: string, payload: string) =>
    createHmac('sha256', key)
      .update(JSON.stringify([sessionId, payload]))
      .digest();

  return {
    /** 给这个会话里的一个文件签发句柄；不是存储地址、根不认识或在不签发的根里时回 undefined */
    sign(sessionId: string, uri: string, name: string): string | undefined {
      if (!isStorageUri(uri)) return undefined;
      const root = roots().find(r => r.name === parseUriRoot(uri));
      if (!root || PRIVATE_KINDS.has(root.kind)) return undefined;
      const payload = Buffer.from(JSON.stringify([uri, name])).toString('base64url');
      return `${payload}.${signature(sessionId, payload).toString('base64url')}`;
    },

    /** 核验句柄：是这次启动内为这个会话签发的，回存储地址与文件名，否则回 undefined */
    resolve(sessionId: string, handle: string): { uri: string; name: string } | undefined {
      const parts = /^([\w-]+)\.([\w-]+)$/.exec(handle);
      if (!parts) return undefined;
      const [, payload, given] = parts;
      const expected = signature(sessionId, payload);
      const actual = Buffer.from(given, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      const [uri, name] = JSON.parse(Buffer.from(payload, 'base64url').toString()) as [string, string];
      return { uri, name };
    },
  };
}
