import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckResult, type CheckSpec, doctor } from '../../packages/api-doctor/src/index.js';
import { MEDIA_KIND_DIRS, sessionDirName } from '../../packages/api-media/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { rememberDescription } from '../../packages/plugin-media/src/cache.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { i18nSection, renderIn } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { roomCommands, seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 媒体识别给人看的出口按读者的语言：没有能看图的识别模型时诊断项的说明与修法、/clear 清描述缓存失败的回执（网关按房间的
// 语言，房间没设时随全局默认层）。中文与改动前逐字相同。真的 plugin-media、网关、指令与 plugin-i18n；存储是替身，描述快照
// 读不出（不是「不存在」），本次运行禁写，会话级清理清完内存后如实报失败；诊断是替身，收下登记的检查项。
// ════════════════════════════════════════════════════════════

const CHAT = 'zz-chat';
const ROOM = `${CHAT}:bot:group:1`;
const SNAPSHOT = 'data:/media/descriptions.json';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const notFound = (uri: string) => Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });

/** data 根的存储替身：描述快照读不出，其余文件都不存在 */
const STORAGE = {
  listRoots: () => [
    { name: 'data', label: 'data', kind: 'data', browsable: true, readable: true, writable: true, deletable: true },
  ],
  async readFile(uri: string) {
    throw uri === SNAPSHOT ? new Error('EACCES: permission denied') : notFound(uri);
  },
  async list(uri: string) {
    throw notFound(uri);
  },
  async writeFile() {},
  async delete(uri: string) {
    throw notFound(uri);
  },
};

async function setup(language: string) {
  const home = mkdtempSync(join(tmpdir(), 'zz-media-i18n-'));
  homes.push(home);
  const { app } = hostedApp(i18nSection([language]), { logger: silent });
  apps.push(app);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, memory });
  const checks: CheckSpec[] = [];
  host.provide.use(doctor, {
    registerCheck(spec: CheckSpec) {
      checks.push(spec);
      return () => {};
    },
  } as never);
  host.provide.use(processService, {} as never);
  host.provide.use(storage, STORAGE as never);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await seedRooms(host.memory.use, { [ROOM]: ROOM });
  const plugins = [mediaPlugin, sessionManagerPlugin, sessionSettingsPlugin, gatewayPlugin, commandsPlugin, i18nPlugin];
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  return { checks, ask: await roomCommands(app, ROOM, CHAT) };
}

/** 这个房间里带会话语境的一条图片描述（以存储地址为键） */
const describeInRoom = (file: string) =>
  rememberDescription(`${MEDIA_KIND_DIRS.image}/${sessionDirName(ROOM)}/zz/${file}`, '<描述>', false);

const CASES = {
  en: {
    vision: [
      'The image recognition plugin is installed, but no recognition model can see images: images are still saved, but the main model cannot see their content',
      'Add a model that can see images in the model services, then choose it under “Image recognition → Recognition model” in “Multimodal media recognition” (left empty, one is chosen automatically)',
    ],
    clear: (count: number) =>
      'Uploaded images cleared (0 files)\nFailed to clear the image description cache: ' +
      `${count === 1 ? '1 entry was' : `${count} entries were`} deleted from memory, but this run could not read the ` +
      `description snapshot, so the snapshot on disk was not rewritten and ${count === 1 ? 'it' : 'they'} will come ` +
      'back after a restart',
  },
  'zh-CN': {
    vision: [
      '装了识图插件，但没有能看图的识别模型：图片照样存下，主模型看不到内容',
      '在模型服务里加一个能看图的模型，再到「多模态媒体识别」的「图像识别 → 识别模型」里选它（留空则自动选用）',
    ],
    clear: (count: number) =>
      `上传的图片已清空（0 个）\n图片描述缓存清空失败: 内存中已删除 ${count} 条，但本次运行未能读取描述快照，磁盘上的快照未改写，重启后会恢复`,
  },
};

describe('媒体识别给人看的出口按读者的语言', () => {
  it.each(Object.entries(CASES))('%s：识图不可用的诊断项，/clear 清描述缓存失败的回执', async (language, expected) => {
    const { checks, ask } = await setup(language);

    const check = checks.find(c => c.id === 'media.vision');
    if (!check) throw new Error('media 没有登记诊断项');
    const result = (await check.run()) as CheckResult;
    expect([renderIn(result.message, language), renderIn(result.detail, language)]).toEqual(expected.vision);

    describeInRoom('a.jpg');
    const one = await ask('/clear -t image');
    describeInRoom('b.jpg');
    describeInRoom('c.jpg');
    expect([one, await ask('/clear -t image')]).toEqual([expected.clear(1), expected.clear(2)]);
  });
});
