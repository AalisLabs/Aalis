import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persona } from '../../packages/api-persona/src/index.js';
import { App, type Logger, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import skillsPlugin, { skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// skills 与 persona 的目录监听曾只在自己的 app:ready 里挂一次，挂在当时的 storage 提供者上：
// - storage 晚于 app:ready 上线：从不扫描、不监听，技能为空、人设停在内置默认；
// - storage 重启后热重载还能用，只因旧提供者的 fs 监听器没随它关闭（泄漏）。
// 现改为跟随 storage（follow）：在场即挂监听并全量扫描，换代时先关旧监听再重挂；
// storage-local 关闭时也会关掉自己建的监听器；skills / persona 自己卸载时由 follow 的清理关掉监听。
// 重启那条用例守住两处必须同批：
// 只修提供者一侧、消费者不重挂，它会变红。
// 真 storage-local + 真 skills / persona。技能与人设在存储的内容目录里（家目录的 self/skills、self/persona），
// 目录按家目录布局派生、不能配置。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await sleep(25);
  }
  return pred();
};

function recordingLogger(sink: string[]): Logger {
  const push =
    () =>
    (message: string, ...args: unknown[]) =>
      sink.push([message, ...args.map(a => String(a))].join(' '));
  const logger: Logger = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const writeSkill = (skillsDir: string, name: string): void => {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};
const writeCard = (dir: string, name: string): void => {
  writeFileSync(join(dir, `${name}.yaml`), `name: ${name}\ndescription: d\nprompt: p\n`);
};

describe('skills / persona 的目录监听跟随 storage 提供者', () => {
  let base: string;
  let app: App;
  let logs: string[];

  const skillsDir = () => join(base, 'self', 'skills');
  const cardsDir = () => join(base, 'self', 'persona');
  const consumers = () => [{ definition: personaPlugin }, { definition: skillsPlugin }];
  const skillNames = (): string[] =>
    (app.bind({ services }).services.use.get(skills)?.listSkills() ?? []).map(s => s.name);
  const personaNames = async (): Promise<string[]> =>
    (await app.bind({ services }).services.use.get(persona)?.listModels?.()) ?? [];
  /** 两个插件的「目录变化 → 重扫」日志条数 */
  const rescans = (): number => logs.filter(t => t.includes('目录变化')).length;

  /** 同批登记：消费者排在 storage-local 前面（与按字母序加载的实际顺序一致） */
  async function boot(): Promise<void> {
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
    provideHostPaths(app, base);
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      ...consumers(),
      { definition: storageLocal },
    ]);
    await app.plugins.idle();
    await app.start();
    await sleep(250); // 等 fs 监听就绪
  }

  beforeEach(() => {
    logs = [];
    base = mkdtempSync(join(tmpdir(), 'aalis-watch-follow-'));
    for (const d of ['self/skills', 'self/persona']) mkdirSync(join(base, d), { recursive: true });
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('storage 重启后同一目录的变化仍被感知', async () => {
    await boot();
    await app.plugins.bounce(storageLocal.name);
    await app.plugins.idle();
    await sleep(250);

    writeSkill(skillsDir(), 'zz-after-bounce');
    writeCard(cardsDir(), 'zzbounce');
    expect(await waitUntil(() => skillNames().includes('zz-after-bounce'))).toBe(true);
    expect(await waitUntil(async () => (await personaNames()).includes('zzbounce'))).toBe(true);
  });

  it('skills / persona 自己卸载后，它们挂的监听随之关闭', async () => {
    await boot();
    await app.plugins.unload(skillsPlugin.name);
    await app.plugins.unload(personaPlugin.name);
    await app.plugins.idle();
    await sleep(300); // 让卸载前的重扫与迟到的 fs 事件落定，之后只数增量

    const before = rescans();
    writeSkill(skillsDir(), 'zz-after-unload');
    writeCard(cardsDir(), 'zzunload');
    await sleep(800);
    expect(rescans() - before, '卸载后的监听仍在触发重扫').toBe(0);
  });

  it('storage 在 app:ready 之后才上线：已有的技能与人设被扫到，之后的变化也被感知', async () => {
    writeSkill(skillsDir(), 'zz-pre');
    writeCard(cardsDir(), 'zzpre');
    app = new App({ name: 'T', logLevel: 'error' });
    provideHostPaths(app, base);
    await app.pluginAll([...HUB_PLUGINS.map(definition => ({ definition })), ...consumers()]);
    await app.plugins.idle();
    await app.start();
    expect(skillNames()).toEqual([]);

    await app.plugin(storageLocal);
    await app.plugins.idle();
    expect(await waitUntil(() => skillNames().includes('zz-pre')), '已有技能未被扫到').toBe(true);
    expect(await waitUntil(async () => (await personaNames()).includes('zzpre')), '已有人设未被扫到').toBe(true);

    await sleep(250);
    writeSkill(skillsDir(), 'zz-late');
    expect(await waitUntil(() => skillNames().includes('zz-late')), '上线后的新增技能未被感知').toBe(true);
  });

  it('首启目录不存在：补建后监听生效', async () => {
    rmSync(skillsDir(), { recursive: true, force: true });
    rmSync(cardsDir(), { recursive: true, force: true });
    await boot();
    expect(existsSync(skillsDir())).toBe(true);
    expect(existsSync(cardsDir())).toBe(true);

    writeSkill(skillsDir(), 'zz-first-boot');
    expect(await waitUntil(() => skillNames().includes('zz-first-boot'))).toBe(true);
  });
});
