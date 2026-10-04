import type { AttentionItem } from '@aalis/api-webui';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer } from 'react';
import { useConnection } from '../connection';
import { isRecord, useJson } from '../rest';

// 「需要处理」：整页取一份，收到 attention.changed 或管理连接重连后重取。首页摘要、插件详情、运行状况与标签页标题都读它

interface Attention {
  /** 没取到之前为 undefined；重取失败时留着上一次的 */
  items?: readonly AttentionItem[];
  error?: Error;
  retry(): void;
}

const Context = createContext<Attention | undefined>(undefined);

export function useAttention(): Attention {
  const attention = useContext(Context);
  if (!attention) throw new Error('只能在 AttentionProvider 里取「需要处理」');
  return attention;
}

function parse(body: unknown): AttentionItem[] {
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('「需要处理」的回应不是预期的形状');
  return body.items as AttentionItem[];
}

export function AttentionProvider({ children }: { children: ReactNode }) {
  const { admin } = useConnection();
  const [version, reload] = useReducer((n: number) => n + 1, 0);
  const { value, error } = useJson('/api/attention', parse, version);

  useEffect(() => {
    const offs = [admin.on('attention.changed', reload), admin.onReconnect(reload)];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);

  const attention = useMemo<Attention>(() => ({ items: value, error, retry: reload }), [value, error]);
  return <Context.Provider value={attention}>{children}</Context.Provider>;
}
