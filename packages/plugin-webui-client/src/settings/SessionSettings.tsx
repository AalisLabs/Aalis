import type { SettingLayer } from '@aalis/api-session-protocol';
import { useId, useState } from 'react';
import { Select } from '../components/Select';
import { useSessionClient } from '../connection';
import { tr } from '../language';
import type { SessionSummary } from '../protocol/session-client';
import { SessionsFetchError } from '../shell/SessionGate';
import type { Row } from './field';
import {
  type LayerInfo,
  type LayerOrder,
  labelIn,
  labelOf,
  type SourceContext,
  sourceTitle,
  typeText,
  useLayers,
} from './layers';
import { SettingRows } from './SettingRows';
import type { useSettingRows } from './setting-rows';

// 会话的「设置」标签：这个会话适用的各行，每项写当前值与「来自：…」。在哪用就在哪改：顶部选改动写到哪一层——只这个会话、
// 根会话的场所（这个工作区、这个群、这个私聊；根会话没有场所层时没有）、全局（插件配置）；平台档与平台类型档只在设置的「会话默认」
// 里改。子会话的各项在建立时写在它自己那一层，改到场所或全局对它不起作用，只能改这个会话。生效值出自比所选更窄的层时，那一行写
// 「这里还被<层>覆盖」。写进场所与全局之后，会话服务推 session/config/changed，这里的行随之重取。层表没取到时设置行照常列出，
// 来源按层名写

/** 选场所时的称呼：工作区，窗口按多方标记分群与私聊 */
function placeScope(summary: SessionSummary): string {
  if (summary.place?.kind === 'workspace') return tr('scopeWorkspace');
  return summary.chat?.multiParty ? tr('scopeGroup') : tr('scopePrivate');
}

/** 这个会话取的是哪一份：平台档按会话服务给的平台，聊天窗口的类型写显示名，场所写层的列表里的称呼 */
const contextOf = (
  summary: SessionSummary | undefined,
  layers: readonly LayerInfo[],
  platform: string | undefined,
): SourceContext => ({
  platform,
  chatType: typeText(layers, platform, summary?.chat?.type),
  place: summary?.place && labelIn(layers, { scope: 'place', key: summary.place.key }),
});

/** 层在层表里的先后：后面的压过前面的 */
const rankOf = (order: LayerOrder, name: string) => order.findIndex(entry => entry.name === name);

interface Scope {
  /** 层名 */
  name: string;
  label: string;
  /** 会话之上的层；只这个会话的没有，写的是会话自己这一层 */
  layer?: SettingLayer;
}

/** 可以选的范围：只这个会话、根会话的场所（有场所层才有）、全局（插件配置）；子会话只有只这个会话 */
function scopesOf(summary: SessionSummary | undefined, order: LayerOrder): Scope[] {
  const session = { name: 'session', label: tr('scopeSession') };
  if (!summary || summary.parentId) return [session];
  const global: Scope = { name: 'global', label: labelOf(order, 'global'), layer: { scope: 'global' } };
  if (!summary.place) return [session, global];
  return [
    session,
    { name: 'place', label: placeScope(summary), layer: { scope: 'place', key: summary.place.key } },
    global,
  ];
}

export function SessionSettings({
  summary,
  settings,
}: {
  summary?: SessionSummary;
  settings: ReturnType<typeof useSettingRows>;
}) {
  const client = useSessionClient();
  const scopeId = useId();
  const layers = useLayers();
  const { rows, error, update, retry } = settings;
  const order = layers.value?.order ?? [];
  const scopes = scopesOf(summary, order);
  const [chosen, setChosen] = useState('session');
  const scope = scopes.find(each => each.name === chosen) ?? scopes[0];
  if (error) {
    return (
      <div className="session-panel-section">
        <SessionsFetchError what={tr('settings')} error={error} retry={retry} />
      </div>
    );
  }
  if (!rows || (!layers.value && !layers.error)) return null;
  if (rows.length === 0) return <p className="session-panel-note">{tr('sessionNoSettings')}</p>;
  const { layer } = scope;
  const at = contextOf(summary, layers.value?.layers ?? [], settings.platform);
  /** 「来自：…」；来源比所选的层更窄（压过它）时写这里还被它覆盖 */
  const sourceLine = (source: string) => {
    const where = sourceTitle(order, source, at);
    return rankOf(order, source) > rankOf(order, scope.name)
      ? tr('overriddenBy', { layer: where })
      : tr('originFrom', { layer: where });
  };
  const write = layer
    ? async (row: Row, value: unknown) =>
        (await client.request('session/config/layer/update', { layer, plugin: row.plugin, key: row.key, value }))
          .unsaved
    : update;
  return (
    <div className="session-panel-section">
      <p className="session-panel-note">{tr('nextTurnNote')}</p>
      {layers.error && (
        <p className="session-panel-note" role="alert">
          {tr('layerTableFailed', { error: layers.error.message })}
        </p>
      )}
      {scopes.length > 1 ? (
        <div className="settings-field">
          <label htmlFor={scopeId}>{tr('writeTo')}</label>
          <Select
            id={scopeId}
            value={scope.name}
            options={scopes.map(each => ({ value: each.name, label: each.label }))}
            onChange={setChosen}
          />
        </div>
      ) : (
        <p className="session-panel-note">{tr('writeToOnly', { scope: scope.label })}</p>
      )}
      <SettingRows rows={rows} layer={scope.name} originOf={sourceLine} update={write} />
    </div>
  );
}
