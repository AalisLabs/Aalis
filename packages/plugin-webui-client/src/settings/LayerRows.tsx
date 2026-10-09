import type { SettingLayer } from '@aalis/api-session-protocol';
import { useMemo } from 'react';
import { SessionsFetchError } from '../shell/SessionGate';
import { type LayerOrder, labelOf } from './layers';
import { SettingRows } from './SettingRows';
import { useSettingRows } from './setting-rows';

/**
 * 会话之上一层的设置行（设置的「会话默认」、房间的「场所设置」）：与会话的「设置」标签同一套，改动写进这一层，来源按层表写
 * 称呼，这一层没写的项写它从哪一层继承来。取不到时写明原因、可以重试；what 是出错时写的「<哪里>没取到」。layer 要是稳定的对象
 */
export function LayerRows({ layer, order, what }: { layer: SettingLayer; order: LayerOrder; what: string }) {
  const target = useMemo(() => ({ layer }), [layer]);
  const { rows, error, update, retry } = useSettingRows(target);
  if (error) return <SessionsFetchError what={what} error={error} retry={retry} />;
  if (!rows) return null;
  return (
    <div className="settings-rows">
      {rows.length === 0 ? (
        <p className="settings-note">这一层没有可以设置的项</p>
      ) : (
        <SettingRows rows={rows} layer={layer.scope} sourceOf={name => labelOf(order, name)} update={update} />
      )}
    </div>
  );
}
