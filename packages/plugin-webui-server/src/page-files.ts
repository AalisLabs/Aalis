// ============================================================
// page-files.ts — 页面单元格里的文件句柄
//
// 文件单元格的值是存储地址，下发给界面之前换成本插件签发的句柄，界面凭句柄经 GET /api/page-file 下载，不开按存储地址任意读取的路由。
// 句柄是「载荷.签名」两段 base64url：载荷是存储地址与文件名，签名是密钥对载荷的 HMAC-SHA256。用签名而不用服务端的表：
// 页面重新取数多少次，内存都不随之增长。密钥每次激活随机生成，本插件重载后旧句柄失效，界面重新取数就拿到新的。
// 签不签发与会话条目的句柄同一条规则（api-storage 的 canIssueFileHandle）。会话条目的句柄由会话服务签发、绑定会话；
// 页面的文件不属于哪个会话，会话服务也可能没启用，所以由本插件另设签发器。
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { canIssueFileHandle, type StorageRootInfo } from '@aalis/api-storage';

/** roots 现取存储服务的根表：签发时按地址的根名查它的种类 */
export function createPageFiles(roots: () => StorageRootInfo[]) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const signature = (payload: string) => createHmac('sha256', key).update(payload).digest();

  return {
    /** 签发句柄；不是存储地址、根不认识或在不签发的根里时回 undefined */
    sign(uri: string, name: string): string | undefined {
      if (!canIssueFileHandle(roots(), uri)) return undefined;
      const payload = Buffer.from(JSON.stringify([uri, name])).toString('base64url');
      return `${payload}.${signature(payload).toString('base64url')}`;
    },

    /** 核验句柄：是本插件这次激活签发的，回存储地址与文件名，否则回 undefined */
    resolve(handle: string): { uri: string; name: string } | undefined {
      const parts = /^([\w-]+)\.([\w-]+)$/.exec(handle);
      if (!parts) return undefined;
      const [, payload, given] = parts;
      const expected = signature(payload);
      const actual = Buffer.from(given, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      const [uri, name] = JSON.parse(Buffer.from(payload, 'base64url').toString()) as [string, string];
      return { uri, name };
    },
  };
}

export type PageFiles = ReturnType<typeof createPageFiles>;
