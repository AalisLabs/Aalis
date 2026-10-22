import type { SessionMethodResult } from '@aalis/api-session-protocol';
import type { Localized } from '@aalis/schema-i18n';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '../components/Badge';
import { Disclosure } from '../components/Disclosure';
import { useFeatures } from '../connection';
import { tr } from '../language';
import type { SessionClient } from '../protocol/session-client';
import { paths } from '../routes';
import { type Field, formatValue } from '../settings/field';
import { type LayerInfo, type LayerOrder, layerAddress, layerParam, layerTitle, useLayers } from '../settings/layers';
import { useSessionQuery } from '../settings/setting-rows';
import './session-marks.css';

// 插件详情里可按会话设置的项：名字旁标「可按会话设置」；全局之外另有设过的，再标「另有 N 处设置」，点开在这一项下面逐个
// 列出在哪（层、会话，子会话带父会话）与设成了什么，每处可点进设置的那一层或那个会话的「设置」标签。数据取自会话协议的
// session/config/overrides，设置变了（session/config/changed）重取。会话设置服务不在（功能位 settings 为假）时都不出现

type Overrides = Localized<SessionMethodResult<'session/config/overrides'>>;
export type Override = Overrides['items'][number]['entries'][number];

/** 一个实例的各项在全局之外写过的各处（项 → 各处），与写各处称呼要用的层表与层的列表 */
export interface SessionPlaces {
  overrides: ReadonlyMap<string, Override[]>;
  order: LayerOrder;
  layers: readonly LayerInfo[];
}

/** 取一个实例写过的各处；会话设置服务不在、这个实例没有带标记的项（wanted 为假）时没有 */
export function useSessionPlaces(plugin: string, wanted: boolean): SessionPlaces | undefined {
  const { settings } = useFeatures();
  const request = useMemo(
    () =>
      settings && wanted
        ? (client: SessionClient) => client.request('session/config/overrides', { plugin })
        : undefined,
    [settings, wanted, plugin],
  );
  const { value } = useSessionQuery(request);
  const layers = useLayers(wanted);
  return useMemo(
    () =>
      value && {
        overrides: new Map(value.items.map(item => [item.key, item.entries])),
        order: layers.value?.order ?? [],
        layers: layers.value?.layers ?? [],
      },
    [value, layers.value],
  );
}

/** 一处写在哪：层按层表的称呼，场所取层的列表里的称呼；会话写标题，子会话另写父会话 */
function whereOf(target: Override['target'], order: LayerOrder, layers: readonly LayerInfo[]): string {
  if ('layer' in target) {
    const key = layerParam(target.layer);
    return layerTitle(order, target.layer, layers.find(info => layerParam(info.layer) === key)?.label);
  }
  return target.parent
    ? tr('childEntry', { title: target.title, parent: target.parent.title })
    : tr('sessionEntry', { title: target.title });
}

const addressOf = (target: Override['target']) =>
  'layer' in target ? layerAddress(target.layer) : paths.session(target.sessionId, 'settings');

/**
 * 一项（字段名 key）的两个标记与展开的列表：badges 放在名字旁，list 放在这一项下面。不是可按会话设置的项、会话设置服务不在时
 * 两样都没有；写过的各处还没取到（places 没有）时只标可按会话设置
 */
export function useSessionMarks(
  field: Field,
  key: string,
  places: SessionPlaces | undefined,
): { badges?: ReactNode; list?: ReactNode } {
  const { settings } = useFeatures();
  const [open, setOpen] = useState(false);
  if (!settings || field.session === undefined) return {};
  const entries = places?.overrides.get(key);
  const count = entries?.length ?? 0;
  return {
    badges: (
      <>
        <Badge>{tr('sessionSettable')}</Badge>
        {count > 0 && (
          <Disclosure expanded={open} onToggle={() => setOpen(!open)}>
            {tr('otherPlaces', { count })}
          </Disclosure>
        )}
      </>
    ),
    list: open && count > 0 && (
      <ul className="session-marks" aria-label={tr('otherPlaces', { count })}>
        {entries?.map(entry => (
          <li key={JSON.stringify(entry.target)}>
            <Link to={addressOf(entry.target)}>{whereOf(entry.target, places?.order ?? [], places?.layers ?? [])}</Link>
            <span className="session-marks-value">{formatValue(field, entry.value)}</span>
          </li>
        ))}
      </ul>
    ),
  };
}
