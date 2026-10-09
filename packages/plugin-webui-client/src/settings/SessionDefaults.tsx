import type { SettingLayer } from '@aalis/api-session-protocol';
import { useId, useMemo, useState } from 'react';
import { Select } from '../components/Select';
import { SessionsFetchError } from '../shell/SessionGate';
import { LayerRows } from './LayerRows';
import { type LayerOrder, layerLabel, useLayers } from './layers';

// 设置的「会话默认」：顶部选层（存在配置文件里的几种：全局默认、各平台档、各平台类型档；场所在房间页与会话列表里改），下面是
// 这一层的设置项，行与会话的「设置」标签同一套。可以选的层与它们的称呼、继承的先后都取自会话服务给的层表，插件启停与设置变了
// 时重取；选中的层没了回到全局默认，那一层之后再出现也不自己切回去

const DEFAULTS: SettingLayer = { scope: 'defaults' };

/** 层的标识：选择框的值，也用来比较两个层是不是同一个 */
const keyOf = (layer: SettingLayer): string => JSON.stringify(layer, Object.keys(layer).sort());

/** 继承先后的说明：层表按先后排，说明从压过别人的那一层说起 */
const orderNote = (order: LayerOrder) =>
  `会话设置按${order
    .map(entry => entry.label)
    .toReversed()
    .join('、')}的先后，取第一个设了值的一层；哪一层都没设时按各项自己的默认。改动从下一轮起生效。`;

export function SessionDefaults() {
  const pickerId = useId();
  const { value, error, retry } = useLayers();
  const [chosen, setChosen] = useState(keyOf(DEFAULTS));
  const layers = value?.layers.filter(layer => layer.scope !== 'place') ?? [];
  if (value && !layers.some(layer => keyOf(layer) === chosen)) setChosen(keyOf(DEFAULTS));
  const layer = useMemo(() => JSON.parse(chosen) as SettingLayer, [chosen]);

  return (
    <div className="page-screen settings-screen">
      {error && <SessionsFetchError what="会话默认的层" error={error} retry={retry} />}
      {value && (
        <>
          <div className="settings-head">
            <p className="settings-note">{orderNote(value.order)}</p>
            <div className="settings-field">
              <label htmlFor={pickerId}>层</label>
              <Select
                id={pickerId}
                value={chosen}
                options={layers.map(each => ({ value: keyOf(each), label: layerLabel(value.order, each) }))}
                onChange={setChosen}
              />
            </div>
            {layer.scope !== 'defaults' && <p className="settings-note">平台档按平台名生效，不区分实例。</p>}
          </div>
          <LayerRows layer={layer} order={value.order} what="会话默认" />
        </>
      )}
    </div>
  );
}
