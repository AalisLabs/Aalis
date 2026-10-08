import type { SettingLayer } from '@aalis/api-session-protocol';
import { useCallback, useId, useMemo, useState } from 'react';
import { Select } from '../components/Select';
import { useConnection } from '../connection';
import type { SessionClient } from '../protocol/session-client';
import { SessionsFetchError } from '../shell/SessionGate';
import { SettingRows } from './SettingRows';
import { useSessionQuery, useSettingRows } from './setting-rows';

// 设置的「会话默认」：顶部选层（全局默认、各平台档、平台档下的群与私聊），下面是这一层的设置项，行与会话的「设置」标签
// 同一套。可以选的层由会话服务给出（已装适配器的平台加配置里写过的），插件启停与设置变了时重取；选中的层没了回到全局默认，
// 那一层之后再出现也不自己切回去

const DEFAULTS: SettingLayer = { scope: 'defaults' };

const ORDER =
  '会话设置按本会话、父会话、受众、平台档、全局默认的先后，取第一个设了值的一层；哪一层都没设时按各项自己的默认。' +
  '改动从下一轮起生效。';
const AUDIENCES = { group: '群', private: '私聊' } as const;

/** 层的标识：选择框的值，也用来比较两个层是不是同一个 */
const keyOf = (layer: SettingLayer): string =>
  JSON.stringify(
    layer.scope === 'defaults'
      ? { scope: layer.scope }
      : layer.scope === 'platform'
        ? { scope: layer.scope, platform: layer.platform }
        : { scope: layer.scope, platform: layer.platform, audience: layer.audience },
  );

const labelOf = (layer: SettingLayer): string =>
  layer.scope === 'defaults'
    ? '全局默认'
    : layer.scope === 'platform'
      ? `平台档：${layer.platform}`
      : `平台档：${layer.platform} · ${AUDIENCES[layer.audience]}`;

const requestLayers = async (client: SessionClient) => (await client.request('session/config/layers', {})).layers;

/** 可以选的层：照会话设置的重取时机，插件启停时也重取 */
function useLayers() {
  const { admin } = useConnection();
  const more = useCallback((load: () => void) => [admin.on('plugins.changed', load)], [admin]);
  return useSessionQuery(requestLayers, more);
}

export function SessionDefaults() {
  const pickerId = useId();
  const { value: layers, error: layersError, retry: retryLayers } = useLayers();
  const [chosen, setChosen] = useState(keyOf(DEFAULTS));
  if (layers && !layers.some(layer => keyOf(layer) === chosen)) setChosen(keyOf(DEFAULTS));
  const target = useMemo(() => ({ layer: JSON.parse(chosen) as SettingLayer }), [chosen]);
  const { rows, error, update, retry } = useSettingRows(target);
  const problem = layersError ?? error;

  return (
    <div className="page-screen settings-screen">
      <div className="settings-head">
        <p className="settings-note">{ORDER}</p>
        <div className="settings-field">
          <label htmlFor={pickerId}>层</label>
          <Select
            id={pickerId}
            value={chosen}
            options={(layers ?? [DEFAULTS]).map(layer => ({ value: keyOf(layer), label: labelOf(layer) }))}
            onChange={setChosen}
          />
        </div>
        {target.layer.scope !== 'defaults' && <p className="settings-note">平台档按平台名生效，不区分实例。</p>}
      </div>
      {problem && (
        <SessionsFetchError
          what="会话默认"
          error={problem}
          retry={() => {
            retryLayers();
            retry();
          }}
        />
      )}
      {rows && (
        <div className="settings-rows">
          {rows.length === 0 ? (
            <p className="settings-note">这一层没有可以设置的项</p>
          ) : (
            <SettingRows rows={rows} update={update} />
          )}
        </div>
      )}
    </div>
  );
}
