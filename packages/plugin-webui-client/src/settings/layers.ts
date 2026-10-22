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
 * 一层的标题：层表里的称呼，后面写这一层取的是哪一份（规则同 {@link sourceTitle}），如「平台档 onebot」「平台类型档 onebot · 群」
 * 「群「读书会」（场所）」。label 是层的列表给这一层的称呼（类型的显示名、场所的称呼），没有时写类型名、场所键
 */
export function layerTitle(order: LayerOrder, layer: SettingLayer, label?: string): string {
  return sourceTitle(order, layer.scope, {
    platform: 'platform' in layer ? layer.platform : undefined,
    chatType: layer.scope === 'platformType' ? (label ?? layer.type) : undefined,
    place: layer.scope === 'place' ? (label ?? layer.key) : undefined,
  });
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

/** 来源取的是哪一份：平台、聊天窗口的类型（显示名，见 {@link typeText}），场所的称呼（层的列表给的，如「群「读书会」」）；不知道的不写 */
export interface SourceContext {
  platform?: string;
  chatType?: string;
  place?: string;
}

/** 层的列表给这一层的称呼（平台类型档是类型的显示名，场所是场所的称呼）；列表里没有或没给时为 undefined */
export const labelIn = (layers: readonly LayerInfo[], layer: SettingLayer): string | undefined =>
  layers.find(info => layerParam(info.layer) === layerParam(layer))?.label;

/** 平台类型在称呼里的写法：层的列表里这个平台类型档带的显示名，没有时写类型名；不知道类型时为 undefined */
export function typeText(layers: readonly LayerInfo[], platform?: string, type?: string): string | undefined {
  if (type === undefined) return undefined;
  const info = layers.find(
    ({ layer }) => layer.scope === 'platformType' && layer.platform === platform && layer.type === type,
  );
  return info?.label ?? type;
}

/**
 * 来源的称呼（也是一层的标题）：层表里的称呼；平台档、平台类型档后面写取的是哪一份，场所写「<场所的称呼>（场所）」，不带平台；
 * 不知道是哪一份时只写层的称呼。作者默认写「默认」
 */
export function sourceTitle(order: LayerOrder, source: string, at: SourceContext = {}): string {
  if (source === 'default') return tr('sourceDefault');
  const name = labelOf(order, source);
  if (source === 'place') return at.place ? tr('placeLayer', { place: at.place, layer: name }) : name;
  const detail =
    source === 'platform'
      ? at.platform
      : source === 'platformType' && at.platform && at.chatType
        ? `${at.platform} · ${at.chatType}`
        : undefined;
  return detail ? tr('layerDetail', { layer: name, detail }) : name;
}
