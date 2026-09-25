import { Buffer } from 'node:buffer';
import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { hooks } from '@aalis/api-hooks';
import { persona } from '@aalis/api-persona';
import { createStorageGateway, type StorageService, storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { type BoundOf, config, definePlugin, defineService, events, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ════════════════════════════════════════════════════════════
// plugin-skills — Agent Skills（兼容 Anthropic Agent Skills 标准）
//
// 每个 skill 是 data/skills/<name>/SKILL.md 文件夹，包含：
//   - SKILL.md（必需）：YAML frontmatter（name, description, triggers?, license?）
//     + Markdown 正文
//   - scripts/（可选）：可执行脚本
//   - references/（可选）：参考文档
//   - assets/（可选）：模板/资源
//
// 渐进披露三阶段：
//   1. Discovery: system prompt 只注入一行静态路标，具体技能靠 list_skills 检索
//   2. Activation: 调用 load_skill(name) 或 triggers regex 命中自动激活
//   3. Execution: SKILL.md body 注入下一轮，agent 按指令使用 scripts/references
//
// 与 persona 协同：persona 卡可声明 `skills: [...]` 白名单。
// ════════════════════════════════════════════════════════════

// ──────────── 数据结构 ────────────

interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string[];
  license?: string;
  [key: string]: unknown;
}

interface SkillDefinition {
  name: string;
  description: string;
  /** SKILL.md 去掉 frontmatter 后的 markdown 正文 */
  body: string;
  triggers?: string[];
  license?: string;
  /** skill 文件夹 storage URI（如 data:/skills/foo） */
  uri: string;
  /** scripts/ 下的相对路径列表（不含 scripts/ 前缀） */
  scripts: string[];
  references: string[];
  assets: string[];
  /** 完整 SKILL.md 原始内容（用于 WebUI 查看） */
  raw: string;
}

interface SkillsConfig {
  skillsUri: string;
  maxSkillBytes: number;
  maxSkills: number;
  /** 启用启动时 Discovery 注入（默认 true） */
  discoveryEnabled: boolean;
  /** 启用 triggers regex 自动激活（默认 true） */
  triggersEnabled: boolean;
}

export interface SkillFileInput {
  /** 相对 skill 根目录的路径，例如 `scripts/run.sh`、`references/api.md`。 */
  relPath: string;
  /** 文本内容或二进制内容。 */
  content: string | Uint8Array;
}

export interface SkillsService {
  listSkills(): SkillDefinition[];
  getSkill(name: string): SkillDefinition | undefined;
  /**
   * 创建一个新 skill（文件夹 + SKILL.md + 可选附属文件）。
   * files 中的 relPath 不能为 `SKILL.md`、不能以 `/` 开头、不能包含 `..` 段。
   * frontmatter 可传入额外 YAML 字段（例如 compatibility）。
   */
  createSkill(input: {
    name: string;
    description: string;
    body?: string;
    triggers?: string[];
    license?: string;
    frontmatter?: Record<string, unknown>;
    files?: SkillFileInput[];
  }): Promise<void>;
  /** 更新 SKILL.md frontmatter/body；files 会覆盖同名文件、新增不存在的文件。 */
  updateSkill(
    name: string,
    updates: {
      description?: string;
      body?: string;
      triggers?: string[];
      license?: string;
      frontmatter?: Record<string, unknown>;
      files?: SkillFileInput[];
    },
  ): Promise<boolean>;
  /** 删除整个 skill 文件夹 */
  deleteSkill(name: string): Promise<boolean>;
  /** 在某 skill 中添加/覆盖一个附属文件。 */
  addSkillFile(name: string, file: SkillFileInput): Promise<boolean>;
  /** 删除某 skill 下的一个附属文件（不能是 SKILL.md）。 */
  removeSkillFile(name: string, relPath: string): Promise<boolean>;
  /** 列出某 skill 下的所有文件相对路径。 */
  listSkillFiles(name: string): Promise<string[]>;
  /** 读取某 skill 下某附属文件的文本内容。 */
  readSkillFile(name: string, relPath: string): Promise<string | null>;
  /** 手动重扫描 */
  rescan(): Promise<void>;
  /** 标记某 session 已加载某 skill（下次 LLM 调用注入 body） */
  loadSkillForSession(sessionId: string, name: string): boolean;
  /** 获取 session 已加载的 skills */
  getLoadedSkills(sessionId: string): string[];
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const skills = defineService<SkillsService>('skills');

// ──────────── 插件元数据 ────────────

const configSchema: ConfigSchema = {
  skillsUri: {
    type: 'string',
    label: '技能存储 URI',
    default: 'data:/skills',
    description: '技能文件夹 storage URI（默认 data:/skills）。每个 skill 为一个子目录，含 SKILL.md。',
  },
  maxSkillBytes: {
    type: 'number',
    label: '单 skill 最大字节数',
    default: 200_000,
    description: 'SKILL.md 单文件最大字节数，避免一次加载过大内容污染上下文。',
  },
  maxSkills: {
    type: 'number',
    label: '技能数量上限',
    default: 200,
    description: '扫描时最多加载的 skill 数量。',
  },
  discoveryEnabled: {
    type: 'boolean',
    label: '启用 Discovery 注入',
    default: true,
    description:
      '往 system prompt 注入一行技能库路标，提示 agent 用 list_skills 检索、load_skill 加载技能；关闭时激活正文注入也一并停用。',
  },
  triggersEnabled: {
    type: 'boolean',
    label: '启用 triggers 自动激活',
    default: true,
    description: '匹配 SKILL.md frontmatter 中的 triggers regex 时自动加载该 skill。',
  },
};

const defaultConfig = {
  skillsUri: 'data:/skills',
  maxSkillBytes: 200_000,
  maxSkills: 200,
  discoveryEnabled: true,
  triggersEnabled: true,
};

// ──────────── WebUI 页面 ────────────

const webuiPages: WebuiPage[] = [
  {
    key: 'skills',
    label: '技能库 (Skills)',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>',
    order: 56,
    content: [
      {
        type: 'table',
        label: '技能列表',
        source: 'listSkills',
        columns: [
          { key: 'name', label: '名称', nowrap: true },
          { key: 'description', label: '描述', minWidth: 220, maxWidth: 360, render: 'expandable-text' },
          { key: 'triggers', label: '自动触发', nowrap: true },
          { key: 'fileCount', label: '资源', nowrap: true, minWidth: 160 },
          { key: 'dir', label: '路径', nowrap: true },
        ],
        actions: [
          { label: '查看', method: 'getSkill' },
          { label: '删除', method: 'deleteSkill', confirm: '确定删除该技能？', danger: true },
        ],
        refresh: 60,
      },
      {
        type: 'stat',
        label: '技能总数',
        source: 'getStats',
        icon: 'skills',
      },
    ],
  },
];

// ──────────── frontmatter 解析 ────────────

/** 解析 SKILL.md：分离 YAML frontmatter 与 markdown body。
 *  frontmatter 必须以 `---\n` 起头（第一行），以下一行 `---` 结束。 */
function parseSkillMd(text: string): { fm: SkillFrontmatter | null; body: string } {
  if (!text.startsWith('---')) return { fm: null, body: text };
  // 找到第二个 `---` 行
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== '---') return { fm: null, body: text };
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { fm: null, body: text };
  const fmText = lines.slice(1, endIdx).join('\n');
  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .replace(/^\n+/, '');
  try {
    const parsed = parseYaml(fmText) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return { fm: null, body: text };
    return { fm: parsed as SkillFrontmatter, body };
  } catch {
    return { fm: null, body: text };
  }
}

/** 生成 SKILL.md 文本（frontmatter + body） */
function buildSkillMd(fm: SkillFrontmatter, body: string): string {
  // 过滤 undefined
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) {
      clean[k] = v;
    }
  }
  const fmText = stringifyYaml(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${fmText}\n---\n\n${body.replace(/^\n+/, '')}`;
}

// ──────────── 辅助 ────────────

function resolveConfig(raw: Readonly<Record<string, unknown>>): SkillsConfig {
  return {
    skillsUri: (raw.skillsUri as string) ?? defaultConfig.skillsUri,
    maxSkillBytes: (raw.maxSkillBytes as number) ?? defaultConfig.maxSkillBytes,
    maxSkills: (raw.maxSkills as number) ?? defaultConfig.maxSkills,
    discoveryEnabled: (raw.discoveryEnabled as boolean) ?? defaultConfig.discoveryEnabled,
    triggersEnabled: (raw.triggersEnabled as boolean) ?? defaultConfig.triggersEnabled,
  };
}

function sanitizeFolderName(name: string): string {
  // 文件夹名仅允许 ASCII 字母数字 / -_，其他字符替换为 _；中文保留为 _
  const cleaned = name
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100);
  return cleaned || 'skill';
}

async function safeListFiles(storage: StorageService, uri: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (subUri: string, prefix: string): Promise<void> => {
    let result: Awaited<ReturnType<StorageService['list']>>;
    try {
      result = await storage.list(subUri);
    } catch {
      return;
    }
    for (const entry of result.entries) {
      if (entry.isDirectory) await walk(entry.uri, prefix ? `${prefix}/${entry.name}` : entry.name);
      else out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
    }
  };
  await walk(uri, '');
  return out.sort();
}

/** join storage URI 下子路径：abc:/x + y → abc:/x/y */
function joinUri(base: string, sub: string): string {
  const s = sub.replace(/^\/+/, '');
  if (base.endsWith('/')) return base + s;
  return `${base}/${s}`;
}

/**
 * 校验 skill 内附属文件的相对路径：
 * - 不能是 SKILL.md（由专用 frontmatter/body 写入）
 * - 不能为空、不能以 `/` 开头
 * - 不能包含 `..` 段
 * - 不能是 Windows 绝对路径（如 `C:\\`）
 * 返回规范化后的相对路径（统一用 `/`）。
 */
function validateSkillRelPath(relPath: string): string {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('relPath 必填且需为字符串');
  }
  const trimmed = relPath.trim().replace(/\\/g, '/');
  if (!trimmed) throw new Error('relPath 不能为空');
  if (trimmed.startsWith('/')) throw new Error(`relPath 不能以 / 开头: ${relPath}`);
  if (/^[a-zA-Z]:/.test(trimmed)) throw new Error(`relPath 不能为绝对路径: ${relPath}`);
  const segs = trimmed.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new Error(`relPath 含非法段 "${seg}": ${relPath}`);
    }
  }
  if (segs[segs.length - 1].toUpperCase() === 'SKILL.MD') {
    throw new Error('SKILL.md 请通过 description/body/frontmatter 字段更新，不要作为附属文件写入');
  }
  return trimmed;
}

// ──────────── 插件入口 ────────────

const uses = {
  tools: optional(tools),
  webui: optional(webuiServer),
  storage: optional(storage),
  persona: optional(persona),
  contributions,
  hooks,
  events,
  logger,
  config,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-skills',
  displayName: '技能系统 (Agent Skills)',
  subsystem: 'skills',
  configSchema,
  provides: [skills],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const { tools, webui, persona, contributions, hooks, events, provide } = caps;
  const logger = caps.logger.child('skills');
  const config = resolveConfig(caps.config);

  // 通过 storage gateway 访问 skills 目录；不直接耦合 fs。
  const storage = createStorageGateway(caps.storage);
  const skillsUri = config.skillsUri;

  // WebUI 页面
  for (const page of webuiPages) webui.registerPage(page);

  // ── 加载所有 skill ──
  /** key = skill.name；重扫收尾时整体替换 */
  let skillsCache = new Map<string, SkillDefinition>();

  async function loadSkillFromDir(dirUri: string): Promise<SkillDefinition | null> {
    const skillMdUri = joinUri(dirUri, 'SKILL.md');
    let raw: string;
    try {
      const st = await storage.stat(skillMdUri);
      if (st.size > config.maxSkillBytes) {
        logger.warn(`SKILL.md 超出大小限制 ${st.size}B > ${config.maxSkillBytes}B: ${dirUri}`);
        return null;
      }
      raw = (await storage.readFile(skillMdUri, 'utf-8')) as string;
    } catch {
      return null;
    }
    try {
      const { fm, body } = parseSkillMd(raw);
      if (!fm || typeof fm.name !== 'string' || typeof fm.description !== 'string') {
        logger.warn(`SKILL.md frontmatter 缺少 name/description: ${dirUri}`);
        return null;
      }
      const triggers = Array.isArray(fm.triggers) ? fm.triggers.filter(t => typeof t === 'string') : undefined;
      return {
        name: fm.name,
        description: fm.description,
        body,
        triggers,
        license: typeof fm.license === 'string' ? fm.license : undefined,
        uri: dirUri,
        scripts: await safeListFiles(storage, joinUri(dirUri, 'scripts')),
        references: await safeListFiles(storage, joinUri(dirUri, 'references')),
        assets: await safeListFiles(storage, joinUri(dirUri, 'assets')),
        raw,
      };
    } catch (err) {
      logger.warn(`加载 SKILL.md 失败: ${dirUri} - ${err}`);
      return null;
    }
  }

  // 重扫串行化：同一时刻只跑一次；进行中再触发，只排一次尾随重扫（期间的多次触发并成这一次）。
  // 每次扫描收尾时整体替换 skillsCache，并发的话，先开始、后收尾的那次会用读得早的旧结果盖掉新结果；
  // 同理，扫描在飞时经服务的写入由 resyncIfScanning 排尾随重扫。
  let scanning: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  function rescanSkills(): Promise<void> {
    if (queued) return queued;
    if (scanning) {
      // 本次扫描失败也照排尾随重扫，queued 不能停在一个已拒绝的 Promise 上
      const next = (): Promise<void> => {
        queued = undefined;
        return rescanSkills();
      };
      queued = scanning.then(next, next);
      return queued;
    }
    scanning = scanSkillsOnce().finally(() => {
      scanning = undefined;
    });
    return scanning;
  }

  // 扫描在飞时经服务写入：进行中的那次扫描可能在写之前就读过目录或文件，收尾整体替换会把这次写盖掉，
  // 排一次尾随重扫按盘上实况重建
  function resyncIfScanning(): void {
    if (scanning) rescanSkills().catch(err => logger.warn(`写入后重扫 skills 失败：${err}`));
  }

  async function scanSkillsOnce(): Promise<void> {
    // 结果先写进局部 Map：扫描期间读者看到的是上一版完整缓存，不是清空后逐个补回的半截
    const found = new Map<string, SkillDefinition>();
    let count = 0;
    const walk = async (uri: string, depth: number): Promise<void> => {
      if (count >= config.maxSkills || depth > 4) return;
      let result: Awaited<ReturnType<StorageService['list']>>;
      try {
        result = await storage.list(uri);
      } catch {
        return;
      }
      for (const entry of result.entries) {
        if (count >= config.maxSkills) return;
        if (entry.name.startsWith('.')) continue;
        if (!entry.isDirectory) continue;
        const skill = await loadSkillFromDir(entry.uri);
        if (skill) {
          if (found.has(skill.name)) {
            logger.warn(`重复 skill 名称 "${skill.name}"，跳过 ${entry.uri}（已存在于 ${found.get(skill.name)?.uri}）`);
            continue;
          }
          found.set(skill.name, skill);
          count++;
        } else {
          // 没有 SKILL.md 的目录递归向下找
          await walk(entry.uri, depth + 1);
        }
      }
    };
    await walk(skillsUri, 0);
    // 扫完整体替换；按名字缓存的已编译 triggers 随旧缓存一并作废（改了 triggers 的技能要重新编译）
    skillsCache = found;
    compiledTriggers.clear();
  }

  // ── 编译 triggers regex（缓存） ──
  const compiledTriggers = new Map<string, RegExp[]>();
  function getTriggersFor(skill: SkillDefinition): RegExp[] {
    if (!skill.triggers || skill.triggers.length === 0) return [];
    const cached = compiledTriggers.get(skill.name);
    if (cached) return cached;
    const list: RegExp[] = [];
    for (const t of skill.triggers) {
      try {
        list.push(new RegExp(t, 'i'));
      } catch (err) {
        logger.warn(`skill "${skill.name}" trigger regex 编译失败 "${t}": ${err}`);
      }
    }
    compiledTriggers.set(skill.name, list);
    return list;
  }

  // ── session 加载状态 ──
  /** sessionId → Set<skillName>，已加载 = 下次 LLM 调用注入 body */
  const sessionLoaded = new Map<string, Set<string>>();
  function ensureSessionSet(sessionId: string): Set<string> {
    let s = sessionLoaded.get(sessionId);
    if (!s) {
      s = new Set();
      sessionLoaded.set(sessionId, s);
    }
    return s;
  }

  // ── 获取 persona 允许的 skill 白名单 ──
  function getAllowedSkills(): SkillDefinition[] {
    const all = [...skillsCache.values()];
    const whitelist = persona.current?.getPersonaSkills?.();
    if (whitelist === undefined) return all;
    const set = new Set(whitelist);
    return all.filter(s => set.has(s.name));
  }

  // ── 注入源标记 ──
  const DISCOVERY_SOURCE = 'skills-discovery';
  const ACTIVATION_SOURCE_PREFIX = 'skills-activation:';

  // ── Discovery: agent:prompt 贡献（knowledge 槽）注入一行静态路标 ──
  // 不注入技能清单本身：清单随技能增删变化会打前缀缓存，且体积随技能数线性膨胀。
  // 路标是常量文本，具体技能靠 list_skills 检索（keyword 匹配 / offset 翻页）。
  if (config.discoveryEnabled) {
    contributions.contribute('agent:prompt', {
      id: DISCOVERY_SOURCE,
      anchor: 'knowledge',
      build() {
        if (getAllowedSkills().length === 0) return null;
        return (
          '存在可复用技能库。当任务可能有现成技能（专项工作流、操作指引等）时，' +
          '先调用 list_skills 检索（可传 keyword，翻页用 offset），' +
          '再调用 load_skill(name) 加载所需技能的完整指令。'
        );
      },
    });
  }

  // ── 激活正文：每个被激活过的 skill 一份贡献（knowledge 槽）──
  // spec 在技能首次激活时注册（同名幂等）；build 按 view.sessionId 判断该会话
  // 是否加载。回合中途 load_skill 新激活的技能，其贡献键尚未物化，组装器在
  // 下一轮 LLM 调用前增量落位——这是旧 middleware 逐轮补注语义的等价表达。
  const activationContributed = new Set<string>();
  /** 归一后的局部 id → 首个占用它的 skill 名（检测 '/'→'_' 替换造成的同形碰撞） */
  const activationIdOwner = new Map<string, string>();
  function contributeActivation(skillName: string): void {
    // 与旧行为一致：skills 的 prompt 注入（含激活正文）整体随 discoveryEnabled 开关
    if (!config.discoveryEnabled || activationContributed.has(skillName)) return;
    // 内核全局键禁含 '/'，病态 skill 名（如 'a/b'）需归一。归一后可能与另一个
    // 真实存在的名字（'a_b'）撞成同一贡献键——注册表是替换语义，撞了就有一方的
    // 正文永远注入不进去。保住先占者并点名告警，别让它静默消失。
    const localId = ACTIVATION_SOURCE_PREFIX + skillName.replaceAll('/', '_');
    const owner = activationIdOwner.get(localId);
    if (owner !== undefined && owner !== skillName) {
      logger.warn(
        `skill "${skillName}" 与 "${owner}" 归一后共用同一贡献键 "${localId}"（'/' 被替换为 '_'）；` +
          `保留先注册的 "${owner}"，"${skillName}" 的正文将无法注入——请重命名其中一个（避免名字里用 '/'）。`,
      );
      return;
    }
    activationIdOwner.set(localId, skillName);
    activationContributed.add(skillName);
    contributions.contribute('agent:prompt', {
      id: localId,
      anchor: 'knowledge',
      build(view) {
        if (!view.sessionId || !sessionLoaded.get(view.sessionId)?.has(skillName)) return null;
        const skill = skillsCache.get(skillName);
        if (!skill) return null;
        const resourceLines: string[] = [];
        if (skill.scripts.length > 0)
          resourceLines.push(`- scripts/: ${skill.scripts.join(', ')}（可用 code_runner 等工具执行）`);
        if (skill.references.length > 0)
          resourceLines.push(`- references/: ${skill.references.join(', ')}（按需读取该文件获取详细参考）`);
        if (skill.assets.length > 0) resourceLines.push(`- assets/: ${skill.assets.join(', ')}（模板/资源）`);
        const resources =
          resourceLines.length > 0 ? `\n\n附属资源（位于 ${skill.uri}）：\n${resourceLines.join('\n')}` : '';
        return `═══ Skill 已激活: ${skill.name} ═══\n${skill.body}${resources}\n═════════════════════════════`;
      },
    });
  }

  // ── 自动激活：agent:input:before 监听 user message 文本 ──
  if (config.triggersEnabled) {
    hooks.middleware('agent:input:before', async (data, next) => {
      const sessionId = data.message?.sessionId;
      const text = data.message?.content;
      if (sessionId && typeof text === 'string' && text.length > 0) {
        const visible = getAllowedSkills();
        const session = ensureSessionSet(sessionId);
        // ReDoS 兜底：triggers 现仅由 sensitive 门禁的 skill 工具写入，但仍对被测输入截断上界，
        // 使任意（含病态回溯）正则的匹配耗时有界。触发匹配只需看开头一段，2000 字符足够。
        const probe = text.length > 2000 ? text.slice(0, 2000) : text;
        for (const skill of visible) {
          if (session.has(skill.name)) continue;
          const regexes = getTriggersFor(skill);
          for (const re of regexes) {
            if (re.test(probe)) {
              session.add(skill.name);
              contributeActivation(skill.name);
              logger.info(`skill "${skill.name}" 已自动激活 (session=${sessionId}, regex=${re})`);
              break;
            }
          }
        }
      }
      await next();
    });
  }

  /** 写一个附属文件：校验相对路径与大小上限后落盘，返回规范化后的相对路径 */
  async function writeSkillFile(dirUri: string, f: SkillFileInput): Promise<string> {
    const rel = validateSkillRelPath(f.relPath);
    const byteLen = typeof f.content === 'string' ? Buffer.byteLength(f.content, 'utf-8') : f.content.byteLength;
    if (byteLen > config.maxSkillBytes) {
      throw new Error(`附属文件 ${rel} 超出大小限制 ${byteLen}B > ${config.maxSkillBytes}B`);
    }
    await storage.writeFile(joinUri(dirUri, rel), typeof f.content === 'string' ? f.content : Buffer.from(f.content));
    return rel;
  }

  // ── 服务实现 ──
  const service: SkillsService = {
    listSkills() {
      return [...skillsCache.values()];
    },
    getSkill(skillName) {
      return skillsCache.get(skillName);
    },
    async createSkill(input) {
      if (skillsCache.size >= config.maxSkills) {
        throw new Error(`技能数量已达上限 (${config.maxSkills})`);
      }
      if (!input.name || !input.description) {
        throw new Error('name 和 description 必填');
      }
      if (skillsCache.has(input.name)) {
        throw new Error(`技能 "${input.name}" 已存在`);
      }
      const folderName = sanitizeFolderName(input.name);
      const dirUri = joinUri(skillsUri, folderName);
      // 检查目标目录是否已存在（通过 stat 探测）
      try {
        await storage.stat(dirUri);
        throw new Error(`目标目录已存在: ${dirUri}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('目标目录已存在')) throw err;
        // ENOENT / not found → 可以创建
      }
      const fm: SkillFrontmatter = {
        ...(input.frontmatter ?? {}),
        name: input.name,
        description: input.description,
        ...(input.triggers && input.triggers.length > 0 ? { triggers: input.triggers } : {}),
        ...(input.license ? { license: input.license } : {}),
      };
      const md = buildSkillMd(fm, input.body ?? '');
      if (md.length > config.maxSkillBytes) {
        throw new Error(`SKILL.md 超出大小限制 ${md.length}B > ${config.maxSkillBytes}B`);
      }
      // writeFile 会自动创建父目录
      await storage.writeFile(joinUri(dirUri, 'SKILL.md'), md);
      // 写入附属文件
      if (input.files && input.files.length > 0) {
        for (const f of input.files) await writeSkillFile(dirUri, f);
      }
      const loaded = await loadSkillFromDir(dirUri);
      if (loaded) skillsCache.set(loaded.name, loaded);
      resyncIfScanning();
      logger.info(
        `技能已创建: ${input.name} (${dirUri})${input.files && input.files.length > 0 ? ` + ${input.files.length} 个附属文件` : ''}`,
      );
    },
    async updateSkill(skillName, updates) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      const { fm: oldFm } = parseSkillMd(existing.raw);
      // 新值压过旧值（反过来的话除 description/triggers/license 外任何已存在的键都改不动）
      const fm: SkillFrontmatter = {
        ...(oldFm ?? {
          name: existing.name,
          description: existing.description,
          ...(existing.triggers ? { triggers: existing.triggers } : {}),
          ...(existing.license ? { license: existing.license } : {}),
        }),
        ...(updates.frontmatter ?? {}),
      };
      // 名字钉死：目录名由创建时的 sanitizeFolderName(name) 决定，改名会让卡片脱离自己的目录
      fm.name = existing.name;
      if (updates.description !== undefined) fm.description = updates.description;
      if (updates.triggers !== undefined) fm.triggers = updates.triggers;
      if (updates.license !== undefined) fm.license = updates.license;
      const body = updates.body !== undefined ? updates.body : existing.body;
      const md = buildSkillMd(fm, body);
      if (md.length > config.maxSkillBytes) {
        throw new Error(`SKILL.md 超出大小限制 ${md.length}B > ${config.maxSkillBytes}B`);
      }
      await storage.writeFile(joinUri(existing.uri, 'SKILL.md'), md);
      if (updates.files && updates.files.length > 0) {
        for (const f of updates.files) await writeSkillFile(existing.uri, f);
      }
      const reloaded = await loadSkillFromDir(existing.uri);
      if (reloaded) {
        skillsCache.set(reloaded.name, reloaded);
        compiledTriggers.delete(reloaded.name);
      }
      resyncIfScanning();
      logger.info(`技能已更新: ${skillName}`);
      return true;
    },
    async deleteSkill(skillName) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      try {
        await storage.delete(existing.uri);
      } catch (err) {
        logger.warn(`删除技能目录失败 ${existing.uri}: ${err}`);
      }
      skillsCache.delete(skillName);
      compiledTriggers.delete(skillName);
      for (const set of sessionLoaded.values()) set.delete(skillName);
      resyncIfScanning();
      logger.info(`技能已删除: ${skillName}`);
      return true;
    },
    async addSkillFile(skillName, file) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      const rel = await writeSkillFile(existing.uri, file);
      const reloaded = await loadSkillFromDir(existing.uri);
      if (reloaded) skillsCache.set(reloaded.name, reloaded);
      resyncIfScanning();
      logger.info(`技能 ${skillName} 已写入附属文件: ${rel}`);
      return true;
    },
    async removeSkillFile(skillName, relPath) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      const rel = validateSkillRelPath(relPath);
      try {
        await storage.delete(joinUri(existing.uri, rel));
      } catch (err) {
        logger.warn(`删除附属文件失败 ${rel}: ${err}`);
        return false;
      }
      const reloaded = await loadSkillFromDir(existing.uri);
      if (reloaded) skillsCache.set(reloaded.name, reloaded);
      resyncIfScanning();
      logger.info(`技能 ${skillName} 已删除附属文件: ${rel}`);
      return true;
    },
    async listSkillFiles(skillName) {
      const existing = skillsCache.get(skillName);
      if (!existing) return [];
      const all = await safeListFiles(storage, existing.uri);
      return all.filter(p => p !== 'SKILL.md');
    },
    async readSkillFile(skillName, relPath) {
      const existing = skillsCache.get(skillName);
      if (!existing) return null;
      const rel = validateSkillRelPath(relPath);
      try {
        const raw = (await storage.readFile(joinUri(existing.uri, rel))) as Uint8Array;
        return Buffer.from(raw).toString('utf-8');
      } catch {
        return null;
      }
    },
    async rescan() {
      await rescanSkills();
    },
    loadSkillForSession(sessionId, skillName) {
      if (!skillsCache.has(skillName)) return false;
      ensureSessionSet(sessionId).add(skillName);
      contributeActivation(skillName);
      return true;
    },
    getLoadedSkills(sessionId) {
      const s = sessionLoaded.get(sessionId);
      return s ? [...s] : [];
    },
  };

  provide(skills, service);

  // ── 页面动作：直接读这次激活自己的服务实例，页面与服务同生共死 ──
  webui.registerAction('listSkills', async () =>
    service.listSkills().map(s => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers?.join(', ') || '',
      fileCount: `脚本 ${s.scripts.length} / 引用 ${s.references.length} / 资源 ${s.assets.length}`,
      dir: s.uri,
    })),
  );

  webui.registerAction('getSkill', async args => {
    const s = service.getSkill(args.name as string);
    if (!s) return { error: '技能不存在' };
    return {
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      license: s.license,
      dir: s.uri,
      scripts: s.scripts,
      references: s.references,
      assets: s.assets,
      raw: s.raw,
    };
  });

  webui.registerAction('deleteSkill', async args =>
    (await service.deleteSkill(args.name as string)) ? { ok: true } : { error: '技能不存在' },
  );

  webui.registerAction('getStats', async () => ({ value: service.listSkills().length }));

  // ── 注册工具分组与工具 ──
  tools.registerGroup({
    name: 'skills',
    label: '技能管理',
    description: '查询、加载、创建、更新和删除可复用的 Agent Skills（兼容 Anthropic SKILL.md 标准）',
  });

  // 1. load_skill —— 核心：把指定 skill 的 SKILL.md body 注入下一轮上下文
  tools.register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'load_skill',
        description:
          '加载指定 skill 的完整 SKILL.md 内容到当前会话上下文。加载后下一次模型调用会自动看到该 skill 的详细指令与附属资源清单（scripts/references/assets）。技能可先用 list_skills 检索；当某个技能的 description 匹配当前任务时调用本工具。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要加载的 skill 名称（必须是已存在的 skill）' },
          },
          required: ['name'],
        },
      },
    },
    handler: async (args, callCtx) => {
      const skillName = String(args.name ?? '').trim();
      if (!skillName) return JSON.stringify({ error: 'name 不能为空' });
      let skill = skillsCache.get(skillName);
      // 若缓存未命中，先 lazy rescan 一次再试
      if (!skill) {
        await rescanSkills();
        skill = skillsCache.get(skillName);
      }
      if (!skill) return JSON.stringify({ error: `skill "${skillName}" 不存在` });
      const sessionId = callCtx?.sessionId;
      if (!sessionId) {
        // 无 sessionId 直接返回 body
        return JSON.stringify({
          ok: true,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          scripts: skill.scripts,
          references: skill.references,
          assets: skill.assets,
        });
      }
      service.loadSkillForSession(sessionId, skill.name);
      return JSON.stringify({
        ok: true,
        message: `skill "${skill.name}" 已激活；详细指令将在下一次模型调用时注入上下文。`,
        scripts: skill.scripts,
        references: skill.references,
        assets: skill.assets,
      });
    },
  });

  // 2. list_skills —— 按关键词/triggers 状态筛选
  tools.register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'list_skills',
        description:
          '列出可用 skills（受角色卡白名单过滤后），可按关键词模糊匹配 name/description。翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：name/description 子串模糊匹配（不区分大小写）' },
            limit: { type: 'number', description: '本页最多返回条数，默认 30' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
          },
        },
      },
    },
    handler: async args => {
      // 若缓存为空，先做一次 lazy rescan（覆盖"服务启动后才放入 skill"的场景）
      if (skillsCache.size === 0) await rescanSkills();
      const visible = getAllowedSkills();
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const filtered = visible.filter(s => {
        if (!keyword) return true;
        return `${s.name} ${s.description}`.toLowerCase().includes(keyword);
      });
      const limit = Math.max(1, Math.floor(Number(args.limit) || 30));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const page = filtered.slice(offset, offset + limit);
      return JSON.stringify({
        total: visible.length,
        matched: filtered.length,
        limit,
        offset,
        returned: page.length,
        has_more: offset + page.length < filtered.length,
        skills: page.map(s => ({
          name: s.name,
          description: s.description,
          hasTriggers: !!(s.triggers && s.triggers.length > 0),
          scripts: s.scripts.length,
          references: s.references.length,
          assets: s.assets.length,
        })),
      });
    },
  });

  // 3. skill_create
  tools.register({
    // 变更类：写入的技能构成持久注入面（triggers 命中自动激活 + load_skill 正文注入），标 sensitive
    // 挡住不受信任访客经 LLM 驱动；无逐次 confirm（避免给 owner 加摩擦）。
    risk: 'sensitive',
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_create',
        description:
          '创建一个新的 Agent Skill（生成 data/skills/<name>/SKILL.md 文件夹）。' +
          'name 与 description 必填；description 应包含"何时使用"以提高自动激活准确率。' +
          '可选 files 数组用于一次性写入 scripts/、references/、assets/、LICENSE.txt 等附属资源，' +
          '符合 Anthropic Agent Skills 完整目录结构。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'skill 唯一名称' },
            description: {
              type: 'string',
              description: 'skill 描述（含何时使用）。这是 LLM 决定是否激活该 skill 的主要依据。',
            },
            body: { type: 'string', description: 'SKILL.md 正文（markdown 指令）' },
            triggers: {
              type: 'array',
              description: '可选：regex 字符串列表；匹配到用户消息时自动激活该 skill',
            },
            license: { type: 'string', description: '可选：许可证说明' },
            frontmatter: {
              type: 'object',
              description: '可选：额外 YAML frontmatter 字段（例如 compatibility）。name/description 由专用字段覆盖。',
            },
            files: {
              type: 'array',
              description:
                '可选：附属文件列表，每项 { relPath, content }。relPath 相对 skill 根目录，' +
                '禁止 SKILL.md / 绝对路径 / `..`。典型布局：scripts/run.sh、references/api.md、assets/template.json、LICENSE.txt。',
              items: {
                type: 'object',
                properties: {
                  relPath: { type: 'string', description: '相对 skill 根的路径，如 scripts/run.sh' },
                  content: { type: 'string', description: '文件文本内容' },
                },
                required: ['relPath', 'content'],
              },
            },
          },
          required: ['name', 'description'],
        },
      },
    },
    handler: async args => {
      try {
        await service.createSkill({
          name: args.name as string,
          description: args.description as string,
          body: args.body as string | undefined,
          triggers: args.triggers as string[] | undefined,
          license: args.license as string | undefined,
          frontmatter: args.frontmatter as Record<string, unknown> | undefined,
          files: args.files as SkillFileInput[] | undefined,
        });
        return JSON.stringify({ ok: true, message: `技能 "${args.name}" 已创建` });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 4. skill_update
  tools.register({
    risk: 'sensitive',
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_update',
        description: '更新一个已有 skill 的 description / body / triggers / license / frontmatter / files。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要更新的 skill 名称' },
            description: { type: 'string', description: '新的描述' },
            body: { type: 'string', description: '新的 SKILL.md 正文' },
            triggers: { type: 'array', description: '新的 triggers regex 列表' },
            license: { type: 'string', description: '新的 license' },
            frontmatter: {
              type: 'object',
              description: '额外 frontmatter 字段（覆盖同名旧字段）；name 除外，技能名不可改。',
            },
            files: {
              type: 'array',
              description: '要写入/覆盖的附属文件，每项 { relPath, content }。同名直接覆盖，不存在则新增。',
              items: {
                type: 'object',
                properties: {
                  relPath: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['relPath', 'content'],
              },
            },
          },
          required: ['name'],
        },
      },
    },
    handler: async args => {
      try {
        const ok = await service.updateSkill(args.name as string, {
          description: args.description as string | undefined,
          body: args.body as string | undefined,
          triggers: args.triggers as string[] | undefined,
          license: args.license as string | undefined,
          frontmatter: args.frontmatter as Record<string, unknown> | undefined,
          files: args.files as SkillFileInput[] | undefined,
        });
        return JSON.stringify({ ok, message: ok ? '已更新' : 'skill 不存在' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 5. skill_delete
  tools.register({
    // 破坏性（递归删除整个 skill 目录）：restricted+confirm 按「写删」约定；
    // 不带 risk——capabilityMinLevel 里 risk 遮蔽 visibility，同标会把门槛从 2 降到 1。
    // owner 开 auto 确认模式时 session 确认自动跳过，零摩擦。
    visibility: 'restricted',
    confirm: 'session',
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_delete',
        description: '删除一个 skill（连同整个文件夹）。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要删除的 skill 名称' },
          },
          required: ['name'],
        },
      },
    },
    handler: async args => {
      const ok = await service.deleteSkill(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已删除' : 'skill 不存在' });
    },
  });

  // 6. skill_add_file —— 单独添加/覆盖一个附属文件
  tools.register({
    risk: 'sensitive',
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_add_file',
        description:
          '为指定 skill 增量写入一个附属文件（scripts/、references/、assets/、LICENSE.txt 等）。' +
          '同名文件会被覆盖；relPath 禁止使用 SKILL.md、绝对路径或 `..`。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '目标 skill 名称' },
            relPath: { type: 'string', description: '相对 skill 根的路径，如 scripts/run.sh' },
            content: { type: 'string', description: '文件文本内容' },
          },
          required: ['skill', 'relPath', 'content'],
        },
      },
    },
    handler: async args => {
      try {
        const ok = await service.addSkillFile(args.skill as string, {
          relPath: args.relPath as string,
          content: args.content as string,
        });
        return JSON.stringify({ ok, message: ok ? '已写入' : 'skill 不存在' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 7. skill_remove_file
  tools.register({
    // 破坏性（删 skill 内文件）：同 skill_delete，restricted+confirm，不带 risk（防降档）
    visibility: 'restricted',
    confirm: 'session',
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_remove_file',
        description: '删除某 skill 下的一个附属文件（不能是 SKILL.md）。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '目标 skill 名称' },
            relPath: { type: 'string', description: '相对 skill 根的路径' },
          },
          required: ['skill', 'relPath'],
        },
      },
    },
    handler: async args => {
      try {
        const ok = await service.removeSkillFile(args.skill as string, args.relPath as string);
        return JSON.stringify({ ok, message: ok ? '已删除' : 'skill 不存在或文件不存在' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 8. skill_list_files
  tools.register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_list_files',
        description: '列出某 skill 目录下所有附属文件（不含 SKILL.md）的相对路径。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '目标 skill 名称' },
          },
          required: ['skill'],
        },
      },
    },
    handler: async args => {
      const files = await service.listSkillFiles(args.skill as string);
      return JSON.stringify({ skill: args.skill, count: files.length, files });
    },
  });

  // 9. skill_read_file
  tools.register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_read_file',
        description: '读取某 skill 下某附属文件的文本内容。二进制文件会按 UTF-8 解码，可能乱码。',
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: '目标 skill 名称' },
            relPath: { type: 'string', description: '相对 skill 根的路径' },
          },
          required: ['skill', 'relPath'],
        },
      },
    },
    handler: async args => {
      try {
        const content = await service.readSkillFile(args.skill as string, args.relPath as string);
        if (content == null) return JSON.stringify({ error: 'skill 不存在或文件不存在' });
        return JSON.stringify({ skill: args.skill, relPath: args.relPath, content });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 10. skill_rescan —— 手动重新扫描目录（便于外部添加 skill 后无需重启）
  tools.register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_rescan',
        description: '重新扫描 skills 目录（手动添加文件夹后调用）。',
        parameters: { type: 'object', properties: {} },
      },
    },
    handler: async () => {
      await service.rescan();
      return JSON.stringify({ ok: true, count: skillsCache.size });
    },
  });

  // ── 跟随 storage：在场即补建目录、挂监听、全量扫描；提供者换代（重启 / 改配置 / 晚上线）时重挂 ──
  // 换代时 follow 先跑上次返回的清理，关掉挂在旧提供者上的监听。
  // 首挂放在 sticky 的 app:ready 里并等它扫完，保持「start() 返回时技能已加载」；此刻 storage 不在场则等它上线再挂。
  async function rescanAndLog(level: 'info' | 'debug', reason: string): Promise<void> {
    try {
      await service.rescan();
      logger[level](`skills ${reason} uri=${skillsUri}，现有 ${skillsCache.size} 个技能`);
    } catch (err) {
      logger.warn(`扫描 skills 失败（${reason}）：${err}`);
    }
  }
  events.on('app:ready', async () => {
    let first: Promise<void> | undefined;
    caps.storage.follow(() => {
      let off: (() => void) | undefined;
      let cancelled = false;
      const task = (async () => {
        // 首启目录尚不存在时 watch 会 ENOENT：先补建；与监听分开，mkdir 失败（只读根 / 符号链接）不连带放弃监听
        try {
          await storage.stat(skillsUri);
        } catch {
          try {
            await storage.mkdir(skillsUri);
          } catch {
            /* 建不了就照旧：下面的监听会给出失败原因 */
          }
        }
        if (cancelled) return;
        // 先挂监听再扫描：扫描期间的改动不会漏掉（由它触发的重扫排在本次扫描之后）。
        // storage 层只按路径去抖，多次触发的合并靠 rescanSkills 的串行化
        try {
          off = storage.watch?.(skillsUri, () => void rescanAndLog('debug', '目录变化，已重新扫描'));
        } catch (err) {
          logger.warn(`skills 目录监听启动失败，请手动调用 skill_rescan: ${err}`);
        }
        await rescanAndLog('info', '已扫描');
      })();
      first ??= task;
      return () => {
        cancelled = true;
        off?.();
      };
    });
    await first;
  });
}
