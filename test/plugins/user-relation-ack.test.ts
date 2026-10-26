import { describe, expect, it, vi } from 'vitest';
import type { AuthorityService } from '../../packages/api-authority/src/index.js';
import type { BoundCommands } from '../../packages/api-commands/src/index.js';
import type { PlatformAdapter } from '../../packages/api-platform/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { CommandRegistry } from '../../packages/plugin-commands/src/commands.js';
import { type EvictionConfig, registerRelationCommands } from '../../packages/plugin-user-relation/src/commands.js';
import type { RelationService } from '../../packages/plugin-user-relation/src/index.js';
import { fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// /relation 的长任务先往当前会话推一句「正在跑」：有平台适配器认领这个会话才推（定时任务以 internal 平台发进群里的
// 也推），没有认领者的不推，也不留推送失败的日志。不按平台名判。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

function world() {
  /** /relation 自己的日志（指令注册表的另用 silent） */
  const logs: string[] = [];
  const at = (level: string) => (message: string) => void logs.push(`${level} ${message}`);
  const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } as unknown as Logger;
  const sendMessage = vi.fn(async () => {});
  const onebot: PlatformAdapter = {
    adapterName: 'onebot',
    platform: 'onebot',
    getConnections: () => [],
    sendMessage,
    canHandle: id => id.startsWith('onebot:10000:'),
  };
  const owner = { authorize: () => null } as unknown as AuthorityService;
  const registry = new CommandRegistry(silent, fixedRef(owner), ref());
  registry.setExecutionGuard(async () => ({ ok: true }));
  const commands = {
    command: (name: string, description?: string, meta?: object) =>
      registry.command(name, description, { ...meta, pluginName: 'relation' }),
  } as unknown as BoundCommands;
  const service = { rewriteWeights: async () => ({ skipped: true }) } as unknown as RelationService;
  registerRelationCommands(
    { commands, platform: ref([{ instance: onebot, contextId: 'onebot:a' }]), llm: ref(), logger },
    service,
    {
      eviction: { weightDecayHalfLifeDays: 30, weightDecayFloor: 0.1 } as EvictionConfig,
      consolidateAutoLink: false,
      consolidateSkipLowScorePairs: false,
      consolidateLowScoreThreshold: 0,
    },
  );
  const run = async (sessionId: string, platform: string) => {
    const reply = await registry.execute('relation', {
      sessionId,
      platform,
      userId: 'console',
      args: ['rewrite-weights'],
      raw: '',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    return reply;
  };
  return { logs, sendMessage, run };
}

describe('/relation 长任务的立即反馈', () => {
  it.each([
    ['有适配器认领的会话', 'onebot'],
    ['平台写 internal、有适配器认领的会话（定时任务发进群里）', 'internal'],
  ])('%s：推一句正在跑', async (_, platform) => {
    const { sendMessage, run } = world();
    expect(await run(GROUP, platform)).toBe('weight 衰减未启用，已跳过。');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(GROUP, '正在按 halfLifeDays=30、floor=0.1 回写 weight，请稍候…');
  });

  it('没有适配器认领的会话：不推，不留推送失败的日志', async () => {
    const { logs, sendMessage, run } = world();
    expect(await run('session-zz000001', 'webui')).toBe('weight 衰减未启用，已跳过。');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});
