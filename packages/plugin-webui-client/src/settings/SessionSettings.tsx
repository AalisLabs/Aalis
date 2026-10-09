import type { SessionSummary, SettingLayer } from '@aalis/api-session-protocol';
import { useId, useState } from 'react';
import { Select } from '../components/Select';
import { useSessionClient } from '../connection';
import { SessionsFetchError } from '../shell/SessionGate';
import { type LayerOrder, labelOf, useLayers } from './layers';
import { SettingRows } from './SettingRows';
import type { useSettingRows } from './setting-rows';

// 会话的「设置」标签：这个会话适用的各行，每项写当前值与「来自：…」。在哪用就在哪改：顶部选改动写到哪一层——只这个会话、
// 根会话的场所（这个工作区、这个群、这个私聊）、所有会话（全局默认）；平台档与平台类型档只在设置的「会话默认」里改。
// 生效值出自比所选更窄的层时，那一行写明改了不生效。写进场所与全局默认之后，会话服务推 session/config/changed，这里的行随之
// 重取。层表没取到时设置行照常列出，来源按层名写

/** 场所的叫法：工作区，窗口按多方标记叫群或私聊 */
const placeWord = (summary: SessionSummary) =>
  summary.place.kind === 'workspace' ? '工作区' : summary.chat?.multiParty ? '群' : '私聊';

/** 「来自：…」：场所、平台档与平台类型档另写这个会话取的是哪一份 */
function originOf(order: LayerOrder, summary: SessionSummary | undefined, name: string): string {
  const label = labelOf(order, name);
  if (!summary) return `来自：${label}`;
  if (name === 'place') return `来自：${placeWord(summary)}『${summary.place.name}』`;
  const which =
    name === 'type' ? [summary.platform, summary.chat?.type] : name === 'platform' ? [summary.platform] : [];
  const detail = which.filter(Boolean).join(' · ');
  return detail ? `来自：${label} ${detail}` : `来自：${label}`;
}

/** 层在层表里的先后：后面的压过前面的 */
const rankOf = (order: LayerOrder, name: string) => order.findIndex(entry => entry.name === name);

interface Scope {
  /** 层名 */
  name: string;
  label: string;
  /** 会话之上的层；只这个会话的没有，写的是会话自己的覆盖 */
  layer?: SettingLayer;
}

/** 可以选的范围：只这个会话、根会话的场所、全局默认 */
function scopesOf(summary: SessionSummary | undefined): Scope[] {
  return [
    { name: 'session', label: '只这个会话' },
    ...(summary
      ? [
          {
            name: 'place',
            label: `这个${placeWord(summary)}`,
            layer: { scope: 'place', key: summary.place.key } as const,
          },
        ]
      : []),
    { name: 'defaults', label: '所有会话', layer: { scope: 'defaults' } },
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
  const scopes = scopesOf(summary);
  const [chosen, setChosen] = useState('session');
  const scope = scopes.find(each => each.name === chosen) ?? scopes[0];
  if (error) {
    return (
      <div className="session-panel-section">
        <SessionsFetchError what="设置" error={error} retry={retry} />
      </div>
    );
  }
  if (!rows || (!layers.value && !layers.error)) return null;
  if (rows.length === 0) return <p className="session-panel-note">这个会话没有可以设置的项</p>;
  const order = layers.value?.order ?? [];
  const { layer } = scope;
  /** 「来自：…」；来源比所选的层更窄（压过它）时另写改了不生效 */
  const sourceLine = (name: string) => {
    const origin = originOf(order, summary, name);
    return rankOf(order, name) > rankOf(order, scope.name) ? `${origin}（压过「${scope.label}」，改了不生效）` : origin;
  };
  const write = layer
    ? async (key: string, value: unknown) => {
        await client.request('session/config/layer/update', { layer, patch: { [key]: value } });
      }
    : update;
  return (
    <div className="session-panel-section">
      <p className="session-panel-note">改动从下一轮起生效</p>
      {layers.error && (
        <p className="session-panel-note" role="alert">
          层表没取到（{layers.error.message}），来源按层名写
        </p>
      )}
      <div className="settings-field">
        <label htmlFor={scopeId}>改到</label>
        <Select
          id={scopeId}
          value={scope.name}
          options={scopes.map(each => ({ value: each.name, label: each.label }))}
          onChange={setChosen}
        />
      </div>
      <SettingRows rows={rows} layer={scope.name} originOf={sourceLine} update={write} />
    </div>
  );
}
