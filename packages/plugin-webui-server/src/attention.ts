// ============================================================
// attention.ts — 插件没起来的原因与「需要处理」
//
// 插件没起来的原因（缺、在等、待配置）在这里算一份，插件列表与「需要处理」共用：缺与在等按 api-doctor 的共享判据沿依赖链
// 追到根，与 runtime 的启动告警、诊断同一说法；失败的另按配置 schema 校验它的配置，列出必填却没填的项。
//
// 「需要处理」：推出未结的审批、插件故障（失败与缺服务；只在等别的插件启动的不算）与插件的提示汇总成一个列表，每项计 1，
// 经 GET /api/attention 给出。变了就经 /admin 推 attention.changed：审批推出或结算是变化，提示的登记与撤回由页面登记表推
// （pages.ts）；插件登记表每次重算之后比一次故障（连同链与根），变了才推（重算很频繁，多数与故障无关）。
// ============================================================

import type { Approval } from '@aalis/api-approval';
import { unmetDependencies } from '@aalis/api-doctor';
import type { HostConfig } from '@aalis/api-host-config';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { AttentionItem, Notice, PluginBlockers, WebuiAdminEvent } from '@aalis/api-webui';
import type { PluginManagerService, PluginStatusEntry, Services } from '@aalis/core';
import { validateConfig } from '@aalis/schema-config';

/** 算插件没起来的原因要读的：插件状态与定义、当前有提供者的服务名、配置文档（宿主不提供时读运行态配置） */
interface BlockerSources {
  plugins: Pick<PluginManagerService, 'getStatus' | 'getPlugin'>;
  services: Pick<Services, 'names'>;
  doc?: Pick<HostConfig, 'getPluginConfig'>;
}

/** 插件状态快照，每个实例带上没起来的原因 */
export function blockedStatus({ plugins, services, doc }: BlockerSources): Array<PluginStatusEntry & PluginBlockers> {
  const status = plugins.getStatus();
  const unmet = unmetDependencies(status, services.names());
  /** 必填却没填的配置项：`''` 算没填，密钥引用算填了（validateConfig 的 missing） */
  const unconfigured = (instanceId: string) => {
    const entry = plugins.getPlugin(instanceId);
    const config = doc ? doc.getPluginConfig(instanceId) : (entry?.config ?? {});
    return validateConfig(entry?.definition.configSchema, config)
      .filter(issue => issue.kind === 'missing')
      .map(issue => issue.path);
  };
  return status.map(entry => ({
    ...entry,
    ...(unmet.get(entry.instanceId) ?? { lacking: [], waiting: [] }),
    unconfigured: entry.state === 'error' ? unconfigured(entry.instanceId) : [],
  }));
}

interface AttentionDeps {
  /** 推出未结的审批；审批服务不在时没有 */
  approvals(): readonly Approval[];
  /** 会话管理：审批所在会话的标题 */
  sessions(): Pick<SessionManagerService, 'getSession'> | undefined;
  /** 插件状态与没起来的原因；插件管理服务不在时为空 */
  plugins(): ReadonlyArray<PluginStatusEntry & PluginBlockers>;
  /** 登记着的提示，带所属实例 */
  notices(): ReadonlyArray<Notice & { instance: string }>;
  send(event: WebuiAdminEvent): void;
}

export function createAttention(deps: AttentionDeps) {
  const faults = (): AttentionItem[] =>
    deps.plugins().flatMap(({ instanceId, state, error, lacking, waiting, unconfigured }) =>
      state === 'error' || (state === 'pending' && lacking.length > 0)
        ? [
            {
              kind: 'plugin' as const,
              instance: instanceId,
              state,
              ...(error !== undefined && { error }),
              lacking,
              waiting,
              unconfigured,
            },
          ]
        : [],
    );

  const titleOf = (sessionId: string) => {
    const info = deps.sessions()?.getSession(sessionId);
    return info && (info.title || info.name);
  };

  let reported = JSON.stringify(faults());
  const changed = () => deps.send({ type: 'attention.changed' });

  return {
    /** 审批在前，其后是插件故障与提示，各按先后 */
    items: (): AttentionItem[] => [
      ...deps.approvals().map(({ id, sessionId, tool }) => {
        const session = titleOf(sessionId);
        return { kind: 'approval' as const, id, sessionId, ...(session !== undefined && { session }), tool };
      }),
      ...faults(),
      ...deps.notices().map(notice => ({ kind: 'notice' as const, ...notice })),
    ],
    /** 审批推出或结算了 */
    changed,
    /** 插件登记表重算过：故障（连同链与根）变了才推 */
    pluginsChanged(): void {
      const now = JSON.stringify(faults());
      if (now === reported) return;
      reported = now;
      changed();
    },
  };
}
