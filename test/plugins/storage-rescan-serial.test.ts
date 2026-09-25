import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { persona } from '../../packages/api-persona/src/index.js';
import {
  type StorageEntry,
  type StorageListResult,
  type StorageWatchListener,
  storage,
} from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide, services } from '../../packages/core/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import skillsPlugin, { skills } from '../../packages/plugin-skills/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// persona 的 refresh 与 skills 的 rescanSkills 串行化：同一时刻只跑一次扫描，进行中再触发只排一次尾随重扫。
// storage 层的去抖只按路径，不同文件的变化会各触发一次重扫；以前这些重扫并发执行：
//   - persona：先列目录、后收尾的那次按自己的旧清单剔掉另一次刚载入的卡，新卡要等下一次改动才出现；
//   - skills：并发重扫共用一个 skillsCache，冒出虚假的「重复 skill 名称」告警。
// skills 的每次扫描先写进局部 Map、扫完整体替换缓存，并同时作废按名字缓存的已编译 triggers：
//   - 以前扫描一开始就清空缓存，扫描期间 list_skills / load_skill / 贡献点读到的是空的或半截的缓存；
//   - 以前只有 service.rescan 清已编译的 triggers，load_skill / list_skills 的按需重扫之后仍用旧正则；
//   - 扫描在飞时经服务的写入会被收尾替换盖掉，写入时排一次尾随重扫按盘上实况重建。
// 内存 storage 提供者：能卡住下一次对某目录的 list（目录清单在卡住前取好），能手动触发 watch 回调，
// 并记录每个目录被 list 的次数，用来数实际跑了几次扫描。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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

/** 单个 data 根的内存 storage：键为完整 URI，目录由文件路径隐含 */
function gatedStorage(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  const listCalls = new Map<string, number>();
  const listeners = new Set<StorageWatchListener>();
  let hold: { uri: string; gate: ReturnType<typeof deferred<StorageListResult | undefined>> } | undefined;
  const rootInfo = {
    name: 'data',
    label: 'data(内存)',
    kind: 'data',
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  };

  const children = (uri: string): StorageEntry[] => {
    const prefix = `${uri}/`;
    const seen = new Map<string, StorageEntry>();
    for (const [key, text] of files) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/')[0];
      const isDirectory = rest.includes('/');
      if (!seen.has(name)) {
        seen.set(name, {
          name,
          path: `${uri.slice('data:/'.length)}/${name}`,
          uri: `${prefix}${name}`,
          isDirectory,
          size: isDirectory ? 0 : text.length,
          mtime: '',
          ext: '',
        });
      }
    }
    return [...seen.values()];
  };

  const service = {
    listRoots: () => [rootInfo],
    async list(uri: string): Promise<StorageListResult> {
      listCalls.set(uri, (listCalls.get(uri) ?? 0) + 1);
      const entries = children(uri);
      if (entries.length === 0) throw new Error(`ENOENT: ${uri}`);
      const result: StorageListResult = { root: rootInfo, path: uri.slice('data:/'.length), entries };
      if (hold?.uri === uri) {
        const { gate } = hold;
        hold = undefined;
        // 目录清单已在卡住前取好：放行后按旧清单继续，与真实 readdir 先返回、后续读取再慢的情形一致
        return (await gate.promise) ?? result;
      }
      return result;
    },
    async stat(uri: string) {
      const text = files.get(uri);
      const isDirectory = text === undefined && children(uri).length > 0;
      if (text === undefined && !isDirectory) throw new Error(`ENOENT: ${uri}`);
      const name = uri.split('/').pop() ?? '';
      return { name, path: uri.slice('data:/'.length), uri, isDirectory, size: text?.length ?? 0, mtime: '' };
    },
    async readFile(uri: string) {
      const text = files.get(uri);
      if (text === undefined) throw new Error(`ENOENT: ${uri}`);
      return text;
    },
    async writeFile(uri: string, data: string) {
      files.set(uri, data);
    },
    async mkdir(uri: string) {
      return uri;
    },
    watch(_uri: string, listener: StorageWatchListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    files,
    service,
    listCount: (uri: string): number => listCalls.get(uri) ?? 0,
    /** 卡住下一次对 uri 的 list；resolve 时可给一个结果替换原清单 */
    holdNextList(uri: string) {
      const gate = deferred<StorageListResult | undefined>();
      hold = { uri, gate };
      return gate;
    },
    /** 触发 watch 回调（相当于 storage 层去抖后投递一次变化） */
    fire(uri: string): void {
      for (const l of listeners) l({ type: 'change', uri, path: uri.slice('data:/'.length) });
    },
  };
}

const cardYaml = (name: string) => `name: ${name}\ndescription: d\nprompt: p\n`;
const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\nbody\n`;

describe('persona / skills 的目录重扫', () => {
  let app: App;
  let logs: string[];

  afterEach(async () => {
    await app?.stop();
  });

  async function bootWith(fake: ReturnType<typeof gatedStorage>): Promise<void> {
    logs = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
    await registerHubs(app);
    app.bind({ provide }).provide(storage, fake.service as never);
  }

  it('persona：扫描进行中的多次目录变化只排一次尾随重扫，新卡不被进行中那次的旧清单剔掉', async () => {
    const DIR = 'data:/personas';
    const fake = gatedStorage({ [`${DIR}/main.yaml`]: cardYaml('Main'), [`${DIR}/a.yaml`]: cardYaml('A') });
    await bootWith(fake);
    await app.plugin(personaPlugin, { persona: 'main', personasDir: DIR, timeInjection: false });
    await app.plugins.idle();
    await app.start();
    const svc = app.bind({ services }).services.get(persona);
    if (!svc?.listModels) throw new Error('persona 服务未就绪');
    expect((await svc.listModels()).sort()).toEqual(['a', 'main']);

    const before = fake.listCount(DIR);
    const gate = fake.holdNextList(DIR);
    fake.fire(`${DIR}/a.yaml`); // 扫描 A：清单里还没有 b，卡在 list 上
    fake.files.set(`${DIR}/b.yaml`, cardYaml('B'));
    fake.fire(`${DIR}/b.yaml`);
    fake.fire(`${DIR}/b.yaml`);
    fake.fire(`${DIR}/b.yaml`);
    await sleep(20); // 不串行化时，这三次重扫在此各自跑完并载入 b
    gate.resolve(undefined);
    await sleep(50);

    expect((await svc.listModels()).sort(), 'b 被旧清单剔掉').toEqual(['a', 'b', 'main']);
    expect(fake.listCount(DIR) - before, '进行中的一次加一次尾随').toBe(2);
  });

  it('skills：扫描进行中的并发 rescan 合并为一次尾随重扫，不报虚假的重复名称', async () => {
    const DIR = 'data:/skills';
    const fake = gatedStorage({ [`${DIR}/s1/SKILL.md`]: skillMd('s1'), [`${DIR}/s2/SKILL.md`]: skillMd('s2') });
    await bootWith(fake);
    await app.plugin(skillsPlugin, { skillsUri: DIR });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(skills);
    if (!svc) throw new Error('skills 服务未就绪');

    const gate = fake.holdNextList(DIR);
    const first = svc.rescan();
    fake.files.set(`${DIR}/s3/SKILL.md`, skillMd('s3'));
    const rest = [svc.rescan(), svc.rescan(), svc.rescan()];
    await sleep(20);
    gate.resolve(undefined);
    await Promise.all([first, ...rest]);

    expect(fake.listCount(DIR), '进行中的一次加一次尾随').toBe(2);
    expect(logs.filter(t => t.includes('重复 skill 名称'))).toEqual([]);
    expect(
      svc
        .listSkills()
        .map(s => s.name)
        .sort(),
    ).toEqual(['s1', 's2', 's3']);
  });

  it('skills：进行中的那次扫描失败，排着的尾随重扫照常执行，之后的 rescan 也不受影响', async () => {
    const DIR = 'data:/skills';
    const fake = gatedStorage({ [`${DIR}/s1/SKILL.md`]: skillMd('s1') });
    await bootWith(fake);
    await app.plugin(skillsPlugin, { skillsUri: DIR });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(skills);
    if (!svc) throw new Error('skills 服务未就绪');

    const gate = fake.holdNextList(DIR);
    const first = svc.rescan();
    const queued = svc.rescan();
    // 提供者返回坏结果（entries 缺失），这次扫描抛错
    gate.resolve({ entries: undefined } as unknown as StorageListResult);
    await expect(first).rejects.toThrow();
    await expect(queued).resolves.toBeUndefined();
    expect(svc.listSkills().map(s => s.name)).toEqual(['s1']);

    fake.files.set(`${DIR}/s2/SKILL.md`, skillMd('s2'));
    await svc.rescan();
    expect(
      svc
        .listSkills()
        .map(s => s.name)
        .sort(),
    ).toEqual(['s1', 's2']);
  });

  it('skills：扫描卡住期间读者仍看到上一版完整缓存，扫完整体替换', async () => {
    const DIR = 'data:/skills';
    const fake = gatedStorage({ [`${DIR}/s1/SKILL.md`]: skillMd('s1'), [`${DIR}/s2/SKILL.md`]: skillMd('s2') });
    await bootWith(fake);
    await app.plugin(skillsPlugin, { skillsUri: DIR });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(skills);
    if (!svc) throw new Error('skills 服务未就绪');
    await svc.rescan();
    const names = () =>
      svc
        .listSkills()
        .map(s => s.name)
        .sort();
    expect(names()).toEqual(['s1', 's2']);

    fake.files.delete(`${DIR}/s2/SKILL.md`);
    const gate = fake.holdNextList(DIR);
    const scan = svc.rescan();
    await sleep(20);
    expect(names(), '扫描卡住期间').toEqual(['s1', 's2']);
    expect(svc.getSkill('s1')).toBeDefined();
    gate.resolve(undefined);
    await scan;
    expect(names(), '扫完后换成新结果').toEqual(['s1']);
  });

  it('skills：扫描进行中经服务创建的技能不被收尾的整体替换盖掉', async () => {
    const DIR = 'data:/skills';
    const fake = gatedStorage({ [`${DIR}/s1/SKILL.md`]: skillMd('s1') });
    await bootWith(fake);
    await app.plugin(skillsPlugin, { skillsUri: DIR });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(skills);
    if (!svc) throw new Error('skills 服务未就绪');
    await svc.rescan();

    const gate = fake.holdNextList(DIR);
    const scan = svc.rescan(); // 目录清单在卡住前取好：里面还没有 s3
    await svc.createSkill({ name: 's3', description: 'd' });
    expect(svc.getSkill('s3'), '写入后立即可见').toBeDefined();
    gate.resolve(undefined);
    await scan;
    await sleep(20); // 写入时排下的尾随重扫
    expect(
      svc
        .listSkills()
        .map(s => s.name)
        .sort(),
      '被旧清单的整体替换盖掉',
    ).toEqual(['s1', 's3']);
  });

  it('skills：load_skill 的按需重扫同样作废已编译的 triggers，改过的触发正则随之生效', async () => {
    const DIR = 'data:/skills';
    const wx = (trigger: string) => `---\nname: wx\ndescription: d\ntriggers:\n  - ${trigger}\n---\nbody\n`;
    const fake = gatedStorage({ [`${DIR}/wx/SKILL.md`]: wx('天气') });
    await bootWith(fake);
    const handlers = new Map<string, RegisteredTool['handler']>();
    app.bind({ provide }).provide(tools, {
      register(tool: RegisteredTool) {
        handlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    await app.plugin(skillsPlugin, { skillsUri: DIR });
    await app.plugins.idle();
    const host = app.bind({ services, hooks });
    const svc = host.services.get(skills);
    const loadSkill = handlers.get('load_skill');
    if (!svc || !loadSkill) throw new Error('skills 服务或 load_skill 未就绪');
    await svc.rescan();
    const say = (sessionId: string, content: string) =>
      host.hooks.run('agent:input:before', { message: { sessionId, content }, metadata: {} } as never);

    await say('s-1', '今天天气怎么样'); // 编译并缓存 wx 的 triggers
    expect(svc.getLoadedSkills('s-1')).toEqual(['wx']);

    fake.files.set(`${DIR}/wx/SKILL.md`, wx('下雨'));
    fake.files.set(`${DIR}/late/SKILL.md`, skillMd('late'));
    // late 不在缓存里：load_skill 先按需重扫一次
    const out = JSON.parse(String(await loadSkill({ name: 'late' }, {} as never)));
    expect(out.ok).toBe(true);
    expect(svc.getSkill('wx')?.triggers).toEqual(['下雨']);

    await say('s-2', '明天会下雨吗');
    expect(svc.getLoadedSkills('s-2'), '仍在用旧的已编译正则').toEqual(['wx']);
  });
});
