import { basename } from 'node:path';
import { WORK_ID_PATTERN } from '@aalis/api-publish';
import type { StorageService } from '@aalis/api-storage';
import type { BoundWebui, WebuiFilePayload, WebuiPage } from '@aalis/api-webui';
import { detectMediaFormat } from '@aalis/util-media-signature';
import type { ReviewPreviewServer } from './preview.js';
import type { PublishReviewService } from './service.js';
import { ITEM_ROOT, type QueueItem, type ReviewStore } from './state.js';

const OCTET_STREAM = 'application/octet-stream';
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  GIF: 'image/gif',
  WebP: 'image/webp',
};
const fail = (error: string) => ({ ok: false as const, error });
const bytes = (raw: string | Buffer) => new Uint8Array(Buffer.from(raw));
const sha256 = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

const PAGE: WebuiPage = {
  key: 'publish-review',
  label: '作品审核',
  order: 55,
  refresh: 30,
  content: [
    { type: 'stat', label: '待裁决', source: 'reviewPendingCount' },
    { type: 'stat', label: '审核中', source: 'reviewCheckingCount' },
    { type: 'stat', label: '今天提名', source: 'reviewTodayCount' },
    { type: 'stat', label: '已发布', source: 'reviewPublishedCount' },
    { type: 'markdown', source: 'reviewStatus' },
    {
      type: 'tabs',
      items: [
        {
          key: 'pending',
          label: '待裁决',
          content: [
            {
              type: 'table',
              source: 'reviewPending',
              columns: [
                { key: 'render', label: '渲染图', render: 'image', method: 'reviewReadRender' },
                { key: 'title', label: '标题' },
                { key: 'kind', label: '类型' },
                { key: 'source', label: '来源' },
                { key: 'awaitingReason', label: '待人工原因' },
                { key: 'flags', label: '标记', render: 'expandable-text' },
                { key: 'classification', label: '分类结论', render: 'expandable-text' },
                { key: 'reasons', label: '自动审核理由', render: 'expandable-text' },
                { key: 'deadline', label: '剩余时间', render: 'countdown' },
              ],
              actions: [
                { label: '批准', method: 'reviewApprove', confirm: '批准并发布这件作品？' },
                {
                  label: '拒绝',
                  method: 'reviewReject',
                  danger: true,
                  confirm: '拒绝这件作品？来源只会收到固定类别，不会收到审核理由。',
                },
                { label: '隔离预览', method: 'reviewOpenPreview' },
              ],
            },
          ],
        },
        {
          key: 'images',
          label: '图像件',
          content: [
            {
              type: 'table',
              source: 'reviewImages',
              columns: [
                { key: 'title', label: '作品' },
                { key: 'image', label: '图像件', render: 'image', method: 'reviewReadImage' },
              ],
            },
          ],
        },
        {
          key: 'files',
          label: '文件',
          content: [
            { type: 'markdown', source: 'reviewFileAdvice' },
            {
              type: 'table',
              source: 'reviewFiles',
              columns: [
                { key: 'title', label: '作品' },
                { key: 'kind', label: '类型' },
                { key: 'filePath', label: '文件', render: 'file', method: 'reviewReadFile' },
              ],
            },
          ],
        },
        {
          key: 'checking',
          label: '审核中',
          content: [
            {
              type: 'table',
              source: 'reviewChecking',
              columns: [
                { key: 'id', label: '编号' },
                { key: 'title', label: '标题' },
                { key: 'state', label: '步骤' },
              ],
            },
          ],
        },
        {
          key: 'history',
          label: '历史',
          content: [
            {
              type: 'table',
              source: 'reviewHistory',
              columns: [
                { key: 'at', label: '时间' },
                { key: 'id', label: '编号' },
                { key: 'event', label: '结论' },
                { key: 'detail', label: '裁决者与理由' },
              ],
            },
          ],
        },
      ],
    },
    { type: 'markdown', source: 'reviewPreviewLinks' },
  ],
};

export function registerReviewPage(deps: {
  webui: BoundWebui;
  service: PublishReviewService;
  store: ReviewStore;
  storage: StorageService;
  preview: ReviewPreviewServer;
  ownerTimeoutHours: number;
  now?: () => number;
}): void {
  const { webui, service, store, storage, preview } = deps;
  const now = deps.now ?? Date.now;
  const queue = () => Object.values(store.data.queue);
  const pending = () => queue().filter(item => item.state === 'awaiting-owner');
  const known = (raw: unknown): QueueItem | undefined => {
    if (typeof raw !== 'string' || !WORK_ID_PATTERN.test(raw) || store.failure) return undefined;
    const item = store.data.queue[raw];
    return item?.state === 'awaiting-owner' ? item : undefined;
  };
  const action = (method: string, run: (args: Record<string, unknown>) => Promise<unknown>) =>
    webui.registerAction(method, args => (store.failure ? Promise.resolve(fail(store.failure)) : run(args)));
  const payload = (name: string, data: Uint8Array, declared?: string): WebuiFilePayload => {
    const format = detectMediaFormat(data)?.format;
    const mime = format && IMAGE_TYPES[format] && declared?.startsWith('image/') ? IMAGE_TYPES[format] : OCTET_STREAM;
    return { name: basename(name), mime, base64: Buffer.from(data).toString('base64') };
  };
  const readOutput = async (item: QueueItem, path: string): Promise<Uint8Array> => {
    const expected = item.outHashes?.[path];
    if (!expected || !item.files.some(file => file.path === path)) throw new Error('审核文件不存在');
    const data = bytes(await storage.readFile(`${ITEM_ROOT}/${item.id}/out/${path}`));
    if ((await sha256(data)) !== expected) throw new Error('审核文件完整性核对失败');
    return data;
  };

  webui.registerPage(PAGE);
  webui.registerAction('reviewPendingCount', async () => ({ value: pending().length }));
  webui.registerAction('reviewCheckingCount', async () => ({
    value: queue().filter(item => item.state === 'checking').length,
  }));
  webui.registerAction('reviewTodayCount', async () => ({
    value: store.data.nominations.filter(entry => entry.at >= now() - 86_400_000).length,
  }));
  webui.registerAction('reviewPublishedCount', async () => ({
    value: Object.values(store.data.ledger).filter(item => item.state === 'published').length,
  }));
  webui.registerAction('reviewStatus', async () => ({
    content: store.failure
      ? `**作品账本读取失败，所有裁决和预览已停用。** ${store.failure}`
      : '撤下后，已打开页面且连接没断的人可能在十分钟以上仍能取到。',
  }));
  webui.registerAction('reviewPending', async () =>
    pending()
      .sort((a, b) => (a.awaitingSince ?? a.nominatedAt) - (b.awaitingSince ?? b.nominatedAt))
      .map(item => ({
        id: item.id,
        title: item.title,
        kind: item.kind === 'html' ? '网页' : '媒体',
        source: item.origin.label,
        awaitingReason: item.awaitingReason === 'fallback' ? '自动审核未通过，需人工裁决' : '配置要求人工审核',
        render: item.review?.hasRender ? `${item.id}/render.png` : item.thumbnailHash ? `${item.id}/thumb.png` : '',
        flags: item.review?.flags.join('、') ?? '',
        classification: item.review?.classification ?? '',
        reasons: item.review?.reasons.join('、') ?? '',
        deadline: (item.awaitingSince ?? item.nominatedAt) + deps.ownerTimeoutHours * 3_600_000,
      })),
  );
  webui.registerAction('reviewImages', async () =>
    pending().flatMap(item => (item.review?.images ?? []).map(image => ({ id: item.id, title: item.title, image }))),
  );
  webui.registerAction('reviewFiles', async () =>
    pending().flatMap(item =>
      item.files.map(file => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        filePath: file.path,
      })),
    ),
  );
  webui.registerAction('reviewChecking', async () =>
    queue()
      .filter(item => item.state !== 'awaiting-owner')
      .map(item => ({ id: item.id, title: item.title, state: item.state })),
  );
  webui.registerAction('reviewHistory', async () => [...(store.data.history ?? [])].reverse().slice(0, 100));
  webui.registerAction('reviewFileAdvice', async () => ({
    content: '网页作品只能通过「隔离预览」查看。不要在本机直接打开下载的网页文件：直接打开时没有沙箱，可以联网。',
  }));
  webui.registerAction('reviewPreviewLinks', async () => {
    const links = preview.active;
    return {
      content: `### 隔离预览\n${links.length ? links.map(link => `- [${link.id}](${link.url})`).join('\n') : '目前没有打开的预览。'}\n\n只在 Aalis 所在机器的本机浏览器能打开；远程 WebUI 的 127.0.0.1 指向你的设备。裁决后自动关闭。作品里的脚本在预览里会运行，并可能通过 WebRTC/STUN 泄露这台机器的出口地址。`,
    };
  });
  webui.registerAction('reviewReadRender', async args => {
    const item = known(args.id);
    if (!item) return fail('没有这件待裁决作品');
    try {
      if (item.kind === 'html' && item.review?.hasRender) {
        const data = bytes(await storage.readFile(`${ITEM_ROOT}/${item.id}/review/render.png`));
        return payload('render.png', data, 'image/png');
      }
      if (!item.thumbnailHash) return fail('没有渲染图');
      const data = bytes(await storage.readFile(`${ITEM_ROOT}/${item.id}/out/_thumb.png`));
      if ((await sha256(data)) !== item.thumbnailHash) return fail('缩略图完整性核对失败');
      return payload('thumb.png', data, 'image/png');
    } catch {
      return fail('渲染图读取失败');
    }
  });
  webui.registerAction('reviewReadImage', async args => {
    const item = known(args.id);
    const image = args.image;
    if (
      !item ||
      typeof image !== 'string' ||
      !/^[A-Za-z0-9._-]+\.png$/.test(image) ||
      !item.review?.images.includes(image)
    )
      return fail('没有这张审核图像');
    try {
      const data = bytes(await storage.readFile(`${ITEM_ROOT}/${item.id}/review/${image}`));
      return payload(image, data, 'image/png');
    } catch {
      return fail('审核图像读取失败');
    }
  });
  webui.registerAction('reviewReadFile', async args => {
    const item = known(args.id);
    const path = args.filePath;
    if (!item || typeof path !== 'string') return fail('没有这件待裁决作品');
    const file = item.files.find(entry => entry.path === path);
    if (!file) return fail('审核文件不存在');
    try {
      return payload(path, await readOutput(item, path), file.contentType);
    } catch {
      return fail('审核文件读取或完整性核对失败');
    }
  });
  action('reviewApprove', async args => {
    const item = known(args.id);
    if (!item) return fail('没有这件待裁决作品');
    const ok = await service.approve(item.id);
    if (!ok) return fail('作品已变更或发布失败');
    preview.revoke(item.id);
    return { ok: true as const, message: '已批准' };
  });
  action('reviewReject', async args => {
    const item = known(args.id);
    if (!item) return fail('没有这件待裁决作品');
    const ok = await service.reject(item.id);
    if (!ok) return fail('作品已变更，无法拒绝');
    preview.revoke(item.id);
    return { ok: true as const, message: '已拒绝' };
  });
  action('reviewOpenPreview', async args => {
    const item = known(args.id);
    if (!item || item.kind !== 'html') return fail('没有这件待裁决网页作品');
    try {
      return { ok: true as const, message: await preview.open(item.id) };
    } catch {
      return fail('隔离预览无法启动或审核文件已变更');
    }
  });
}
