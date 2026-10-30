import { PAGE_LANGUAGE_ID, type PackedText, type PageLanguage } from '@aalis/api-webui';
import { catalogEntries, type PackIndex } from '@aalis/schema-i18n';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { useConnection } from './connection';
import { language, pageLanguage, setLanguage } from './language';
import { RETRY_DELAYS_MS } from './protocol/socket';
import { getJson, isRecord } from './rest';

// 界面的语言：首帧按服务端写进页面的语言块（全局层的语言链与服务进程的时区）画，不等往返；页面里没有这一块（直接打开
// /index.html、开发模式）时先按原文画，再取 GET /api/i18n/languages。语言链不空（i18n 在）时另取 /api/i18n/messages 里
// 语言包给前端自带的字典（外壳与随前端打包的库字典）补的译文。全局语言与语言包可能在别处改了：会话设置变了
// （session/config/changed，插件启停也推它）、会话连接重新握手时两样都重取，语言链、时区或补上的译文变了就换语言——重连会话
// 协议、重挂整个界面（缓存的数据随之重取，插件框架随之重挂），<html lang> 跟着改；头一次取到时换了也不重连，会话的数据本来
// 就是按服务端现在的语言取的。全局语言是 i18n 的插件配置：会话设置不在时从插件详情改它，管理连接推 plugins.changed，
// 同样重取。没取到、回应的形状不对时照现在的显示，按会话连接的退避（1、2、5、10 秒，之后每 30 秒）再取；
// 只是补充没取到时语言链与时区照换，补充先空着

const sameChain = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

/** 语言链与时区；形状不对时 undefined */
function parseLanguages(body: unknown): PageLanguage | undefined {
  if (!isRecord(body) || !Array.isArray(body.chain) || typeof body.timeZone !== 'string') return undefined;
  return { chain: body.chain.filter((tag): tag is string => typeof tag === 'string'), timeZone: body.timeZone };
}

/** 服务端写进页面的语言块；没有或认不出时 undefined */
function writtenLanguage(): PageLanguage | undefined {
  const block = document.getElementById(PAGE_LANGUAGE_ID)?.textContent;
  if (!block) return undefined;
  try {
    return parseLanguages(JSON.parse(block));
  } catch {
    return undefined;
  }
}

/** 语言包给一条补的译文，形状不对的丢掉（插件前端的字典里的补充同一读法） */
export const packedTexts = (candidates: unknown): PackedText[] =>
  (Array.isArray(candidates) ? candidates : []).filter(
    (candidate): candidate is PackedText =>
      isRecord(candidate) &&
      typeof candidate.language === 'string' &&
      typeof candidate.text === 'string' &&
      typeof candidate.from === 'string',
  );

/** 语言包的补充：ns → 键 → 各包给的译文 */
function parsePacks(body: unknown): PackIndex {
  const entries = isRecord(body) && isRecord(body.entries) ? body.entries : {};
  return new Map(
    Object.entries(entries).map(([ns, keys]) => [
      ns,
      new Map(Object.entries(isRecord(keys) ? keys : {}).map(([key, candidates]) => [key, packedTexts(candidates)])),
    ]),
  );
}

/** 语言包补充的内容：比较补充变没变，变了才重挂（补的译文界面上用不到时也会多重挂一次，补充很少变） */
const packsKey = (packs: PackIndex) => JSON.stringify([...packs].map(([ns, keys]) => [ns, [...keys]]));

/** 语言包的补充：链为空（i18n 不在）时不取；没取到时 undefined */
function fetchPacks(chain: readonly string[], signal: AbortSignal): Promise<PackIndex | undefined> {
  if (chain.length === 0) return Promise.resolve(new Map());
  const ns = catalogEntries().map(entry => entry.ns);
  return getJson(`/api/i18n/messages?${new URLSearchParams({ ns: ns.join(',') })}`, signal).then(
    parsePacks,
    () => undefined,
  );
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const { session, admin } = useConnection();
  // 首帧之前换上页面里写好的语言：子组件画的时候取的就是它
  const [written] = useState(() => {
    const found = writtenLanguage();
    if (found) setLanguage({ ...found, packs: new Map() });
    return found;
  });
  /** 第几次换语言 */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    document.documentElement.lang = pageLanguage();
    const controller = new AbortController();
    let latest = 0;
    /** 连着几次没取到 */
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 取到过语言：之后换语言才重连会话协议 */
    let settled = false;
    /** known 是已经知道的语言链与时区（页面里写好的），只取补充 */
    const load = async (known?: PageLanguage) => {
      const mine = ++latest;
      clearTimeout(timer);
      const { signal } = controller;
      const found = known ?? parseLanguages(await getJson('/api/i18n/languages', signal).catch(() => undefined));
      const packs = found && (await fetchPacks(found.chain, signal));
      if (signal.aborted || mine !== latest) return;
      if (found && packs) failures = 0;
      else timer = setTimeout(() => void load(), RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)]);
      if (!found) return;
      const now = language();
      const moved = !sameChain(found.chain, now.chain) || found.timeZone !== now.timeZone;
      const next = { ...found, packs: packs ?? (moved ? new Map() : now.packs) };
      const reconnect = settled;
      settled = true;
      if (!moved && packsKey(next.packs) === packsKey(now.packs)) return;
      setLanguage(next);
      document.documentElement.lang = pageLanguage();
      if (reconnect) session.reconnect();
      setGeneration(n => n + 1);
    };
    void load(written);
    const offs = [
      session.onReady(() => void load()),
      session.on('session/config/changed', () => void load()),
      admin.on('plugins.changed', () => void load()),
    ];
    return () => {
      controller.abort();
      clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [session, admin, written]);

  return <Fragment key={generation}>{children}</Fragment>;
}
