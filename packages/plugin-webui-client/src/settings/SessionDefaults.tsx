import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { List, ListItem } from '../components/List';
import { lower } from '../format';
import { tr } from '../language';
import { paths } from '../routes';
import { SessionsFetchError } from '../shell/SessionGate';
import { usePhone } from '../shell/Shell';
import { LayerRows } from './LayerRows';
import {
  type LayerInfo,
  type LayerOrder,
  labelOf,
  layerAddress,
  layerParam,
  layerTitle,
  type SourceContext,
  typeText,
  useLayers,
} from './layers';

// 设置的「会话默认」：第一步选层，第二步改这一层的项。层的列表按层表分组（全局、平台档、平台类型档、场所），顶上可以
// 按层的称呼、平台名、类型名与类型的显示名、场所名与场所键搜索；所选的层记进地址（?layer=），刷新与分享链接都回到这一层。
// 宽屏两步左右并排，手机上是两屏，第二屏顶上「换一层」回到选层。可以选的层与称呼、继承的先后都取自会话服务给的层表，插件启停
// 与设置变了时重取

/**
 * 列表里一层的名字（组名已是层的称呼，这里写是哪一份、带平台）：全局写层表里的称呼，平台档写平台名，平台类型档写「平台 · 类型的
 * 显示名」（没有时写类型名），场所写称呼，窗口场所另补平台
 */
function itemName(order: LayerOrder, { layer, label, platform }: LayerInfo): string {
  switch (layer.scope) {
    case 'global':
      return labelOf(order, layer.scope);
    case 'platform':
      return layer.platform;
    case 'platformType':
      return `${layer.platform} · ${label ?? layer.type}`;
    case 'place':
      return platform ? tr('placeOn', { place: label ?? layer.key, platform }) : (label ?? layer.key);
  }
}

/** 一层的来源取的是哪一份：平台档、平台类型档按这一层自己的平台与类型，窗口场所按层的列表给的 */
function contextOf(layers: readonly LayerInfo[], { layer, platform, type }: LayerInfo): SourceContext {
  const at = 'platform' in layer ? layer.platform : platform;
  return { platform: at, chatType: typeText(layers, at, 'type' in layer ? layer.type : type) };
}

export function SessionDefaults() {
  const phone = usePhone();
  const [params] = useSearchParams();
  const { value, error, retry } = useLayers();
  const [query, setQuery] = useState('');
  if (error) return <SessionsFetchError what={tr('sessionDefaultLayers')} error={error} retry={retry} />;
  if (!value) return null;
  const { order } = value;
  const chosen = value.layers.find(info => layerParam(info.layer) === params.get('layer'));
  const needle = lower(query.trim());
  const matches = (info: LayerInfo) =>
    !needle ||
    [
      itemName(order, info),
      labelOf(order, info.layer.scope),
      'type' in info.layer ? info.layer.type : '',
      'key' in info.layer ? info.layer.key : '',
    ]
      .map(lower)
      .some(text => text.includes(needle));

  const list = (
    <nav className="session-defaults-layers" aria-label={tr('settingLayers')}>
      <input
        type="search"
        aria-label={tr('searchLayers')}
        placeholder={tr('searchLayers')}
        value={query}
        onChange={event => setQuery(event.target.value)}
      />
      {order.map(({ name, label }) => {
        const shown = value.layers.filter(info => info.layer.scope === name && matches(info));
        return (
          shown.length > 0 && (
            <section key={name}>
              <p className="settings-group" aria-hidden>
                {label}
              </p>
              <List label={label}>
                {shown.map(info => (
                  <ListItem
                    key={layerParam(info.layer)}
                    to={layerAddress(info.layer)}
                    title={itemName(order, info)}
                    current={info === chosen}
                  />
                ))}
              </List>
            </section>
          )
        );
      })}
    </nav>
  );
  const detail = chosen ? (
    <div className="session-defaults-rows">
      {phone && (
        <Link className="session-defaults-back" to={paths.settingsSection('session-defaults')}>
          {tr('otherLayer')}
        </Link>
      )}
      <h3 className="session-defaults-title">{layerTitle(order, chosen.layer, chosen.label)}</h3>
      <p className="settings-note">
        {tr('settingsOrderNote', { layers: order.map(entry => entry.label).toReversed() })}
      </p>
      <LayerRows layer={chosen.layer} order={order} at={contextOf(value.layers, chosen)} what={tr('sessionDefaults')} />
    </div>
  ) : (
    <p className="settings-note">{tr('pickLayer')}</p>
  );
  if (phone) return <div className="page-screen settings-screen">{chosen ? detail : list}</div>;
  return (
    <div className="page-screen session-defaults">
      {list}
      {detail}
    </div>
  );
}
