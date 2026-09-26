import { describe, expect, it } from 'vitest';
import type { Logger } from '../../packages/core/src/index.js';
import { waitForAttachmentDescriptions } from '../../packages/plugin-trigger-laya/src/attachments.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// plugin-trigger-laya 判定前等附件识别：带附件、尚无描述时启动识别，最多等 mediaWaitMs，
// 超时照常返回、识别在后台继续，识别失败只记 warn。
// ════════════════════════════════════════════════════════════

function recordingLogger() {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m), info: () => {}, debug: () => {} } as unknown as Logger;
  return { logger, warns };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('waitForAttachmentDescriptions', () => {
  const image = (extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
    content: '看图',
    platform: 'onebot',
    sessionId: 'onebot:10000:group:20001',
    attachments: [{ kind: 'image', data: 'https://example.invalid/a.jpg' }],
    ...extra,
  });

  function fakeMedia(finish: () => Promise<void> = async () => {}) {
    const calls: IncomingMessage[] = [];
    const svc = {
      async processMessage(msg: IncomingMessage) {
        calls.push(msg);
        await finish();
        msg._attachmentDescriptions = ['[图片: 一只猫]'];
        return { total: 1, successCount: 1, items: [] };
      },
    };
    return { ref: { current: svc as never }, calls };
  }

  it('识别在上限内写好描述：等到描述', async () => {
    const { ref, calls } = fakeMedia(() => sleep(5));
    const m = image();
    await waitForAttachmentDescriptions(m, ref, 1000, recordingLogger().logger);
    expect(calls).toEqual([m]);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('没有 media、没有附件、已有描述：不启动识别，立即返回', async () => {
    const { ref, calls } = fakeMedia();
    const { logger } = recordingLogger();
    await waitForAttachmentDescriptions(image(), { current: undefined }, 1000, logger);
    await waitForAttachmentDescriptions(image({ attachments: [] }), ref, 1000, logger);
    await waitForAttachmentDescriptions(image({ _attachmentDescriptions: ['[图片: 早就有了]'] }), ref, 1000, logger);
    expect(calls).toHaveLength(0);
  });

  it('超过上限照常返回，识别在后台继续写到同一个消息对象上', async () => {
    const gate = deferred();
    const { ref } = fakeMedia(() => gate.promise);
    const m = image();
    await waitForAttachmentDescriptions(m, ref, 20, recordingLogger().logger);
    expect(m._attachmentDescriptions).toBeUndefined();
    gate.resolve();
    await sleep(5);
    expect(m._attachmentDescriptions).toEqual(['[图片: 一只猫]']);
  });

  it('识别失败：记 warn，不抛错', async () => {
    const { logger, warns } = recordingLogger();
    const failing = {
      current: {
        processMessage: async () => {
          throw new Error('识别模型不可用');
        },
      } as never,
    };
    await expect(waitForAttachmentDescriptions(image(), failing, 1000, logger)).resolves.toBeUndefined();
    expect(warns).toEqual(['[laya] 附件识别失败: Error: 识别模型不可用']);
  });
});
