import { useState } from 'react';
import { useToast } from '../components/Toast';
import { isRecord } from '../rest';
import { usePlugins } from './list';

// 插件的管理动作（启停、重载、实例增删、装卸）：同一时刻只做一个，出错用 Toast 报；市场的装卸以 HTTP 200 回
// { ok: false, message } 表示没成，同样报。做完等最新的插件列表取回，成功时之后再交给 then（要跳去的实例这时已在列表里）

/** 回执里的说明 */
export const messageOf = (reply: unknown) =>
  isRecord(reply) && typeof reply.message === 'string' ? reply.message : undefined;

export interface PluginAction {
  /** 正在做的动作 */
  busy?: string;
  run(label: string, call: () => Promise<unknown>, then?: (reply: unknown) => void): Promise<void>;
}

export function usePluginAction(): PluginAction {
  const { refresh } = usePlugins();
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const run = async (label: string, call: () => Promise<unknown>, then?: (reply: unknown) => void) => {
    setBusy(label);
    let done: { reply: unknown } | undefined;
    try {
      const reply = await call();
      if (isRecord(reply) && reply.ok === false) {
        throw new Error(typeof reply.message === 'string' ? reply.message : '没有成功');
      }
      done = { reply };
    } catch (err) {
      toast({ kind: 'danger', text: `${label}失败：${(err as Error).message}` });
    }
    await refresh();
    setBusy(undefined);
    if (done) then?.(done.reply);
  };
  return { busy, run };
}
