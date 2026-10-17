import { useState } from 'react';
import { useToast } from '../components/Toast';
import { tr } from '../language';
import { isRecord } from '../rest';
import { useHost, usePlugins } from './list';

// 插件的管理动作（启停、重载、实例增删、装卸）：同一时刻只做一个，出错用 Toast 报；市场的装卸以 HTTP 200 回
// { ok: false, message } 表示没成，同样报。做完等最新的插件列表取回，成功时之后再交给 then（要跳去的实例这时已在列表里）。
// 正在做的按动作的 id 认（按钮按它判断转不转圈），名字只用来写出错的 Toast。
// 出错的 Toast 链到这个插件的日志（插件详情里），没给插件时链到提供界面的实例的日志（扫描、新建实例）；
// 一次动作的来源另有其人时由 run 指定：在别的实例的详情里移除、启用依赖链上的根插件，以及装卸（记在包管理的日志里）

/** 回执里的说明 */
export const messageOf = (reply: unknown) =>
  isRecord(reply) && typeof reply.message === 'string' ? reply.message : undefined;

export interface PluginAction {
  /** 正在做的动作的 id */
  busy?: string;
  /** id 认是哪个动作，label 是它的名字 */
  run(
    id: string,
    label: string,
    call: () => Promise<unknown>,
    then?: (reply: unknown) => void,
    source?: string,
  ): Promise<void>;
}

export function usePluginAction(plugin?: string): PluginAction {
  const { refresh } = usePlugins();
  const host = useHost();
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  const run = async (
    id: string,
    label: string,
    call: () => Promise<unknown>,
    then?: (reply: unknown) => void,
    source = plugin ?? host,
  ) => {
    setBusy(id);
    let done: { reply: unknown } | undefined;
    try {
      const reply = await call();
      if (isRecord(reply) && reply.ok === false) {
        throw new Error(typeof reply.message === 'string' ? reply.message : tr('actionNotSucceeded'));
      }
      done = { reply };
    } catch (err) {
      toast({ kind: 'danger', text: tr('actionFailed', { action: label, error: (err as Error).message }), source });
    }
    await refresh();
    setBusy(undefined);
    if (done) then?.(done.reply);
  };
  return { busy, run };
}
