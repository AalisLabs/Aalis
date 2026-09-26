// ============================================================
// 运行期自检：判定时发给侧车的 cur 与这条消息的归档正文比对
//
// 训练数据取自归档正文，cur 与归档用同一个 buildIncomingContent 拼，但判定时的消息未必已是归档时的样子：
// 附件识别超过宿主的 mediaWaitMs、文件描述要到 agent 预处理阶段才写入、中间件改写消息等。这里按
// 「会话 ID + 消息 ID」记下 cur 的哈希与长度（不存原文），归档后比对，按原因分桶计数，定期交出一行
// 只含计数的汇总。
// ============================================================

import type { IncomingMessage } from '@aalis/schema-message';

/** 判定时记下的 cur 摘要 */
interface CurDigest {
  length: number;
  hash: number;
  /** 判定时有非文件附件还没有描述（识别超过宿主的 mediaWaitMs，或宿主已放弃本次判定） */
  missingDescriptions: boolean;
  /** 带文件附件：文件描述由 plugin-file-reader 在 agent 预处理阶段才写入 */
  hasFile: boolean;
}

type Bucket = 'match' | 'missingDescriptions' | 'file' | 'other' | 'unarchived';

/**
 * 53 位非密码学哈希（cyrb53）：只用来判断两段文本是否逐字相同，配合长度，把不同文本误判为一致的概率可以忽略。
 * 同步计算（Web Crypto 的 digest 是异步的），记下与比对都在调用当拍完成
 */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * 表最多 capacity 条，超出时按记下的先后淘汰最早的，淘汰的都是还没归档的（归档即取出），计入「未归档」。
 * 每结清 reportEvery 条（比对或淘汰）交出一行自激活起的累计计数。
 */
export function createSelfCheck(report: (line: string) => void, capacity = 1000, reportEvery = 200) {
  const pending = new Map<string, CurDigest>();
  const counts: Record<Bucket, number> = { match: 0, missingDescriptions: 0, file: 0, other: 0, unarchived: 0 };
  let settled = 0;

  function tally(bucket: Bucket): void {
    counts[bucket]++;
    settled++;
    if (settled % reportEvery !== 0) return;
    report(
      `[laya] 自检 | 一致=${counts.match} | 不一致:缺附件描述=${counts.missingDescriptions} | ` +
        `不一致:含文件附件=${counts.file} | 不一致:其它=${counts.other} | 未归档=${counts.unarchived}`,
    );
  }

  return {
    /** 向侧车发请求前记下 cur；没有消息 ID 的消息无从与归档对上，不记 */
    record(message: IncomingMessage, cur: string): void {
      if (!message.messageId) return;
      const attachments = message.attachments ?? [];
      const descs = message._attachmentDescriptions;
      pending.set(`${message.sessionId}:${message.messageId}`, {
        length: cur.length,
        hash: hash53(cur),
        missingDescriptions: attachments.some((a, i) => a.kind !== 'file' && !descs?.[i]?.trim()),
        hasFile: attachments.some(a => a.kind === 'file'),
      });
      if (pending.size > capacity) {
        const oldest = pending.keys().next().value as string;
        pending.delete(oldest);
        tally('unarchived');
      }
    },

    /** 消息归档后比对，取出即删；没记过的键（作用域外、没发请求、已淘汰）不计 */
    settle(sessionId: string, messageId: string | undefined, archived: string): void {
      if (!messageId) return;
      const key = `${sessionId}:${messageId}`;
      const d = pending.get(key);
      if (!d) return;
      pending.delete(key);
      // 两个原因都成立时计入缺附件描述：两者都是往末尾追加描述，分不开
      if (archived.length === d.length && hash53(archived) === d.hash) tally('match');
      else if (d.missingDescriptions) tally('missingDescriptions');
      else if (d.hasFile) tally('file');
      else tally('other');
    },
  };
}
