import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import { createStorageGateway, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, type ServiceRef } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 合并转发媒体落盘必须按 URI 路由到 data 根，不能只拿 storage 胜者。
//
// storage-local 按根逐条提供，没有偏好时胜者是第一个登记的根（默认配置下是 workspace），
// 它拒绝别的根的 URI。展开器曾取 `storage.current` 写 `data:/images/...`：写入抛错被
// 下载阶段的 try 吞掉，回退原始 src——转发里的图片仍按会过期的 rkey URL 排队识别。
// 单根假 storage 接受任意 URI，测不出这条；这里用真实 storage-local 配多根。
// ════════════════════════════════════════════════════════════

const CFG: ForwardConfig = {
  enabled: true,
  maxDepth: 3,
  maxNodesPerLevel: 30,
  imageRecognition: true,
  imageRecognitionConcurrency: 2,
  recognitionMaxItems: 32,
  summarize: false,
  summaryMaxChars: 500,
  summaryInputLimit: 0,
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PNG_DATA_URI = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

const logger: Logger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  child: () => logger,
};

describe('合并转发媒体落盘按 URI 路由（真实 storage-local 多根）', () => {
  let base: string;
  let app: App;
  let storageRef: ServiceRef<StorageService>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-onebot-fwd-roots-'));
    const root = (name: string) => ({
      name,
      path: join(base, name),
      label: name,
      kind: name,
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    });
    app = new App({ name: 'T', logLevel: 'error' });
    // workspace 排第一：与默认配置同序，胜者即 workspace
    await app.plugins.register(storageLocalPlugin, { roots: [root('workspace'), root('data'), root('tmp')] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocalPlugin.name)?.state, 'storage-local 未激活').toBe('active');
    storageRef = app.bind({ storage }).storage;
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('workspace 排第一时，转发内图片落盘到 data 根，识别拿到落盘 ref 而非原始 src', async () => {
    // 前提锚：胜者是 workspace 根且写不了 data:/。夹具若改成单根或换了顺序，本用例就测不到这条
    const winner = storageRef.require();
    expect(winner.listRoots().map(r => r.name)).toEqual(['workspace']);
    await expect(winner.writeFile('data:/probe.txt', 'x')).rejects.toThrow();

    const described: string[] = [];
    const media: Partial<MediaService> = {
      describeImage: async (src: string) => {
        described.push(src);
        return '述';
      },
    };
    const expander = createForwardExpander<null>({
      logger,
      memory: fixedRef<MemoryService>(undefined),
      media: fixedRef(media as MediaService),
      llm: fixedRef<LLMModel>(undefined),
      storage: createStorageGateway(storageRef),
      // data URI 源的落盘不经 process，只需在场
      processService: fixedRef({} as ProcessService),
      forwardCfg: CFG,
      attachmentMaxBytes: 1024 * 1024,
      sendAction: async () => ({
        messages: [
          {
            type: 'node',
            data: { nickname: '甲', user_id: '1', content: [{ type: 'image', data: { url: PNG_DATA_URI } }] },
          },
        ],
      }),
    });

    const out = await expander.expandForwardsInText(
      null,
      '<forward id="F1">[合并转发消息]</forward>',
      undefined,
      'onebot:t:group:1',
    );

    expect(described, '识别应拿到落盘后的 ref，而非原始 src').toHaveLength(1);
    expect(described[0]).toMatch(/^data\/images\/onebot_t_group_1\/[0-9a-f]{16}\.png$/);
    expect(readdirSync(join(base, 'data', 'images', 'onebot_t_group_1'))).toHaveLength(1);
    expect(existsSync(join(base, 'workspace', 'images'))).toBe(false);
    expect(out).toContain('[图片: 述]');
  });
});
