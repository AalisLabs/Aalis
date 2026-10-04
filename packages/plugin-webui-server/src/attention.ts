// ============================================================
// attention.ts — 「需要处理」
//
// 推出未结的审批、插件故障（失败与缺服务）与插件的提示汇总成一个列表，每项计 1，经 GET /api/attention 给出。
// 变了就经 /admin 推 attention.changed：审批推出或结算是变化，提示的登记与撤回由页面登记表推（pages.ts）；
// 插件登记表每次重算之后比一次故障，变了才推（重算很频繁，多数与故障无关）。
// ============================================================

import type { Approval } from '@aalis/api-approval';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { AttentionItem, Notice, WebuiAdminEvent } from '@aalis/api-webui';
import type { PluginStatusEntry, Services } from '@aalis/core';

interface AttentionDeps {
  /** 推出未结的审批；审批服务不在时没有 */
  approvals(): readonly Approval[];
  /** 会话管理：审批所在会话的标题 */
  sessions(): Pick<SessionManagerService, 'getSession'> | undefined;
  plugins(): readonly PluginStatusEntry[];
  services: Pick<Services, 'inspect'>;
  /** 登记着的提示，带所属实例 */
  notices(): ReadonlyArray<Notice & { instance: string }>;
  send(event: WebuiAdminEvent): void;
}

/** 此刻没有任何提供者的 required 服务：插件「缺服务」缺的就是它们 */
export const missingServices = (services: Pick<Services, 'inspect'>, required: readonly string[] = []): string[] =>
  required.filter(service => services.inspect(service).length === 0);

export function createAttention(deps: AttentionDeps) {
  const faults = (): AttentionItem[] =>
    deps.plugins().flatMap(p =>
      p.state === 'error' || p.state === 'pending'
        ? [
            {
              kind: 'plugin' as const,
              instance: p.instanceId,
              state: p.state,
              ...(p.state === 'error' && p.error !== undefined && { error: p.error }),
              missing: missingServices(deps.services, p.requiredServices),
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
    /** 插件登记表重算过：故障变了才推 */
    pluginsChanged(): void {
      const now = JSON.stringify(faults());
      if (now === reported) return;
      reported = now;
      changed();
    },
  };
}
