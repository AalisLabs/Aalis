import type { Context } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type { BridgeClientHandle } from './bridge-client.js';
import type { GameActivityManager } from './manager.js';

interface ChannelService {
  create(opts: { label: string; sessions?: string[]; metadata?: Record<string, unknown> }): Promise<string>;
  join(channelId: string, sessionId: string): Promise<void>;
  get(channelId: string): { id: string; label: string; boundSessions: string[] } | undefined;
}

/**
 * 注册 `start_game` 工具：让 agent 主动把当前会话（以及可选的其他会话）
 * 绑定为一个 channel，作为本次游戏的"观众席"。游戏 mod 端如果尚未启动，
 * 工具仍然成功（返回 waiting），等 bridge 自动重连成功后游戏即开始驱动决策。
 */
export function registerStartGameTool(
  ctx: Context,
  manager: GameActivityManager,
  getBridge: () => BridgeClientHandle | undefined,
): void {
  useToolService(ctx).register({
    definition: {
      type: 'function',
      function: {
        name: 'start_game',
        description: [
          '开始一局陪玩游戏（例如杀戮尖塔2）。',
          '调用后会把当前会话 + 你额外指定的会话聚合成一个虚拟频道，',
          '游戏过程中 Aalis 的 chat 评论会广播到这些会话里，',
          '同时这些会话里的对话也会作为 vibes 影响 Aalis 在游戏里的决策。',
          '游戏端 mod 必须在本机监听 ws 端口；若未启动，工具会返回 waiting，',
          'Aalis 客户端会持续重试，连上后自动开始。',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            game: {
              type: 'string',
              description: '游戏标识，如 "sts2"',
            },
            extra_sessions: {
              type: 'array',
              description: '除当前会话外，还希望广播 / 聚合的其他会话 id 列表（可选）',
              items: { type: 'string' },
            },
            label: {
              type: 'string',
              description: 'channel 的人类可读标签，默认根据 game 自动生成',
            },
          },
          required: ['game'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const game = String(args.game || '').trim();
      if (!game) return JSON.stringify({ error: '缺少 game 参数' });

      const callerSession = callCtx?.sessionId;
      if (!callerSession) {
        return JSON.stringify({ error: '无法识别当前会话 id' });
      }

      const channels = ctx.getService<ChannelService>('session-channel');
      if (!channels) {
        return JSON.stringify({ error: 'session-channel 服务未启用，请先加载 plugin-session-channel' });
      }

      const extras = Array.isArray(args.extra_sessions)
        ? (args.extra_sessions as unknown[]).map(v => String(v).trim()).filter(v => v && v !== callerSession)
        : [];
      const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : `game:${game}`;

      let channelId: string;
      const existing = manager.getBoundChannel();
      if (existing && channels.get(existing)) {
        // 复用已有 channel，把新成员加进去
        channelId = existing;
        for (const sid of [callerSession, ...extras]) {
          try {
            await channels.join(channelId, sid);
          } catch {
            /* noop */
          }
        }
      } else {
        channelId = await channels.create({
          label,
          sessions: [callerSession, ...extras],
          metadata: { game, kind: 'game-activity' },
        });
        manager.setBoundChannel(channelId);
      }

      const bridgeState = getBridge()?.getState() ?? 'disconnected';
      const ready = bridgeState === 'connected' && manager.hasActiveSession();
      const status = ready ? 'ready' : bridgeState === 'connected' ? 'connected_no_hello' : 'waiting_for_game';

      return JSON.stringify({
        ok: true,
        channelId,
        status,
        bridgeState,
        membersCount: 1 + extras.length,
        hint: ready
          ? '游戏已就绪，开始决策。'
          : status === 'waiting_for_game'
            ? '游戏 mod 尚未启动或还没建立连接，Aalis 会持续重试，连上后自动开始。'
            : '已连上 mod，但还未收到 hello 帧，请稍候。',
      });
    },
  });
}
