/**
 * rename-watcher —— 平台 displayName → Person 节点的轻量同步器。
 *
 * 背景：当前 Person.displayName 只在 LLM extractor 命中 persons[] 时更新，
 * 用户在平台改名后可能数天内 webui 关系图仍显示旧名。本 watcher 监听
 * `inbound:message:archived`，从 metadata.nickname 直接同步到已存在的 Person。
 *
 * 策略：
 * - 仅同步已存在的 Person（不创建新节点，避免给水群幽灵建图）；
 * - 按 personId 60s 节流，避免每条消息都 hit store；
 * - 不动 mentionCount / lastMentionedAt（与「显式提及」区分），仅刷 lastSeenAt；
 * - 与 extractionEnabled 解耦：即便关掉写入提取，改名同步仍生效。
 */
import type { Context } from '@aalis/core';
import type { Message } from '@aalis/plugin-message-api';
import type { RelationService } from './service.js';

const THROTTLE_MS = 60_000;

interface ArchivedPayload {
  archivedMessage?: Message;
}

export function startRenameWatcher(ctx: Context, service: RelationService): void {
  const lastChecked = new Map<string, number>();

  ctx.on('inbound:message:archived', (...args: unknown[]) => {
    const data = args[0] as ArchivedPayload | undefined;
    const meta = data?.archivedMessage?.metadata as
      | { platform?: string; userId?: string; nickname?: string }
      | undefined;
    if (!meta) return;
    const { platform, userId, nickname } = meta;
    if (!platform || !userId || !nickname) return;

    const pid = `${platform}:${userId}`;
    const now = Date.now();
    const last = lastChecked.get(pid) ?? 0;
    if (now - last < THROTTLE_MS) return;
    lastChecked.set(pid, now);

    service.syncDisplayName(platform, userId, nickname).catch(err => {
      ctx.logger.debug(`[user-relation] rename-watcher 同步失败 pid=${pid}: ${err}`);
    });
  });
}
