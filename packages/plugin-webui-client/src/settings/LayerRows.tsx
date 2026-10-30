import type { SettingLayer } from '@aalis/api-session-protocol';
import { useMemo } from 'react';
import { tr } from '../language';
import { SessionsFetchError } from '../shell/SessionGate';
import { type LayerOrder, layerParam, type SourceContext, sourceTitle } from './layers';
import { SettingRows } from './SettingRows';
import { useSettingRows } from './setting-rows';

/**
 * 会话之上一层的设置行（设置的「会话默认」、房间的「场所设置」）：与会话的「设置」标签同一套，改动写进这一层，这一层没写的项
 * 写它从哪一层继承来（称呼按层表，at 是取的是哪一份）。取不到时写明原因、可以重试；what 是出错时写的「<哪里>没取到」
 */
export function LayerRows({
  layer,
  order,
  at,
  what,
}: {
  layer: SettingLayer;
  order: LayerOrder;
  at?: SourceContext;
  what: string;
}) {
  // 按层的写法比较：同一层换了对象（层表重取）不算换层
  const id = layerParam(layer);
  const target = useMemo(() => ({ layer }), [id]);
  const { rows, error, update, retry } = useSettingRows(target);
  if (error) return <SessionsFetchError what={what} error={error} retry={retry} />;
  if (!rows) return null;
  return (
    <div className="settings-rows">
      {rows.length === 0 ? (
        <p className="settings-note">{tr('layerEmpty')}</p>
      ) : (
        <SettingRows
          rows={rows}
          layer={layer.scope}
          own
          originOf={source => tr('originFrom', { layer: sourceTitle(order, source, at) })}
          invalidOf={source => tr('invalidHere', { layer: sourceTitle(order, source, at) })}
          update={update}
        />
      )}
    </div>
  );
}
