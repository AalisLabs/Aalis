// ============================================================
// WebUI 作品审核页：待裁决的作品（缩略图、来源、剩余时间；选中一件看自动审核的结论、图像件与文件）、审核中、
// 没发出的通知与历史。批准、拒绝与隔离预览是待裁决这一行的动作，按行 id 重新查记录，只认待裁决的作品。
//
// 渲染图与图像件按存储地址交给宿主，经 /api/media 只按位图下发；审核文件在插件数据里，界面只列名字，
// 网页作品只经隔离预览查看。记录变了（入队、审核出结论、裁决、到期）页面重取，待裁决数与记录故障发提示。
// ============================================================

import { WORK_ID_PATTERN } from '@aalis/api-publish';
import type { BoundWebui, NoticeHandle } from '@aalis/api-webui';
import { TextError, type TextRef, textLines } from '@aalis/schema-i18n';
import { reasonText } from './policy.js';
import type { ReviewPreviewServer } from './preview.js';
import type { PublishReviewService } from './service.js';
import type { QueueItem, ReviewStore } from './state.js';
import { t } from './texts.js';

const PAGE_KEY = 'publish-review';

/** 还没到待裁决的作品：审核中的步骤 */
type InReview = QueueItem & { state: Exclude<QueueItem['state'], 'awaiting-owner'> };
/** 审核中的步骤的显示名（存储里的值照旧；记录读回时只认这两种） */
const STEPS: Record<InReview['state'], TextRef> = { queued: t('stepQueued'), checking: t('stepChecking') };
/** 历史结论的显示名（存储里的值照旧） */
const EVENTS: Readonly<Record<string, TextRef>> = {
  nominated: t('eventNominated'),
  'awaiting-owner': t('awaitingOwner'),
  approved: t('eventApproved'),
  published: t('published'),
  rejected: t('eventRejected'),
  expired: t('eventExpired'),
  failed: t('eventFailed'),
  withdrawn: t('eventWithdrawn'),
  'integrity-failed': t('integrityCheckFailed'),
  live: t('eventLive'),
  'notice-delayed': t('eventNoticeDelayed'),
  'notice-abandoned': t('eventNoticeAbandoned'),
  'notice-retry': t('eventNoticeRetry'),
};
/** 审核标记的显示名（存储里的值照旧） */
const FLAG_NAMES: Readonly<Record<string, TextRef>> = {
  活动内容: t('flagActive'),
  外链: t('flagExternalLink'),
  表单: t('flagForm'),
  密码框: t('flagPassword'),
};
/** 落盘值的显示名：记录读回时不核这些值，表里没有的显示原值 */
const nameIn = (names: Readonly<Record<string, TextRef>>, value: string): string | TextRef =>
  Object.hasOwn(names, value) ? names[value] : value;

export function registerReviewPage(deps: {
  webui: BoundWebui;
  service: PublishReviewService;
  store: ReviewStore;
  preview: ReviewPreviewServer;
  ownerTimeoutHours: number;
  reviewEnabled: boolean;
  now?: () => number;
}): void {
  const { webui, service, store, preview } = deps;
  const now = deps.now ?? Date.now;
  const queue = () => Object.values(store.data.queue);
  const pending = () => queue().filter(item => item.state === 'awaiting-owner');
  const inReview = () => queue().filter((item): item is InReview => item.state !== 'awaiting-owner');
  /** 行动作与详情按 id 重新查：只认记录里待裁决的作品；记录读取失败时裁决与预览一律停用 */
  const pendingItem = (id: string): QueueItem => {
    if (store.failure) throw new TextError(store.failure);
    const item = WORK_ID_PATTERN.test(id) ? store.data.queue[id] : undefined;
    if (item?.state !== 'awaiting-owner') throw new TextError(t('workNotPending'));
    return item;
  };
  const renderOf = (item: QueueItem) =>
    item.review?.hasRender
      ? store.item(item.id, 'review/render.png')
      : item.thumbnailHash
        ? store.item(item.id, 'out/_thumb.png')
        : undefined;

  const page = webui.definePage({
    key: PAGE_KEY,
    title: t('displayName'),
    icon: 'shield-check',
    actions: {
      approveWork: {
        label: t('approveLabel'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (!(await service.approve(item.id))) throw new TextError(t('approveFailed'));
          preview.revoke(item.id);
          return t('approvedWork', { title: item.title });
        },
      },
      rejectWork: {
        label: t('rejectLabel'),
        effect: 'destructive',
        confirm: t('rejectConfirm'),
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (!(await service.reject(item.id))) throw new TextError(t('rejectFailed'));
          preview.revoke(item.id);
          return t('rejectedWork', { title: item.title });
        },
      },
      openPreview: {
        label: t('preview'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (item.kind !== 'html') throw new TextError(t('previewHtmlOnly'));
          let url: string;
          try {
            url = await preview.open(item.id);
          } catch {
            throw new TextError(t('previewFailed'));
          }
          page.invalidate('previews');
          return t('previewOpened', { url });
        },
      },
      retryNotice: {
        label: t('retryLabel'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          if (store.failure) throw new TextError(store.failure);
          const refused = await service.retryNotice(rowKey);
          if (refused) throw new TextError(refused);
          return t('retryQueued');
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'pending',
          title: t('awaitingOwner'),
          content: [
            {
              type: 'info',
              id: 'counts',
              description: t('countsDescription'),
              data: () => [
                { label: t('awaitingOwner'), value: pending().length },
                { label: t('inReview'), value: inReview().length },
                {
                  label: t('nominatedToday'),
                  value: store.data.nominations.filter(entry => entry.at >= now() - 86_400_000).length,
                },
                {
                  label: t('published'),
                  value: Object.values(store.data.ledger).filter(item => item.state === 'published').length,
                },
                { label: t('contentReview'), value: deps.reviewEnabled ? t('on') : t('reviewOffDescription') },
              ],
            },
            {
              type: 'table',
              id: 'pending',
              rowKey: 'id',
              empty: t('pendingEmpty'),
              columns: [
                { key: 'render', label: t('columnRender'), kind: 'image', primary: true },
                { key: 'title', label: t('columnTitle'), primary: true },
                { key: 'kind', label: t('columnKind') },
                { key: 'source', label: t('columnSource') },
                { key: 'awaitingReason', label: t('columnAwaitingReason') },
                { key: 'deadline', label: t('columnDeadline'), kind: 'countdown', primary: true },
              ],
              rowActions: [
                { action: 'approveWork' },
                { action: 'rejectWork' },
                { action: 'openPreview', visibleWhen: 'html' },
              ],
              data: () =>
                pending()
                  .sort((a, b) => (a.awaitingSince ?? a.nominatedAt) - (b.awaitingSince ?? b.nominatedAt))
                  .map(item => ({
                    id: item.id,
                    render: renderOf(item),
                    title: item.title,
                    kind: item.kind === 'html' ? t('kindHtml') : t('kindMedia'),
                    html: item.kind === 'html',
                    source: item.origin.label,
                    awaitingReason: item.awaitingReason === 'fallback' ? t('awaitingFallback') : t('awaitingRequired'),
                    deadline: (item.awaitingSince ?? item.nominatedAt) + deps.ownerTimeoutHours * 3_600_000,
                  })),
              detail: [
                {
                  type: 'info',
                  id: 'verdict',
                  label: t('autoReview'),
                  data({ rowKey }) {
                    const review = pendingItem(rowKey).review;
                    return [
                      { label: t('classification'), value: review?.classification ?? '' },
                      {
                        label: t('flags'),
                        value: review ? t('list', { items: review.flags.map(flag => nameIn(FLAG_NAMES, flag)) }) : '',
                      },
                      {
                        label: t('reasons'),
                        value: review ? t('list', { items: review.reasons.map(reasonText) }) : '',
                      },
                    ];
                  },
                },
                {
                  type: 'table',
                  id: 'images',
                  label: t('images'),
                  rowKey: 'name',
                  empty: t('imagesEmpty'),
                  columns: [
                    { key: 'image', label: t('columnImage'), kind: 'image', primary: true },
                    { key: 'name', label: t('columnFileName') },
                  ],
                  data({ rowKey }) {
                    const item = pendingItem(rowKey);
                    return (item.review?.images ?? []).map(name => ({
                      name,
                      image: store.item(item.id, `review/${name}`),
                    }));
                  },
                },
                {
                  type: 'table',
                  id: 'files',
                  label: t('files'),
                  description: t('filesDescription'),
                  rowKey: 'path',
                  columns: [
                    { key: 'path', label: t('columnPath'), primary: true },
                    { key: 'contentType', label: t('columnKind') },
                    { key: 'size', label: t('columnSize') },
                  ],
                  data: ({ rowKey }) =>
                    pendingItem(rowKey).files.map(file => ({
                      path: file.path,
                      contentType: file.contentType,
                      size: file.size,
                    })),
                },
              ],
            },
            {
              type: 'markdown',
              id: 'previews',
              label: t('preview'),
              data() {
                const links = preview.active;
                return t('previewsNote', {
                  links: links.length ? textLines(links.map(link => t('previewLink', link))) : t('noPreviews'),
                });
              },
            },
          ],
        },
        {
          key: 'checking',
          title: t('inReview'),
          content: [
            {
              type: 'table',
              id: 'checking',
              rowKey: 'id',
              empty: t('checkingEmpty'),
              columns: [
                { key: 'title', label: t('columnTitle'), primary: true },
                { key: 'state', label: t('columnStep'), primary: true },
                { key: 'id', label: t('columnId'), kind: 'code' },
              ],
              data: () => inReview().map(item => ({ id: item.id, title: item.title, state: STEPS[item.state] })),
            },
          ],
        },
        {
          key: 'notices',
          title: t('noticesTab'),
          content: [
            {
              type: 'table',
              id: 'notices',
              rowKey: 'key',
              empty: t('noticesEmpty'),
              columns: [
                { key: 'at', label: t('columnAbandonedAt'), kind: 'time' },
                { key: 'title', label: t('columnTitle'), primary: true },
                { key: 'room', label: t('columnRoom') },
                { key: 'content', label: t('columnNoticeContent'), kind: 'long-text', primary: true },
                { key: 'id', label: t('columnWorkId'), kind: 'code' },
              ],
              rowActions: [{ action: 'retryNotice' }],
              data: () => service.abandonedNotices(),
            },
          ],
        },
        {
          key: 'history',
          title: t('historyTab'),
          content: [
            {
              type: 'table',
              id: 'history',
              rowKey: 'key',
              empty: t('historyEmpty'),
              columns: [
                { key: 'at', label: t('columnTime'), kind: 'time', primary: true },
                { key: 'event', label: t('columnVerdict'), primary: true },
                { key: 'detail', label: t('columnDetail') },
                { key: 'id', label: t('columnId'), kind: 'code' },
              ],
              // 记录没有自己的 id，按从新到旧的次序标识；只取显示的几栏，撤下的一方与理由不发到前端
              data: () =>
                [...store.data.history].reverse().map((entry, i) => ({
                  key: String(i),
                  at: entry.at,
                  id: entry.id,
                  event: nameIn(EVENTS, entry.event),
                  detail: entry.detail,
                })),
            },
          ],
        },
      ],
    },
  });

  let waiting: NoticeHandle | undefined;
  /** 记录变了：页面重取，待裁决数（写进标题）发出或撤回提示 */
  const changed = () => {
    page.invalidate();
    const count = pending().length;
    if (count === 0) {
      waiting?.clear();
      waiting = undefined;
      return;
    }
    waiting = webui.notify({
      id: 'pending',
      level: 'action',
      title: t('pendingNotice', { count }),
      open: { page: PAGE_KEY },
    });
  };
  store.onChange(changed);
  changed();
  if (store.failure) {
    webui.notify({
      id: 'ledger',
      level: 'error',
      title: t('ledgerNoticeTitle'),
      detail: t('ledgerNoticeDetail'),
      open: { page: PAGE_KEY },
    });
  }
}
