import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persona } from '../../packages/api-persona/src/index.js';
import { App, type Logger, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import skillsPlugin, { skills } from '../../packages/plugin-skills/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// skills 与 persona 的目录监听曾只在自己的 app:ready 里挂一次，挂在当时的 storage 提供者上：
// - storage 改配置换了目录：新目录的变化感知不到，旧目录的监听还在报；
// - storage 晚于 app:ready 上线：从不扫描、不监听，技能为空、人设停在内置默认；
// - storage 重启后热重载还能用，只因旧提供者的 fs 监听器没随它关闭（泄漏）。
// 现改为跟随 storage（follow）：在场即挂监听并全量扫描，换代时先关旧监听再重挂；
// storage-local 关闭时也会关掉自己建的监听器；skills / persona 自己卸载时由 follow 的清理关掉监听。
// 重启那条用例守住两处必须同批：
// 只修提供者一侧、消费者不重挂，它会变红。
// 真 storage-local（workspace + data 两个根）+ 真 skills / persona。
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

const root = (name: string, path: string) => ({
  name,
  path,
  label: name,
  kind: name,
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
});

const writeSkill = (skillsDir: string, name: string): void => {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};
const writeCard = (personasDir: string, name: string): void => {
  writeFileSync(join(personasDir, `${name}.yaml`), `name: ${name}\ndescription: d\nprompt: p\n`);
};

describe('skills / persona 的目录监听跟随 storage 提供者', () => {
  let base: string;
  let app: App;
  let logs: string[];

  const storageConfig = (dataDir: string) => ({
    roots: [root('workspace', join(base, 'workspace')), root('data', join(base, dataDir))],
  });
  const consumers = () => [
    { definition: personaPlugin, config: { persona: 'default', personasDir: 'data/personas' } },
    { definition: skillsPlugin, config: {} },
  ];
  const skillNames = (): string[] => (app.bind({ services }).services.get(skills)?.listSkills() ?? []).map(s => s.name);
  const personaNames = async (): Promise<string[]> =>
    (await app.bind({ services }).services.get(persona)?.listModels?.()) ?? [];
  /** 两个插件的「目录变化 → 重扫」日志条数 */
  const rescans = (): number => logs.filter(t => t.includes('目录变化')).length;

  /** 同批登记：消费者排在 storage-local 前面（与按字母序加载的实际顺序一致） */
  async function boot(): Promise<void> {
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      ...consumers(),
      { definition: storageLocal, config: storageConfig('data') },
    ]);
    await app.plugins.idle();
    await app.start();
    await sleep(250); // 等 fs 监听就绪
  }

  beforeEach(() => {
    logs = [];
    base = mkdtempSync(join(tmpdir(), 'aalis-watch-follow-'));
    for (const d of ['workspace', 'data/skills', 'data/personas', 'data2/skills', 'data2/personas']) {
      mkdirSync(join(base, d), { recursive: true });
    }
  });

  afterEach(async () => {
    await app?.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('storage 改配置换了 data 目录：新目录的变化被感知，旧目录不再触发重扫', async () => {
    await boot();
    await app.plugins.updateConfig(storageLocal.name, storageConfig('data2'));
    await app.plugins.idle();
    await sleep(250);

    writeSkill(join(base, 'data2', 'skills'), 'zz-new-root');
    writeCard(join(base, 'data2', 'personas'), 'zznew');
    expect(await waitUntil(() => skillNames().includes('zz-new-root')), '新目录的技能未被感知').toBe(true);
    expect(await waitUntil(async () => (await personaNames()).includes('zznew')), '新目录的人设未被感知').toBe(true);

    await sleep(300); // 让新目录写入引起的重扫落定
    const before = rescans();
    writeSkill(join(base, 'data', 'skills'), 'zz-poke-old');
    writeCard(join(base, 'data', 'personas'), 'zzold');
    await sleep(600);
    expect(rescans() - before, '旧目录的监听仍在触发重扫').toBe(0);
  });

  it('storage 重启后同一目录的变化仍被感知', async () => {
    await boot();
    await app.plugins.bounce(storageLocal.name);
    await app.plugins.idle();
    await sleep(250);

    writeSkill(join(base, 'data', 'skills'), 'zz-after-bounce');
    writeCard(join(base, 'data', 'personas'), 'zzbounce');
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
    writeSkill(join(base, 'data', 'skills'), 'zz-after-unload');
    writeCard(join(base, 'data', 'personas'), 'zzunload');
    await sleep(800);
    expect(rescans() - before, '卸载后的监听仍在触发重扫').toBe(0);
  });

  it('storage 在 app:ready 之后才上线：已有的技能与人设被扫到，之后的变化也被感知', async () => {
    writeSkill(join(base, 'data', 'skills'), 'zz-pre');
    writeCard(join(base, 'data', 'personas'), 'zzpre');
    app = new App({ name: 'T', logLevel: 'error' });
    await app.pluginAll([...HUB_PLUGINS.map(definition => ({ definition })), ...consumers()]);
    await app.plugins.idle();
    await app.start();
    expect(skillNames()).toEqual([]);

    await app.plugin(storageLocal, storageConfig('data'));
    await app.plugins.idle();
    expect(await waitUntil(() => skillNames().includes('zz-pre')), '已有技能未被扫到').toBe(true);
    expect(await waitUntil(async () => (await personaNames()).includes('zzpre')), '已有人设未被扫到').toBe(true);

    await sleep(250);
    writeSkill(join(base, 'data', 'skills'), 'zz-late');
    expect(await waitUntil(() => skillNames().includes('zz-late')), '上线后的新增技能未被感知').toBe(true);
  });

  it('首启目录不存在：补建后监听生效', async () => {
    rmSync(join(base, 'data', 'skills'), { recursive: true, force: true });
    rmSync(join(base, 'data', 'personas'), { recursive: true, force: true });
    await boot();
    expect(existsSync(join(base, 'data', 'skills'))).toBe(true);
    expect(existsSync(join(base, 'data', 'personas'))).toBe(true);

    writeSkill(join(base, 'data', 'skills'), 'zz-first-boot');
    expect(await waitUntil(() => skillNames().includes('zz-first-boot'))).toBe(true);
  });
});
