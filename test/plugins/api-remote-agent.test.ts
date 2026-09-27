import { describe, expect, it } from 'vitest';
import {
  type EgressCeiling,
  type EgressMode,
  egressWithin,
  isRemoteAgentError,
  isTerminalRun,
  RemoteAgentError,
  type RemoteAgentProvider,
  type RunStatus,
  resolveRemoteAgent,
} from '../../packages/api-remote-agent/src/index.js';
import type { ServiceRef, ServiceView } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// @aalis/api-remote-agent：远端代理契约里的纯函数。按名取提供者只做精确匹配，
// 找不到就是找不到，不回落到偏好胜者或列表第一个：白纸的资格判定靠它取到的正是配置点名的那个提供者。
// ════════════════════════════════════════════════════════════

/** 按名取提供者只比身份，替身不需要能调用 */
const provider = (tag: string) => ({ tag }) as unknown as RemoteAgentProvider;

const CURSOR = '@aalis/plugin-remote-agent-cursor';
const CURSOR_ALT = '@aalis/plugin-remote-agent-cursor:alt';

/** all() 按偏好排序；current 由调用方给（模拟偏好指向别的提供者） */
function refOf(
  entries: ServiceView<RemoteAgentProvider>[],
  current: RemoteAgentProvider | undefined = entries[0]?.instance,
): ServiceRef<RemoteAgentProvider> {
  return {
    current,
    require: () => {
      if (!current) throw new Error('没有提供者');
      return current;
    },
    all: () => entries,
    follow: () => () => {},
  };
}

describe('resolveRemoteAgent', () => {
  const main = provider('main');
  const alt = provider('alt');
  const entries: ServiceView<RemoteAgentProvider>[] = [
    { instance: alt, contextId: CURSOR_ALT, priority: 0, label: 'Cursor（换模型）' },
    { instance: main, contextId: CURSOR, priority: 0, label: 'Cursor' },
  ];

  it('两个提供者登记时按实例 id 各取各的', () => {
    const ref = refOf(entries);
    expect(resolveRemoteAgent(ref, CURSOR)?.instance).toBe(main);
    expect(resolveRemoteAgent(ref, CURSOR_ALT)?.instance).toBe(alt);
    expect(resolveRemoteAgent(ref, CURSOR)).toMatchObject({ contextId: CURSOR, label: 'Cursor' });
  });

  it('名字不存在返回 undefined，也不按前缀认领', () => {
    const ref = refOf(entries);
    expect(resolveRemoteAgent(ref, '@aalis/plugin-remote-agent-other')).toBeUndefined();
    expect(resolveRemoteAgent(refOf([entries[0]]), CURSOR)).toBeUndefined();
    expect(resolveRemoteAgent(refOf([]), CURSOR)).toBeUndefined();
  });

  it('安全：偏好指向另一个提供者、要取的名字不在场时返回 undefined，不回落到胜者或第一个', () => {
    // 偏好让 alt 成为胜者（排在 all() 首位、current 指向它）；配置点名的 CURSOR 不在场
    const ref = refOf([entries[0]], alt);
    expect(ref.current).toBe(alt);
    expect(resolveRemoteAgent(ref, CURSOR)).toBeUndefined();
  });
});

describe('egressWithin', () => {
  const MODES: EgressMode[] = ['none', 'allowlist', 'open', 'unknown'];
  /** 期望：[上限][报告] → 是否不超过；unknown 按 open 算 */
  const EXPECTED: Record<EgressCeiling, Record<EgressMode, boolean>> = {
    none: { none: true, allowlist: false, open: false, unknown: false },
    allowlist: { none: true, allowlist: true, open: false, unknown: false },
    open: { none: true, allowlist: true, open: true, unknown: true },
  };

  it('安全：全组合，unknown 按 open 算；来源不影响判定', () => {
    for (const ceiling of Object.keys(EXPECTED) as EgressCeiling[]) {
      for (const mode of MODES) {
        for (const source of ['provider-api', 'owner-config'] as const) {
          expect(egressWithin({ mode, source }, ceiling), `${mode}（${source}）对上限 ${ceiling}`).toBe(
            EXPECTED[ceiling][mode],
          );
        }
      }
    }
  });
});

describe('isTerminalRun', () => {
  it('finished、error、cancelled、expired 是终态，creating、running 不是', () => {
    const table: Record<RunStatus, boolean> = {
      creating: false,
      running: false,
      finished: true,
      error: true,
      cancelled: true,
      expired: true,
    };
    for (const [status, terminal] of Object.entries(table) as Array<[RunStatus, boolean]>) {
      expect(isTerminalRun(status), status).toBe(terminal);
    }
  });
});

describe('RemoteAgentError', () => {
  it('带错误码、重试等待与原因', () => {
    const cause = new Error('底层');
    const err = new RemoteAgentError('rate-limited', '远端限流', { retryAfterMs: 60_000, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RemoteAgentError');
    expect(err.code).toBe('rate-limited');
    expect(err.retryAfterMs).toBe(60_000);
    expect(err.message).toBe('远端限流');
    expect(err.cause).toBe(cause);
    expect(new RemoteAgentError('busy', '代理忙').retryAfterMs).toBeUndefined();
  });

  it('isRemoteAgentError 按名字认，另一份契约包抛出的也认得', () => {
    expect(isRemoteAgentError(new RemoteAgentError('transient', '断线'))).toBe(true);
    // 另一份副本的类不是同一个构造函数，instanceof 不成立，名字相同
    const foreign = Object.assign(new Error('代理已归档'), { name: 'RemoteAgentError', code: 'archived' });
    expect(isRemoteAgentError(foreign)).toBe(true);
    expect(isRemoteAgentError(new Error('别的错误'))).toBe(false);
    expect(isRemoteAgentError(undefined)).toBe(false);
    expect(isRemoteAgentError('RemoteAgentError')).toBe(false);
  });
});
