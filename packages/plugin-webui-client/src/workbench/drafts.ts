import { useEffect, useState } from 'react';
import { isRecord } from '../rest';
import { readStored, writeStored } from '../storage';

// 输入框的草稿：按会话存在本浏览器（经存储模块），切会话、刷新后还在，发出去就清掉。存不了时只是下次打开不在，输入照常。
// 只记最近改过的 DRAFT_LIMIT 个会话，多了丢最早改的。首页的新会话记在空的 id 下

const KEY = 'drafts';
const DRAFT_LIMIT = 50;

/** 首页新会话的草稿 */
export const NEW_SESSION = '';

type Drafts = Record<string, { text: string; at: number }>;

function readDrafts(): Drafts {
  const stored = readStored(KEY);
  if (!isRecord(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored).filter(
      ([, draft]) => isRecord(draft) && typeof draft.text === 'string' && typeof draft.at === 'number',
    ),
  ) as Drafts;
}

/** 记下一个会话的草稿；空的删掉，没变的不动（打开不算改过） */
function writeDraft(sessionId: string, text: string): void {
  const drafts = readDrafts();
  if (text === '') {
    if (!Object.hasOwn(drafts, sessionId)) return;
    delete drafts[sessionId];
  } else if (drafts[sessionId]?.text === text) return;
  else drafts[sessionId] = { text, at: Date.now() };
  const kept = Object.entries(drafts)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, DRAFT_LIMIT);
  writeStored(KEY, Object.fromEntries(kept));
}

/**
 * 发出去了：存着的还是发出的这段时删掉，发送在途时接着打的字留着。在请求回来时调，不靠输入框还开着：在途时切走了会话，
 * 输入框已经关了
 */
export function clearSent(sessionId: string, sent: string): void {
  if (readDrafts()[sessionId]?.text.trim() === sent) writeDraft(sessionId, '');
}

/** 一个会话的草稿：打开时读出存着的，改了就记下 */
export function useDraft(sessionId: string) {
  const [text, setText] = useState(() => readDrafts()[sessionId]?.text ?? '');
  useEffect(() => writeDraft(sessionId, text), [sessionId, text]);
  return [text, setText] as const;
}
