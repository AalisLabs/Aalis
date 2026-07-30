import { describe, expect, it } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import type { SkillsService } from '../../packages/plugin-skills/src/index.js';
import * as skillsModule from '../../packages/plugin-skills/src/index.js';
import type {
  StorageEntry,
  StorageRootInfo,
  StorageService,
  StorageStat,
} from '../../packages/plugin-storage-api/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// plugin-skills 的 agent:prompt 贡献（discovery / activation 两类块）：
//   - discovery（knowledge 槽）：列出全部可见技能的 name + description
//   - activation（knowledge 槽）：每个被激活过的技能一份，按 view.sessionId
//     判断本会话是否已 load_skill —— 未 load 的会话不应看到正文
// 驱动面全部走公开面：ctx.provide 假 storage + skills 服务 + 组装器直驱 +
// runHook('agent:input:before') 驱动 triggers 自动激活。
// ════════════════════════════════════════════════════════════

/** 固定时间戳：storage stat/entry 的 mtime 不参与断言，但保持确定性 */
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

interface MemoryStorage extends StorageService {
  /** 直接塞文件（模拟外部往 skills 目录放技能，供 rescan 发现） */
  seed(uri: string, content: string): void;
}

/**
 * 最小内存 storage：只实现 skills 用到的 list / stat / readFile / writeFile /
 * delete，单根 `data`。不落真实文件系统。
 */
function createMemoryStorage(): MemoryStorage {
  const files = new Map<string, string>();
  const root: StorageRootInfo = {
    name: 'data',
    label: 'data(内存)',
    kind: 'data',
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  };
  const byteLen = (s: string): number => new TextEncoder().encode(s).length;
  const dirPrefix = (uri: string): string => (uri.endsWith('/') ? uri : `${uri}/`);
  const pathOf = (uri: string): string => uri.slice(uri.indexOf(':/') + 1);
  const nameOf = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);
  const statOf = (uri: string, isDirectory: boolean, size: number): StorageStat => ({
    name: nameOf(uri),
    path: pathOf(uri),
    uri,
    isDirectory,
    size,
    mtime: FIXED_TIME,
    birthtime: FIXED_TIME,
    ext: '',
  });

  return {
    seed(uri, content) {
      files.set(uri, content);
    },
    listRoots: () => [root],
    async list(uri) {
      const prefix = dirPrefix(uri);
      const seen = new Map<string, StorageEntry>();
      for (const [key, content] of files) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const childName = slash < 0 ? rest : rest.slice(0, slash);
        if (seen.has(childName)) continue;
        const childUri = prefix + childName;
        seen.set(childName, {
          name: childName,
          path: pathOf(childUri),
          uri: childUri,
          isDirectory: slash >= 0,
          size: slash >= 0 ? 0 : byteLen(content),
          mtime: FIXED_TIME,
          ext: '',
        });
      }
      // 与真实实现一致：不存在的目录抛错（safeListFiles / rescan 各自吞掉）
      if (seen.size === 0) throw new Error(`ENOENT: ${uri}`);
      return { root, path: pathOf(uri), entries: [...seen.values()] };
    },
    async stat(uri) {
      const content = files.get(uri);
      if (content !== undefined) return statOf(uri, false, byteLen(content));
      const prefix = dirPrefix(uri);
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return statOf(uri, true, 0);
      }
      throw new Error(`ENOENT: ${uri}`);
    },
    async readFile(uri, encoding) {
      const content = files.get(uri);
      if (content === undefined) throw new Error(`ENOENT: ${uri}`);
      return encoding ? content : (new TextEncoder().encode(content) as unknown as Buffer);
    },
    async writeFile(uri, data) {
      files.set(uri, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    async delete(uri) {
      files.delete(uri);
      const prefix = dirPrefix(uri);
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    },
    async rename() {
      throw new Error('未实现');
    },
    async createReadStream() {
      throw new Error('未实现');
    },
    watch: () => () => undefined,
  };
}

async function setup(config: Record<string, unknown> = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  const storage = createMemoryStorage();
  app.ctx.provide('storage', storage);
  await app.ctx.useModule(skillsModule, config);
  const skills = app.ctx.getService<SkillsService>('skills');
  if (!skills) throw new Error('skills 服务未注册');
  return { app, storage, skills };
}

/** 头部一条 system + 一条 user，便于观察 knowledge 槽落在 system 区末尾 */
function baseMessages(): Message[] {
  return [
    { role: 'system', content: 'persona' },
    { role: 'user', content: '帮我处理一下' },
  ];
}

const isDiscovery = (m: Message): boolean => String(m.metadata?.injector ?? '').endsWith('/skills-discovery');
const activationOf = (skillName: string) => (m: Message) =>
  String(m.metadata?.injector ?? '').endsWith(`/skills-activation:${skillName}`);

describe('plugin-skills: agent:prompt 贡献', () => {
  it('discoveryEnabled=true 且有技能：discovery 块列出技能名与描述', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '处理甲类任务', body: 'ALPHA-BODY' });
    await skills.createSkill({ name: 'beta', description: '处理乙类任务', body: 'BETA-BODY' });

    // 锚位探针：identity / context 各交一份贡献，用相对次序钉死 discovery 落在
    // knowledge 槽——把源码的 anchor 改成任何别的锚位，这条次序链就会断。
    const probe = app.ctx.fork('probe');
    probe.contribute('agent:prompt' as never, { id: 'idn', anchor: 'identity', build: () => 'IDN' } as never);
    probe.contribute('agent:prompt' as never, { id: 'cx', anchor: 'context', build: () => 'CX' } as never);

    // 两条 system：identity 插在首条 system 之后、knowledge 插在首条非 system
    // 之前——只有一条 system 时两个落点重合，探针分不出 identity/knowledge。
    const messages: Message[] = [
      { role: 'system', content: 'persona' },
      { role: 'system', content: 'persona-补充设定' },
      { role: 'user', content: '帮我处理一下' },
    ];
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });

    const block = messages.find(isDiscovery);
    expect(block).toBeDefined();
    expect(block?.role).toBe('system');
    const content = String(block?.content ?? '');
    expect(content).toContain('可用技能');
    expect(content).toContain('共 2');
    expect(content).toContain('- alpha: 处理甲类任务');
    expect(content).toContain('- beta: 处理乙类任务');
    expect(content).toContain('load_skill');
    // 渐进披露：discovery 只列名与描述，不含 SKILL.md 正文
    expect(content).not.toContain('ALPHA-BODY');
    expect(content).not.toContain('BETA-BODY');
    // discovery 是 knowledge 槽：persona → IDN(identity) → 第二条 system →
    // discovery(knowledge) → CX(context) → 非 system
    const at = (pred: (m: Message) => boolean): number => messages.findIndex(pred);
    const chain = [
      at(m => m.content === 'persona'),
      at(m => m.content === 'IDN'),
      at(m => m.content === 'persona-补充设定'),
      at(isDiscovery),
      at(m => m.content === 'CX'),
      at(m => m.role !== 'system'),
    ];
    expect(chain).toEqual([0, 1, 2, 3, 4, 5]);
    // 未 load 任何技能 → 无激活块
    expect(messages.some(activationOf('alpha'))).toBe(false);
  });

  it('无技能：不注入 discovery 块', async () => {
    const { app } = await setup();
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });

    expect(messages.some(isDiscovery)).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it('rescan 发现外部放入的技能后，discovery 才列出它', async () => {
    const { app, storage, skills } = await setup();
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    expect(messages.some(isDiscovery)).toBe(false);

    storage.seed('data:/skills/gamma/SKILL.md', '---\nname: gamma\ndescription: 外部放入的技能\n---\n\nGAMMA-BODY\n');
    await skills.rescan();
    expect(skills.listSkills().map(s => s.name)).toEqual(['gamma']);

    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    const content = String(messages.find(isDiscovery)?.content ?? '');
    expect(content).toContain('- gamma: 外部放入的技能');
  });

  it('loadSkillForSession 后组装：激活块含 SKILL 正文，且只在该 sessionId 出现', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '处理甲类任务', body: 'ALPHA-BODY-步骤一' });
    expect(skills.loadSkillForSession('s-1', 'alpha')).toBe(true);
    expect(skills.getLoadedSkills('s-1')).toEqual(['alpha']);

    // 锚位探针：identity 给上界，context 给下界。两个探针的 ctx id 必须把插件全局键
    // （经 useModule 加载，形如 `root#@aalis/plugin-skills`）**夹在中间**——同槽内按
    // 全局键码元序排布，探针若落在被测块同侧，错标锚位后次序不变、断言恒真。
    // 故 identity 探针取 zz-（排在插件键之后）、context 探针取 aa-（排在之前）。
    app.ctx
      .fork('zz-probe-identity')
      .contribute('agent:prompt' as never, { id: 'idn', anchor: 'identity', build: () => 'IDN' } as never);
    app.ctx
      .fork('aa-probe-context')
      .contribute('agent:prompt' as never, { id: 'cx', anchor: 'context', build: () => 'CX' } as never);

    const loaded = baseMessages();
    await assemblePromptContributions(app.ctx, { messages: loaded, sessionId: 's-1' });
    const block = loaded.find(activationOf('alpha'));
    expect(block).toBeDefined();
    const content = String(block?.content ?? '');
    expect(content).toContain('Skill 已激活: alpha');
    expect(content).toContain('ALPHA-BODY-步骤一');

    // 激活块落 knowledge 槽：在 IDN(identity) 之后、CX(context) 之前
    const idnIdx = loaded.findIndex(m => String(m.content) === 'IDN');
    const cxIdx = loaded.findIndex(m => String(m.content) === 'CX');
    const actIdx = loaded.indexOf(block as Message);
    expect(idnIdx).toBeLessThan(actIdx);
    expect(actIdx, '激活块须落 knowledge 槽（identity 之后、context 之前）').toBeLessThan(cxIdx);
    // 渐进披露对称面：同一次组装里 discovery 块仍不含正文，正文只在激活块
    const discovery = loaded.find(isDiscovery);
    expect(discovery).toBeDefined();
    expect(String(discovery?.content ?? '')).not.toContain('ALPHA-BODY');

    // 另一会话：discovery 有、激活块无
    const other = baseMessages();
    await assemblePromptContributions(app.ctx, { messages: other, sessionId: 's-2' });
    expect(other.some(isDiscovery)).toBe(true);
    expect(other.some(activationOf('alpha'))).toBe(false);
  });

  it('未知技能名 loadSkillForSession 返回 false，且不产生激活块', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '处理甲类任务', body: 'ALPHA-BODY' });
    expect(skills.loadSkillForSession('s-1', 'nope')).toBe(false);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    expect(messages.some(activationOf('nope'))).toBe(false);
    expect(messages.some(activationOf('alpha'))).toBe(false);
  });

  it('triggers 命中用户消息：agent:input:before 自动激活，该会话组装注入正文', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'wx', description: '查询天气', triggers: ['天气'], body: 'WX-BODY' });

    // contributeActivation 的第二入口：triggers regex 命中 user 消息自动激活
    await app.ctx.runHook('agent:input:before', {
      message: { sessionId: 's-wx', content: '今天天气怎么样' },
      metadata: {},
    } as never);
    expect(skills.getLoadedSkills('s-wx')).toEqual(['wx']);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-wx' });
    const content = String(messages.find(activationOf('wx'))?.content ?? '');
    expect(content).toContain('Skill 已激活: wx');
    expect(content).toContain('WX-BODY');
  });

  it('激活块附带 scripts/references/assets 资源清单', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({
      name: 'alpha',
      description: '处理甲类任务',
      body: 'ALPHA-BODY',
      files: [
        { relPath: 'scripts/run.sh', content: 'echo hi' },
        { relPath: 'references/api.md', content: '# api' },
        { relPath: 'assets/tpl.json', content: '{}' },
      ],
    });
    skills.loadSkillForSession('s-1', 'alpha');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    const content = String(messages.find(activationOf('alpha'))?.content ?? '');
    expect(content).toContain('scripts/: run.sh');
    expect(content).toContain('references/: api.md');
    expect(content).toContain('assets/: tpl.json');
    expect(content).toContain('data:/skills/alpha');
  });

  it('回合中途再 load 第二个技能：增量出现第二块，第一块不重复', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '甲', body: 'ALPHA-BODY' });
    await skills.createSkill({ name: 'beta', description: '乙', body: 'BETA-BODY' });

    const messages = baseMessages();
    skills.loadSkillForSession('s-1', 'alpha');
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    expect(messages.filter(activationOf('alpha'))).toHaveLength(1);
    expect(messages.some(activationOf('beta'))).toBe(false);

    // 模拟工具循环中途 load_skill 激活第二个技能
    skills.loadSkillForSession('s-1', 'beta');
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });

    expect(messages.filter(activationOf('alpha'))).toHaveLength(1);
    expect(messages.filter(activationOf('beta'))).toHaveLength(1);
    expect(messages.filter(isDiscovery)).toHaveLength(1);
    expect(String(messages.find(activationOf('beta'))?.content ?? '')).toContain('BETA-BODY');
  });

  it("技能名同形碰撞（'a/b' 归一撞 'a_b'）：守卫保先占者，后者不注入且不抛错", async () => {
    const { app, storage, skills } = await setup();
    // 必须 seed 两个不同目录：createSkill 会把 'a/b' 与 'a_b' sanitize 成同一
    // 文件夹名先撞目录，隔离不出贡献键碰撞本身
    storage.seed('data:/skills/slash-skill/SKILL.md', '---\nname: a/b\ndescription: 名字带斜杠\n---\n\nSLASH-BODY\n');
    storage.seed(
      'data:/skills/underscore-skill/SKILL.md',
      '---\nname: a_b\ndescription: 名字带下划线\n---\n\nUNDERSCORE-BODY\n',
    );
    await skills.rescan();
    expect(
      skills
        .listSkills()
        .map(s => s.name)
        .sort(),
    ).toEqual(['a/b', 'a_b']);

    // 依次激活：'a/b' 归一为 'a_b' 后与真实 'a_b' 撞同一贡献键，守卫不抛错
    expect(skills.loadSkillForSession('s-1', 'a/b')).toBe(true);
    expect(skills.loadSkillForSession('s-1', 'a_b')).toBe(true);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    // 先占者（'a/b'）的正文注入；后者（'a_b'）的激活块不出现——撞键只物化一份
    const blocks = messages.filter(activationOf('a_b'));
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0]?.content ?? '')).toContain('SLASH-BODY');
    expect(messages.map(m => String(m.content)).join('\n')).not.toContain('UNDERSCORE-BODY');
  });

  it('discoveryEnabled=false：discovery 与激活块都不注入', async () => {
    const { app, skills } = await setup({ discoveryEnabled: false });
    await skills.createSkill({ name: 'alpha', description: '甲', body: 'ALPHA-BODY' });
    expect(skills.loadSkillForSession('s-1', 'alpha')).toBe(true);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });

    expect(messages.some(isDiscovery)).toBe(false);
    expect(messages.some(activationOf('alpha'))).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it('无 sessionId 组装：只出 discovery，激活块不出（无从判定归属会话）', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '甲', body: 'ALPHA-BODY' });
    skills.loadSkillForSession('s-1', 'alpha');

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages });
    expect(messages.some(isDiscovery)).toBe(true);
    expect(messages.some(activationOf('alpha'))).toBe(false);
  });

  it('deleteSkill 后：discovery 不再列出，已激活会话的正文也消失', async () => {
    const { app, skills } = await setup();
    await skills.createSkill({ name: 'alpha', description: '甲', body: 'ALPHA-BODY' });
    skills.loadSkillForSession('s-1', 'alpha');
    expect(await skills.deleteSkill('alpha')).toBe(true);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, { messages, sessionId: 's-1' });
    expect(messages.some(isDiscovery)).toBe(false);
    expect(messages.some(activationOf('alpha'))).toBe(false);
    expect(skills.getLoadedSkills('s-1')).toEqual([]);
  });
});
