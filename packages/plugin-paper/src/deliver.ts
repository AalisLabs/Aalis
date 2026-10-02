// ============================================================
// 把白纸成品发回发起房间：paper_send 与「自动发布在提交前失败」时的直接发送共用
//
// 类型按白名单：位图与 MP4 按 sendMediaMaxMB、单个 HTML 按 sendHtml 与大小上限，位图走 image、MP4 走 video、
// HTML 走 file，远端给的原扩展名须与按文件头判定的类型一致。文件名由宿主按任务名重写，附件指向白纸根里宿主命名的
// 文件。等平台适配器确认收下（awaitDelivery）才记已交付：没有适配器接手、发送失败都不记；平台报结果未知（可能已经
// 送达）时把这次发出的成品记为结果未知，报「请勿重发」；等不到确认（等满或回合中止）时同样当场记下、报「未确认，
// 请勿重发」，迟到的结果到了再结算：成功补记已交付，确定失败撤掉这几件的结果未知。结果未知按成品记，同一任务的其他
// 成品照常可发。插件停了（如被重载）就不再写账本，免得旧实例整份写盘盖掉新实例的账本。
// ============================================================

import type { GatewayService } from '@aalis/api-gateway';
import type { Events, Logger, ServiceRef } from '@aalis/core';
import { awaitDelivery, type OutgoingMessage } from '@aalis/schema-message';
import { artifactUri, EXTENSIONS, MIME_TYPES } from './artifacts.js';
import type { PaperConfig } from './config.js';
import type { LedgerStore, TaskRecord } from './ledger.js';
import { describe, formatSize } from './util.js';

const MAX_NAME = 40;

export type Artifact = TaskRecord['artifacts'][number];
type SendableType = Exclude<Artifact['type'], 'other'>;

/** 各类型认的原扩展名：远端给的文件名与按文件头判定的类型不一致时不发 */
const TYPE_EXTENSIONS: Record<SendableType, readonly string[]> = {
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  mp4: ['mp4'],
  html: ['html', 'htm'],
};

/** 不发的成品按原扩展名说明原因 */
const REFUSED_EXTENSIONS: ReadonlyArray<{ exts: readonly string[]; reason: string }> = [
  {
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
    reason: '压缩包（包括工程包）不发，里面可能夹带可执行文件',
  },
  { exts: ['exe', 'dll', 'so', 'dylib', 'com', 'scr', 'jar'], reason: '可执行文件不发' },
  { exts: ['msi', 'dmg', 'pkg', 'apk', 'ipa', 'deb', 'rpm', 'appimage'], reason: '安装包不发' },
  {
    exts: ['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'mjs', 'cjs', 'py', 'rb', 'pl', 'php'],
    reason: '脚本不发，打开就可能被执行',
  },
  { exts: ['lnk', 'url', 'webloc', 'desktop'], reason: '快捷方式不发，它可能指向别的程序或网址' },
  { exts: ['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam'], reason: '带宏的 Office 文档不发' },
  { exts: ['svg', 'svgz'], reason: 'SVG 能内嵌脚本，不发；要图请让远端另导出 PNG' },
];

/** 远端给的相对路径里文件名的扩展名（小写，没有则为空串） */
function extensionOf(rel: string): string {
  const base = rel.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 这件成品能不能发；不能时返回原因 */
export function sendRefusal(artifact: Artifact, cfg: PaperConfig): string | undefined {
  const ext = extensionOf(artifact.rel);
  if (artifact.type === 'other') {
    const refused = REFUSED_EXTENSIONS.find(r => r.exts.includes(ext));
    return refused?.reason ?? '只发 PNG、JPEG、GIF、WebP 图片、MP4 视频与单个 HTML 网页，这件成品不是这几种';
  }
  if (artifact.type === 'html') {
    if (!cfg.sendHtml) return 'owner 没有开启发送网页（sendHtml），这件成品不发';
    if (artifact.sizeBytes > cfg.sendHtmlMaxBytes) {
      return `网页 ${formatSize(artifact.sizeBytes)}，超过发送上限 ${formatSize(cfg.sendHtmlMaxBytes)}`;
    }
  } else if (artifact.sizeBytes > cfg.sendMediaMaxBytes) {
    const what = artifact.type === 'mp4' ? '视频' : '图片';
    return `${what} ${formatSize(artifact.sizeBytes)}，超过发送上限 ${formatSize(cfg.sendMediaMaxBytes)}（聊天平台只内联发得出这么大的媒体）`;
  }
  if (!TYPE_EXTENSIONS[artifact.type].includes(ext)) {
    return `原文件的扩展名（${ext ? `.${ext}` : '无'}）与文件内容（${artifact.type}）不一致，不发`;
  }
  return undefined;
}

/**
 * 发出去的文件名：任务名去掉控制与格式字符（含双向控制符、零宽字符）、路径分隔符与 :*?"<>|，
 * 首尾去点和空格，截到 40 字；空了用 aalis-paper
 */
function fileBaseName(name: string): string {
  const trim = (s: string) => s.replace(/^[.\s]+|[.\s]+$/gu, '');
  const cleaned = trim(name.replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, ''));
  return trim([...cleaned].slice(0, MAX_NAME).join('')) || 'aalis-paper';
}

/**
 * 原始成品能不能直接发回聊天：私下交付的任务（没有发布意图）可以；自动发布因发布环节本身的问题（挑不出成品、
 * 目标未获准、24 小时没能提交）在提交之前失败的也可以。审核没通过的（含发布检查不通过、驳回、撤下）不发出去，
 * 没通过之后重新提名、再失败的也不发；已提交给发布服务的以作品链接交付。
 */
export function rawDeliveryAllowed(task: TaskRecord): boolean {
  const pub = task.publication;
  return !pub || (pub.state === 'failed' && !pub.workId && pub.directSend === true && !pub.reviewRefused);
}

/**
 * 创作完成、自动发布在提交给发布服务之前失败（没有作品编号）：完成通知报这个结果，paper_status 列出成品编号供
 * 重新提名。发布协调器清通知标记的条件必须与完成通知的筛选一致，两处都用它
 */
export function failedBeforeSubmission(task: TaskRecord): boolean {
  return task.state === 'done' && task.publication?.state === 'failed' && !task.publication.workId;
}

interface DeliverDeps {
  ledger: LedgerStore;
  gateway: ServiceRef<GatewayService>;
  events: Events;
  logger: Logger;
  /** 插件的生命周期信号：停了就不再写账本 */
  signal: AbortSignal;
}

export type DeliveryOutcome = { ok: true } | { ok: false; error: string; unconfirmed?: true };

/** 经网关发出；网关不在场时改走 outbound:message 事件（出站中间件链被跳过） */
async function dispatch(deps: DeliverDeps, message: OutgoingMessage): Promise<void> {
  const gateway = deps.gateway.current;
  if (gateway) {
    await gateway.dispatchOutbound(message);
    return;
  }
  deps.logger.warn('gateway 服务不在场，白纸出站改走 outbound:message 事件（出站中间件链被跳过）');
  await deps.events.emit('outbound:message', message);
}

/**
 * 把这件任务的几件成品作为一条消息发回发起房间，等平台确认。调用方先用 {@link sendRefusal} 筛过；
 * wait 是等确认的中止信号（工具用这一回合的，直接发送用插件的）；callId 是经工具发送时那次调用的 id，
 * 会话的客户端据此给工具卡标「已发到群」
 */
export async function deliverArtifacts(
  deps: DeliverDeps,
  task: TaskRecord,
  artifacts: readonly Artifact[],
  wait: AbortSignal | undefined,
  callId?: string,
): Promise<DeliveryOutcome> {
  const message: OutgoingMessage = {
    sessionId: task.room,
    platform: task.platform,
    content: '',
    attachments: artifacts.map(artifact => {
      const type = artifact.type as SendableType;
      return {
        kind: type === 'mp4' ? ('video' as const) : type === 'html' ? ('file' as const) : ('image' as const),
        data: artifactUri(task.paperId, task.id, artifact),
        name: `${fileBaseName(task.name)}.${EXTENSIONS[type]}`,
        mimeType: MIME_TYPES[type],
      };
    }),
    source: 'agent',
    ...(callId ? { callId } : {}),
  };
  try {
    await dispatch(deps, message);
  } catch (err) {
    return { ok: false, error: `没有发出：${describe(err)}` };
  }
  // 平台确认收下才算交付：交给网关不等于发出，适配器下载或上传失败时 delivery 结算为失败
  const delivery = message.delivery;
  if (!delivery) return { ok: false, error: '没有平台适配器接手这条消息，成品没有发出' };
  const { ledger } = deps;
  const sentIds = artifacts.map(a => a.id);
  /**
   * 按这次发出的几件成品记账：平台确认收下记已交付，并把这几件从结果未知里撤掉；报结果未知或等不到确认把这几件并进
   * unknownArtifacts（paper_send 不再发这几件；非空时待交付提示不再列这件任务）；等不到确认之后迟到的确定失败只撤掉
   * 这几件。任务已有成品交付过也照样记，账本没有变化时不写盘
   */
  const record = (outcome: 'delivered' | 'unknown' | 'failed') =>
    ledger.exclusive(async () => {
      // 插件已停（如被重载）时不再写：旧实例整份写盘会盖掉新实例已写进去的账本
      if (deps.signal.aborted) return;
      const current = ledger.data.tasks[task.id];
      if (!current) return;
      const before = current.unknownArtifacts ?? [];
      const unknown =
        outcome === 'unknown' ? [...new Set([...before, ...sentIds])] : before.filter(id => !sentIds.includes(id));
      const newlyDelivered = outcome === 'delivered' && !current.delivered;
      if (!newlyDelivered && unknown.length === before.length) return;
      if (newlyDelivered) current.delivered = true;
      if (unknown.length > 0) current.unknownArtifacts = unknown;
      else delete current.unknownArtifacts;
      const what = { delivered: '已交付', unknown: '结果未知', failed: '撤掉结果未知' }[outcome];
      await ledger.save().catch(err => deps.logger.error(`白纸账本写入失败（${what}标记）: ${describe(err)}`));
    });
  const result = await awaitDelivery(delivery, wait);
  if (!result) {
    // 等满或回合中止：可能已经送达，当场按结果未知记下；迟到的结果到了再结算
    await record('unknown');
    void delivery.then(
      late => (late.ok ? record('delivered') : late.unconfirmed ? undefined : record('failed')),
      () => undefined,
    );
    return { ok: false, error: '成品仍在发送，结果未确认，请勿重发', unconfirmed: true };
  }
  if (!result.ok) {
    if (!result.unconfirmed) return { ok: false, error: `发送失败：${result.error}` };
    await record('unknown');
    return { ok: false, error: '成品发送结果未知（可能已经送达），请勿重发', unconfirmed: true };
  }
  await record('delivered');
  return { ok: true };
}
