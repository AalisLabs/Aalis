// 插件前端的助手，托管为 /frames/_base/frame.js。片段里的 nonce 原样读出、不清：清片段会往会话历史里加条目，
// nonce 对框架自己本来也不保密。同一页上的框架都是不透明来源、能互相发窗口消息，但只有父文档发得出来源是
// window.parent 的消息，所以只认来自它、带端口的第一个 init，之后只用这个端口。主题令牌、这个插件的字典与 <html lang>
// 在收到 init 的同一拍写上，框架显示出来时已是宿主的配色与语言。导入的 schema-i18n 构建时换成随本包带的那一份
// （/frames/_base/schema-i18n/，见 build.mjs）

import type {
  FrameClient,
  FrameHello,
  FrameHostMessage,
  FrameInit,
  FrameMessage,
  FrameRequest,
  FrameSessionsChanged,
  FrameTheme,
  PackedText,
} from '@aalis/api-webui';
import {
  fingerprint,
  normalizeLanguages,
  pickLanguage,
  registerCatalogEntry,
  resolveSource,
  resolveText,
} from '@aalis/schema-i18n';

/** 与 api-webui 的 FRAME_PROTOCOL_VERSION 同值：助手随 api-webui 同版本发布 */
const PROTOCOL = '1.1';
/** 发出 hello 之后等 init 的时长 */
const INIT_TIMEOUT_MS = 10_000;

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

function applyTheme({ kind, tokens }: FrameTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.dataset.theme = kind;
  root.style.colorScheme = kind;
}

/** 宿主给的服务进程时区：认不出的（不按协议的宿主）当作没给，免得插件拿去格式化时抛错 */
function zoneOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

/**
 * 语言包给这个插件补的译文：只认 language、text、from 都是字符串的条目，形状不对的丢掉，与宿主一侧同一读法。按协议的宿主
 * 交来的已经筛过；不按协议的宿主交来坏条目时，握手照样完成，t() 也不因它抛错
 */
function packed(packs: unknown): Record<string, PackedText[]> {
  if (typeof packs !== 'object' || packs === null) return {};
  return Object.fromEntries(
    Object.entries(packs).map(([key, candidates]) => [
      key,
      (Array.isArray(candidates) ? candidates : []).filter(
        (candidate): candidate is PackedText =>
          typeof candidate?.language === 'string' &&
          typeof candidate.text === 'string' &&
          typeof candidate.from === 'string',
      ),
    ]),
  );
}

/**
 * 登记这个插件的字典，按字典实际选中的语言设 <html lang>（原文、字典自带的译文与原文指纹相符的语言包补充里，按语言链选），
 * 回这个语言与 t()。次版本更早的宿主不给这几项，插件也可以没有字典：这时 t() 回键名，lang 不动，语言为 undefined
 */
function translator(
  { languages, texts, packs }: Partial<FrameInit>,
  timeZone: string | undefined,
): Pick<FrameClient, 'language' | 't'> {
  if (!texts || !registerCatalogEntry(texts)) return { t: key => key };
  const chain = Array.isArray(languages) ? languages : [];
  const supplied = packed(packs);
  // 标签按规范写法比与写（目录里登记的也是规范写法），不照抄宿主给的大小写
  const tags = [texts.language, ...Object.keys(texts.locales)];
  for (const [key, candidates] of Object.entries(supplied)) {
    const from = Object.hasOwn(texts.source, key) ? fingerprint(texts.source[key]) : undefined;
    for (const { language, from: given } of candidates) if (given === from) tags.push(language);
  }
  const offered = normalizeLanguages(tags);
  const language = offered[chain.length > 0 ? (pickLanguage(chain, offered) ?? 0) : 0];
  document.documentElement.lang = language;
  const options = { packs: new Map([[texts.ns, new Map(Object.entries(supplied))]]), timeZone };
  return {
    language,
    t: (key, params) => {
      const ref = { i18n: texts.ns, key, ...(params && { params }), source: key };
      return chain.length > 0 ? resolveText(ref, chain, options) : resolveSource(ref, options);
    },
  };
}

function connected(
  port: MessagePort,
  given: Pick<FrameClient, 'sessionId' | 'timeZone' | 'language' | 't'>,
): FrameClient {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const invalidated = new Set<(source?: string) => void>();
  const changed = new Set<(change: Omit<FrameSessionsChanged, 'type'>) => void>();
  let lastId = 0;

  const send = (message: FrameMessage) => port.postMessage(message);
  function request(message: Unsent<FrameRequest>): Promise<unknown> {
    lastId += 1;
    const id = lastId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ ...message, id });
    });
  }
  function listen<T>(listeners: Set<T>, listener: T): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  port.onmessage = ({ data }: MessageEvent<FrameHostMessage>) => {
    if (data.type === 'result') {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) waiting?.resolve(data.value);
      else waiting?.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
    } else if (data.type === 'theme') {
      applyTheme(data);
    } else if (data.type === 'invalidate') {
      for (const listener of invalidated) listener(data.source);
    } else if (data.type === 'sessions.changed') {
      for (const listener of changed) listener({ upserts: data.upserts, removes: data.removes });
    }
  };
  addEventListener('pagehide', () => send({ type: 'leaving' }));

  return {
    ...given,
    data: (source, input) => request({ type: 'data', source, ...(input && { input }) }),
    action: (action, input) => request({ type: 'action', action, ...(input && { input }) }) as Promise<string | null>,
    open: async target => {
      await request({ type: 'open', target });
    },
    onInvalidate: listener => listen(invalidated, listener),
    listSessions: params => request({ type: 'sessions.list', ...params }) as ReturnType<FrameClient['listSessions']>,
    onSessionsChanged: listener => listen(changed, listener),
    abortTurn: async params => {
      await request({ type: 'turn.abort', ...params });
    },
  };
}

function handshake(): Promise<FrameClient> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeEventListener('message', onInit);
      reject(new Error('宿主没有回应握手'));
    }, INIT_TIMEOUT_MS);
    function onInit(event: MessageEvent): void {
      if (event.source !== parent || event.ports.length !== 1 || event.data?.type !== 'init') return;
      removeEventListener('message', onInit);
      clearTimeout(timer);
      const { theme, sessionId, timeZone } = event.data;
      if (typeof theme?.tokens !== 'object' || theme.tokens === null) {
        reject(new Error('宿主的 init 不合格：theme 要是带 tokens 的对象'));
        return;
      }
      applyTheme(theme);
      const zone = zoneOf(timeZone);
      resolve(connected(event.ports[0], { sessionId, timeZone: zone, ...translator(event.data, zone) }));
    }
    addEventListener('message', onInit);
    const hello: FrameHello = { type: 'hello', protocol: PROTOCOL, nonce: location.hash.slice(1) };
    parent.postMessage(hello, '*');
  });
}

let connection: Promise<FrameClient> | undefined;

/** 与宿主握手，拿到这一页的连接；调多次是同一个连接 */
export function connect(): Promise<FrameClient> {
  connection ??= handshake();
  return connection;
}
