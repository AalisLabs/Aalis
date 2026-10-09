import type { SessionMethodResult, SettingLayer } from '@aalis/api-session-protocol';
import { useCallback } from 'react';
import { useConnection } from '../connection';
import type { SessionClient } from '../protocol/session-client';
import { useSessionQuery } from './setting-rows';

// 会话设置的层：可以设的各层与层表（全部层的名字与称呼，按先后）都取自 session/config/layers，前端不另存一份。
// 来源文字、先后说明与选层的称呼都按层表写

export type LayerOrder = SessionMethodResult<'session/config/layers'>['order'];

const requestLayers = (client: SessionClient) => client.request('session/config/layers', {});

/** 可以设的各层与层表：照会话设置的重取时机，插件启停时也重取 */
export function useLayers() {
  const { admin } = useConnection();
  const more = useCallback((load: () => void) => [admin.on('plugins.changed', load)], [admin]);
  return useSessionQuery(requestLayers, more);
}

/** 层的称呼；层表里没有这个名字时写层名 */
export const labelOf = (order: LayerOrder, name: string) => order.find(entry => entry.name === name)?.label ?? name;

/** 一层的称呼：层表里的称呼，后面写这一层取的是哪一份（平台、类型名），如「平台档：onebot」「平台类型档：onebot · group」 */
export function layerLabel(order: LayerOrder, { scope, ...which }: SettingLayer): string {
  const detail = Object.values(which).join(' · ');
  return detail ? `${labelOf(order, scope)}：${detail}` : labelOf(order, scope);
}
