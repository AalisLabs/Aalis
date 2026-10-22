import type { SessionMethodResult, SettingLayer } from '@aalis/api-session-protocol';
import type { Localized } from '@aalis/schema-i18n';
import { useCallback } from 'react';
import { useConnection, useFeatures } from '../connection';
import { tr } from '../language';
import type { SessionClient } from '../protocol/session-client';
import { paths } from '../routes';
import { useSessionQuery } from './setting-rows';

// 会话设置的层：可以设的各层（各带称呼）与层表（全部层的名字与称呼，按先后）都取自 session/config/layers，前端不另存一份。
// 来源文字、先后说明、选层与「另有 N 处设置」的称呼都按层表写；层在地址里的写法也在这里

export type LayerOrder = Localized<SessionMethodResult<'session/config/layers'>>['order'];
export type LayerInfo = Localized<SessionMethodResult<'session/config/layers'>>['layers'][number];

const requestLayers = (client: SessionClient) => client.request('session/config/layers', {});

/** 可以设的各层与层表：照会话设置的重取时机，插件启停时也重取；会话设置服务不在、调用方用不着（wanted 为假）时不取 */
export function useLayers(wanted = true) {
  const { admin } = useConnection();
  const { settings } = useFeatures();
  const more = useCallback((load: () => void) => [admin.on('plugins.changed', load)], [admin]);
  return useSessionQuery(settings && wanted ? requestLayers : undefined, more);
}

/** 层的称呼；层表里没有这个名字时写层名 */
export const labelOf = (order: LayerOrder, name: string) => order.find(entry => entry.name === name)?.label ?? name;

/**
 * 一层的称呼：层表里的称呼，后面写这一层取的是哪一份，如「平台档 onebot」「平台类型档 onebot · group」；
 * 场所写场所的称呼（label，没有时是场所键）与层名，如「群「读书会」onebot（场所）」
 */
export function layerTitle(order: LayerOrder, layer: SettingLayer, label?: string): string {
  const name = labelOf(order, layer.scope);
  switch (layer.scope) {
    case 'global':
      return name;
    case 'platform':
      return tr('layerDetail', { layer: name, detail: layer.platform });
    case 'platformType':
      return tr('layerDetail', { layer: name, detail: `${layer.platform} · ${layer.type}` });
    case 'place':
      return tr('placeLayer', { place: label ?? layer.key, layer: name });
  }
}

/** 层在地址里的写法（设置的「会话默认」的 ?layer=）：层名，后面用 `:` 接这一层取的是哪一份；场所键可以带 `:`，放在最后 */
export function layerParam(layer: SettingLayer): string {
  switch (layer.scope) {
    case 'global':
      return layer.scope;
    case 'platform':
      return `${layer.scope}:${layer.platform}`;
    case 'platformType':
      return `${layer.scope}:${layer.platform}:${layer.type}`;
    case 'place':
      return `${layer.scope}:${layer.key}`;
  }
}

/** 设置的「会话默认」里这一层的地址 */
export const layerAddress = (layer: SettingLayer) =>
  `${paths.settingsSection('session-defaults')}?${new URLSearchParams({ layer: layerParam(layer) })}`;

/** 来源取的是哪一份：平台、聊天窗口的类型名，场所的称呼（如「群『读书会』」）；不知道的不写 */
export interface SourceContext {
  platform?: string;
  chatType?: string;
  placeName?: string;
}

/** 来源的称呼：层表里的称呼，平台档、平台类型档另写取的是哪一份，场所写场所的称呼，作者默认写「默认」 */
export function sourceTitle(order: LayerOrder, source: string, at: SourceContext = {}): string {
  if (source === 'default') return tr('sourceDefault');
  if (source === 'place' && at.placeName) return at.placeName;
  const name = labelOf(order, source);
  const detail =
    source === 'platform'
      ? at.platform
      : source === 'platformType' && at.platform && at.chatType
        ? `${at.platform} · ${at.chatType}`
        : undefined;
  return detail ? tr('layerDetail', { layer: name, detail }) : name;
}
