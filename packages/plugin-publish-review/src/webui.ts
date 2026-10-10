// ============================================================
// WebUI 作品审核页：待裁决的作品（缩略图、来源、剩余时间；选中一件看自动审核的结论、图像件与文件）、审核中、
// 没发出的通知与历史。批准、拒绝与隔离预览是待裁决这一行的动作，按行 id 重新查账本，只认待裁决的作品。
//
// 渲染图与图像件按存储地址交给宿主，经 /api/media 只按位图下发；审核文件在插件数据里，界面只列名字，
// 网页作品只经隔离预览查看。账本变了（入队、审核出结论、裁决、到期）页面重取，待裁决数与账本故障发提示。
// ============================================================

import { WORK_ID_PATTERN } from '@aalis/api-publish';
import type { BoundWebui, NoticeHandle } from '@aalis/api-webui';
import type { ReviewPreviewServer } from './preview.js';
import type { PublishReviewService } from './service.js';
import type { QueueItem, ReviewStore } from './state.js';

const PAGE_KEY = 'publish-review';

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
  /** 行动作与详情按 id 重新查：只认账本里待裁决的作品；账本读取失败时裁决与预览一律停用 */
  const pendingItem = (id: string): QueueItem => {
    if (store.failure) throw new Error(store.failure);
    const item = WORK_ID_PATTERN.test(id) ? store.data.queue[id] : undefined;
    if (item?.state !== 'awaiting-owner') throw new Error('没有这件待裁决作品');
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
    title: '作品审核',
    icon: 'shield-check',
    actions: {
      approveWork: {
        label: '批准',
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (!(await service.approve(item.id))) throw new Error('作品已变更或发布失败');
          preview.revoke(item.id);
          return `已批准 ${item.title}`;
        },
      },
      rejectWork: {
        label: '拒绝',
        effect: 'destructive',
        confirm: '拒绝这件作品？来源只会收到固定类别，不会收到审核理由。',
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (!(await service.reject(item.id))) throw new Error('作品已变更，无法拒绝');
          preview.revoke(item.id);
          return `已拒绝 ${item.title}`;
        },
      },
      openPreview: {
        label: '隔离预览',
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          const item = pendingItem(rowKey);
          if (item.kind !== 'html') throw new Error('只有网页作品能隔离预览');
          let url: string;
          try {
            url = await preview.open(item.id);
          } catch {
            throw new Error('隔离预览无法启动或审核文件已变更');
          }
          page.invalidate('previews');
          return `隔离预览已打开：${url}`;
        },
      },
      retryNotice: {
        label: '重发',
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          if (store.failure) throw new Error(store.failure);
          const refused = await service.retryNotice(rowKey);
          if (refused) throw new Error(refused);
          return '已重新排队发送';
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'pending',
          title: '待裁决',
          content: [
            {
              type: 'info',
              id: 'counts',
              description: '撤下后，已打开页面且连接没断的人可能在十分钟以上仍能取到。',
              data: () => [
                { label: '待裁决', value: pending().length },
                { label: '审核中', value: queue().filter(item => item.state !== 'awaiting-owner').length },
                {
                  label: '今天提名',
                  value: store.data.nominations.filter(entry => entry.at >= now() - 86_400_000).length,
                },
                {
                  label: '已发布',
                  value: Object.values(store.data.ledger).filter(item => item.state === 'published').length,
                },
                {
                  label: '内容审核',
                  value: deps.reviewEnabled ? '开启' : '已关闭：作品通过文件处理后自动发布，不运行模型或人工内容审核',
                },
              ],
            },
            {
              type: 'table',
              id: 'pending',
              rowKey: 'id',
              empty: '没有待裁决的作品',
              columns: [
                { key: 'render', label: '渲染图', kind: 'image', primary: true },
                { key: 'title', label: '标题', primary: true },
                { key: 'kind', label: '类型' },
                { key: 'source', label: '来源' },
                { key: 'awaitingReason', label: '待人工原因' },
                { key: 'deadline', label: '剩余时间', kind: 'countdown', primary: true },
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
                    kind: item.kind === 'html' ? '网页' : '媒体',
                    html: item.kind === 'html',
                    source: item.origin.label,
                    awaitingReason:
                      item.awaitingReason === 'fallback' ? '自动审核未通过，需人工裁决' : '配置要求人工审核',
                    deadline: (item.awaitingSince ?? item.nominatedAt) + deps.ownerTimeoutHours * 3_600_000,
                  })),
              detail: [
                {
                  type: 'info',
                  id: 'verdict',
                  label: '自动审核',
                  data({ rowKey }) {
                    const review = pendingItem(rowKey).review;
                    return [
                      { label: '分类结论', value: review?.classification ?? '' },
                      { label: '标记', value: review?.flags.join('、') ?? '' },
                      { label: '理由', value: review?.reasons.join('、') ?? '' },
                    ];
                  },
                },
                {
                  type: 'table',
                  id: 'images',
                  label: '图像件',
                  rowKey: 'name',
                  empty: '没有图像件',
                  columns: [
                    { key: 'image', label: '图像', kind: 'image', primary: true },
                    { key: 'name', label: '文件名' },
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
                  label: '文件',
                  description: '网页作品只能通过「隔离预览」查看；在本机直接打开网页文件没有沙箱，可以联网。',
                  rowKey: 'path',
                  columns: [
                    { key: 'path', label: '路径', primary: true },
                    { key: 'contentType', label: '类型' },
                    { key: 'size', label: '大小（字节）' },
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
              label: '隔离预览',
              data() {
                const links = preview.active;
                return `${links.length ? links.map(link => `- [${link.id}](${link.url})`).join('\n') : '目前没有打开的预览。'}\n\n只在 Aalis 所在机器的本机浏览器能打开；远程 WebUI 的 127.0.0.1 指向你的设备。裁决后自动关闭。作品里的脚本在预览里会运行，并可能通过 WebRTC/STUN 泄露这台机器的出口地址。`;
              },
            },
          ],
        },
        {
          key: 'checking',
          title: '审核中',
          content: [
            {
              type: 'table',
              id: 'checking',
              rowKey: 'id',
              empty: '没有审核中的作品',
              columns: [
                { key: 'title', label: '标题', primary: true },
                { key: 'state', label: '步骤', primary: true },
                { key: 'id', label: '编号', kind: 'code' },
              ],
              data: () =>
                queue()
                  .filter(item => item.state !== 'awaiting-owner')
                  .map(item => ({ id: item.id, title: item.title, state: item.state })),
            },
          ],
        },
        {
          key: 'notices',
          title: '没发出的通知',
          content: [
            {
              type: 'table',
              id: 'notices',
              rowKey: 'key',
              empty: '没有放弃发送的通知',
              columns: [
                { key: 'at', label: '放弃时间', kind: 'time' },
                { key: 'title', label: '标题', primary: true },
                { key: 'room', label: '来源房间' },
                { key: 'content', label: '通知内容', kind: 'long-text', primary: true },
                { key: 'id', label: '作品编号', kind: 'code' },
              ],
              rowActions: [{ action: 'retryNotice' }],
              data: () => service.abandonedNotices(),
            },
          ],
        },
        {
          key: 'history',
          title: '历史',
          content: [
            {
              type: 'table',
              id: 'history',
              rowKey: 'key',
              empty: '还没有裁决记录',
              columns: [
                { key: 'at', label: '时间', kind: 'time', primary: true },
                { key: 'event', label: '结论', primary: true },
                { key: 'detail', label: '裁决者与理由' },
                { key: 'id', label: '编号', kind: 'code' },
              ],
              // 记录没有自己的 id，按从新到旧的次序标识
              data: () => [...store.data.history].reverse().map((entry, i) => ({ key: String(i), ...entry })),
            },
          ],
        },
      ],
    },
  });

  let waiting: NoticeHandle | undefined;
  /** 账本变了：页面重取，待裁决数（写进标题）发出或撤回提示 */
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
      title: `${count} 件作品待裁决`,
      open: { page: PAGE_KEY },
    });
  };
  store.onChange(changed);
  changed();
  if (store.failure) {
    webui.notify({
      id: 'ledger',
      level: 'error',
      title: '作品账本读取失败',
      detail: '裁决与隔离预览都已停用；修好插件数据里的账本文件后重新启用本插件',
      open: { page: PAGE_KEY },
    });
  }
}
