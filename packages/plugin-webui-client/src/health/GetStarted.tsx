import type { MarketplacePackage } from '@aalis/api-webui';
import { useEffect, useReducer, useState } from 'react';
import { Button } from '../components/Button';
import { ButtonLink } from '../components/ButtonLink';
import { FetchError } from '../components/FetchError';
import { useConnection } from '../connection';
import { usePluginAction } from '../plugins/action';
import { InstallDialog } from '../plugins/InstallDialog';
import { CHAT, LLM, type PluginRow, useFindPlugin, useHost, usePlugins } from '../plugins/list';
import { parseMarket } from '../plugins/Market';
import { fixLink, markerOf, pluginName, statusLine, statusOf } from '../plugins/status';
import { postJson, useJson } from '../rest';
import { parseOptions } from '../settings/field';
import { type Row, Rows } from './AttentionList';

// 「开始使用」：模型列表里没有一个能对话的模型时，首页「需要处理」摘要上方出现「选一个对话模型」：已装的对话模型插件与它为什么
// 不能用，再列市场里还没装的。按状态出现，有了能对话的模型就消失；插件列表或「需要处理」变了、管理连接重连后重取模型列表。
// 市场只在卡片出现时与装完之后取（取一次要向安装源发几十个请求），别处装上的按插件列表排除

const parseModels = (body: unknown) => parseOptions(true, body);

export function GetStarted() {
  const { admin } = useConnection();
  const host = useHost();
  const [version, reload] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offs = [
      admin.on('plugins.changed', reload),
      admin.on('attention.changed', reload),
      admin.onReconnect(reload),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);
  const { value: models, error } = useJson('/api/models/llm', parseModels, version);
  if (models?.some(model => model.capabilities?.includes(CHAT)) || (!models && !error)) return null;
  return (
    <section className="attention-summary" aria-label="开始使用">
      <h2 className="section-heading">开始使用</h2>
      {models && <ChooseModel />}
      {error && (
        <FetchError
          what="对话模型列表"
          error={error}
          retry={reload}
          stale={models !== undefined}
          inline
          source={host}
        />
      )}
    </section>
  );
}

/** 选一个对话模型：已装的对话模型插件逐个写为什么不能用、怎么处理，市场里还没装的可以直接装 */
function ChooseModel() {
  const { plugins } = usePlugins();
  const find = useFindPlugin();
  const host = useHost();
  const action = usePluginAction();
  const [marketVersion, reloadMarket] = useReducer((n: number) => n + 1, 0);
  const market = useJson('/api/marketplace?q=', parseMarket, marketVersion);
  const [installing, setInstalling] = useState<MarketplacePackage>();

  const installed = (plugins ?? [])
    .filter(row => row.provides.includes(LLM))
    .map(
      (row): Row => ({
        key: row.instanceId,
        tone: markerOf(statusOf(row)),
        title: pluginName(row.instanceId, find),
        detail: row.state === 'active' ? '在运行，但没有能对话的模型' : statusLine(row, find),
        action: providerAction(row),
      }),
    );
  const available = (market.value?.packages ?? [])
    .filter(pkg => !pkg.installed && !plugins?.some(row => row.name === pkg.name) && pkg.provides.includes(LLM))
    .map(
      (pkg): Row => ({
        key: `market:${pkg.name}`,
        title: pkg.name,
        detail: pkg.description || undefined,
        action: (
          <Button disabled={action.busy !== undefined} onClick={() => setInstalling(pkg)}>
            安装
          </Button>
        ),
      }),
    );

  /** 停用的一键启用；在启动的等着；其余按「需要处理」同一条规则去处理 */
  function providerAction(row: PluginRow) {
    const id = row.instanceId;
    if (row.state === 'disabled') {
      const label = `启用 ${pluginName(id, find)}`;
      return (
        <Button
          busy={action.busy === label}
          disabled={action.busy !== undefined}
          onClick={() =>
            action.run(label, () => postJson(`/api/plugins/${encodeURIComponent(id)}/enable`, {}), undefined, id)
          }
        >
          启用
        </Button>
      );
    }
    if (row.state === 'activating' || (row.state === 'pending' && row.lacking.length === 0)) return undefined;
    const fix = fixLink(id, row, find);
    return <ButtonLink to={fix.to}>{fix.label}</ButtonLink>;
  }

  return (
    <>
      <p className="attention-detail">还没有能对话的模型。选一个对话模型：配好已装的，或从市场装一个。</p>
      {installed.length + available.length > 0 && <Rows rows={[...installed, ...available]} />}
      {market.value?.warning && <p className="attention-detail">{market.value.warning}</p>}
      {market.error && (
        <FetchError
          what="市场"
          error={market.error}
          retry={reloadMarket}
          stale={market.value !== undefined}
          inline
          source={host}
        />
      )}
      <InstallDialog
        pkg={installing}
        action={action}
        onClose={() => setInstalling(undefined)}
        onSettled={reloadMarket}
      />
    </>
  );
}
