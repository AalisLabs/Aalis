import type { ConfigSchema, Context } from '@aalis/core';
import { startBridgeClient } from './bridge-client.js';
import { GameActivityManager } from './manager.js';
import { registerStartGameTool } from './start-game-tool.js';
import '@aalis/plugin-tools-api';

export * from './adapter.js';
export { GameActivityManager } from './manager.js';
export * from './protocol.js';
export { GameActivitySession } from './session.js';

export const name = '@aalis/plugin-game-activity';
export const displayName = '游戏陪玩活动框架';
export const subsystem = 'skills';
export const inject = {
  optional: ['session-channel'],
};

export const configSchema: ConfigSchema = {
  bridgeHost: {
    type: 'string',
    label: 'Bridge 主机地址',
    description: 'Aalis 主动连接到此地址（游戏 mod 监听端）。默认 127.0.0.1',
    default: '127.0.0.1',
  },
  bridgePort: {
    type: 'number',
    label: 'Bridge 端口',
    description: '游戏 mod 监听的 WebSocket 端口',
    default: 43772,
  },
  bridgePath: {
    type: 'string',
    label: 'WebSocket 路径',
    description: '默认 /aalis-bridge，与 mod 端一致即可',
    default: '/aalis-bridge',
  },
  decisionModel: {
    type: 'select',
    label: '决策模型',
    description: '留空使用当前默认 LLM；可指定低延迟模型用于即时决策',
    default: '',
    dynamicOptions: 'llm',
  },
  decisionTimeoutMs: {
    type: 'number',
    label: '决策超时（毫秒）',
    description: '单次 LLM 决策的软超时',
    default: 15000,
  },
  decisionThinkingMode: {
    type: 'select',
    label: '决策思考模式',
    description: '是否覆盖 LLM 提供者的思考模式。默认不覆盖，使用提供者/模型全局配置',
    default: 'disabled',
    options: [
      { label: '使用提供者默认配置', value: 'provider_default' },
      { label: '强制启用思考', value: 'enabled' },
      { label: '强制关闭思考', value: 'disabled' },
    ],
  },
  decisionHistoryLimit: {
    type: 'number',
    label: '决策历史上限',
    description: '游戏决策线程保留的热历史消息数。默认 120，超过后按配置压缩旧决策',
    default: 120,
  },
  decisionHistoryKeepRecent: {
    type: 'number',
    label: '压缩后保留最近消息',
    description: '触发压缩时保留多少条最近决策/事件作为热上下文。默认 40',
    default: 40,
  },
  decisionHistoryCompression: {
    type: 'boolean',
    label: '启用游戏决策历史压缩',
    description: '启用后旧决策会压缩成本局游戏摘要；关闭后仅保留最近消息',
    default: true,
  },
  decisionHistorySummaryMaxTokens: {
    type: 'number',
    label: '决策历史摘要 token 上限',
    description: '压缩旧游戏决策时摘要最多使用的 token 数。默认 700',
    default: 700,
  },
};

export const defaultConfig = {
  bridgeHost: '127.0.0.1',
  bridgePort: 43772,
  bridgePath: '/aalis-bridge',
  decisionModel: '',
  decisionTimeoutMs: 15000,
  decisionThinkingMode: 'disabled',
  decisionHistoryLimit: 120,
  decisionHistoryKeepRecent: 40,
  decisionHistoryCompression: true,
  decisionHistorySummaryMaxTokens: 700,
};

type DecisionThinkingMode = 'provider_default' | 'enabled' | 'disabled';

interface PluginConfig {
  bridgeHost: string;
  bridgePort: number;
  bridgePath: string;
  decisionModel: string;
  decisionTimeoutMs: number;
  decisionThinkingMode: DecisionThinkingMode;
  decisionHistoryLimit: number;
  decisionHistoryKeepRecent: number;
  decisionHistoryCompression: boolean;
  decisionHistorySummaryMaxTokens: number;
}

function resolveConfig(config: Record<string, unknown>): PluginConfig {
  return {
    bridgeHost:
      typeof config.bridgeHost === 'string' && config.bridgeHost.trim()
        ? config.bridgeHost.trim()
        : defaultConfig.bridgeHost,
    bridgePort: Math.max(1, Math.min(65535, Math.floor(Number(config.bridgePort ?? defaultConfig.bridgePort)))),
    bridgePath:
      typeof config.bridgePath === 'string' && config.bridgePath.trim()
        ? config.bridgePath.trim()
        : defaultConfig.bridgePath,
    decisionModel: typeof config.decisionModel === 'string' ? config.decisionModel.trim() : '',
    decisionTimeoutMs: Math.max(1000, Math.floor(Number(config.decisionTimeoutMs ?? defaultConfig.decisionTimeoutMs))),
    decisionThinkingMode: parseDecisionThinkingMode(config.decisionThinkingMode),
    decisionHistoryLimit: Math.max(
      10,
      Math.min(300, Math.floor(Number(config.decisionHistoryLimit ?? defaultConfig.decisionHistoryLimit))),
    ),
    decisionHistoryKeepRecent: Math.max(
      4,
      Math.min(200, Math.floor(Number(config.decisionHistoryKeepRecent ?? defaultConfig.decisionHistoryKeepRecent))),
    ),
    decisionHistoryCompression:
      typeof config.decisionHistoryCompression === 'boolean'
        ? config.decisionHistoryCompression
        : defaultConfig.decisionHistoryCompression,
    decisionHistorySummaryMaxTokens: Math.max(
      200,
      Math.min(
        2000,
        Math.floor(Number(config.decisionHistorySummaryMaxTokens ?? defaultConfig.decisionHistorySummaryMaxTokens)),
      ),
    ),
  };
}

function parseDecisionThinkingMode(value: unknown): DecisionThinkingMode {
  if (value === 'enabled' || value === 'disabled') return value;
  return 'provider_default';
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  const manager = new GameActivityManager();
  manager.setDecisionModel(cfg.decisionModel);
  manager.setDecisionTimeout(cfg.decisionTimeoutMs);
  manager.setDecisionThink(
    cfg.decisionThinkingMode === 'provider_default' ? undefined : cfg.decisionThinkingMode === 'enabled',
  );
  manager.setDecisionHistoryOptions({
    historyLimit: cfg.decisionHistoryLimit,
    keepRecent: Math.min(cfg.decisionHistoryKeepRecent, Math.max(4, cfg.decisionHistoryLimit - 2)),
    compressionEnabled: cfg.decisionHistoryCompression,
    summaryMaxTokens: cfg.decisionHistorySummaryMaxTokens,
  });

  // Expose the manager so adapter plugins (sts2 etc.) can register themselves.
  ctx.provide('gameActivity', manager);

  const url = `ws://${cfg.bridgeHost}:${cfg.bridgePort}${cfg.bridgePath}`;

  // 延迟到 app:started 之后再启动 bridge 客户端，
  // 否则可能在游戏适配器（如 plugin-slay-spire-agent）注册到 manager 之前
  // 就收到 mod 的 hello 帧，导致首个 session 找不到适配器。
  let handle: ReturnType<typeof startBridgeClient> | undefined;
  const startBridge = (): void => {
    if (handle) return;
    handle = startBridgeClient({
      url,
      ctx,
      handlers: {
        onConnect: conn => manager.onConnect(ctx, conn),
        onMessage: (conn, msg) => {
          manager.onMessage(ctx, conn, msg).catch(err => {
            ctx.logger.warn(`game-activity 处理事件失败: ${err instanceof Error ? err.message : String(err)}`);
          });
        },
        onClose: conn => manager.onClose(ctx, conn),
        onError: (_conn, err) => ctx.logger.debug(`bridge 异常: ${err instanceof Error ? err.message : String(err)}`),
        onStateChange: state => ctx.logger.debug(`bridge 连接状态: ${state}`),
      },
    });
    ctx.logger.info(`game-activity bridge 客户端启动，目标 ${url}`);
  };

  // 暴露连接状态查询给 start_game 等工具使用
  ctx.provide('gameActivityBridge', {
    getState: () => handle?.getState() ?? 'disconnected',
    isReady: () => handle?.getState() === 'connected',
    url,
  });

  registerStartGameTool(ctx, manager, () => handle);

  const offStarted = ctx.eventBus.on('app:started', () => {
    startBridge();
  });

  ctx.onDispose(() => {
    handle?.close();
    offStarted();
  });
}
