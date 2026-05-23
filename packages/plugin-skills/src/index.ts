import { Buffer } from 'node:buffer';
import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import type { PersonaService } from '@aalis/plugin-persona-api';
import { createStorageGateway, type StorageService } from '@aalis/plugin-storage-api';
import { useToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-tools-api';

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
//   1. Discovery: 启动注入 `[name] description` 列表到 system prompt
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

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-skills';
export const displayName = '技能系统 (Agent Skills)';
export const subsystem = 'skills';

export const provides = ['skills'];

export const configSchema: ConfigSchema = {
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
    description: '启动时把所有 skill 的 name+description 列表注入 system prompt，方便 agent 按需 load_skill。',
  },
  triggersEnabled: {
    type: 'boolean',
    label: '启用 triggers 自动激活',
    default: true,
    description: '匹配 SKILL.md frontmatter 中的 triggers regex 时自动加载该 skill。',
  },
};

export const defaultConfig = {
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
          { key: 'description', label: '描述', minWidth: 220, render: 'expandable-text' },
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

export const actions: PluginModule['actions'] = {
  async listSkills(ctx) {
    const svc = ctx.getService<SkillsService>('skills');
    if (!svc) return [];
    return svc.listSkills().map(s => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers?.join(', ') || '',
      fileCount: `脚本 ${s.scripts.length} / 引用 ${s.references.length} / 资源 ${s.assets.length}`,
      dir: s.uri,
    }));
  },
  async getSkill(ctx, args) {
    const svc = ctx.getService<SkillsService>('skills');
    const s = svc?.getSkill(args.name as string);
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
  },
  async deleteSkill(ctx, args) {
    const svc = ctx.getService<SkillsService>('skills');
    return (await svc?.deleteSkill(args.name as string)) ? { ok: true } : { error: '技能不存在' };
  },
  async getStats(ctx) {
    const svc = ctx.getService<SkillsService>('skills');
    return { value: svc?.listSkills().length ?? 0 };
  },
};

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

function resolveConfig(raw: Record<string, unknown>): SkillsConfig {
  // 向后兼容：旧字段 skillsDir（如 'data/skills'） → storage URI 'data:/skills'
  let skillsUri = (raw.skillsUri as string) ?? defaultConfig.skillsUri;
  if (!raw.skillsUri && typeof raw.skillsDir === 'string') {
    const s = (raw.skillsDir as string).trim().replace(/^\.?\/+/, '');
    const slashIdx = s.indexOf('/');
    if (slashIdx > 0) {
      skillsUri = `${s.slice(0, slashIdx)}:/${s.slice(slashIdx + 1)}`;
    } else if (s) {
      skillsUri = `${s}:/`;
    }
  }
  return {
    skillsUri,
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

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('skills');

  // 通过 storage gateway 访问 skills 目录；不直接耦合 fs。
  const storage = createStorageGateway(ctx);
  const skillsUri = config.skillsUri;

  // WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // ── 加载所有 skill ──
  /** key = skill.name */
  const skillsCache = new Map<string, SkillDefinition>();

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

  async function rescanSkills(): Promise<void> {
    skillsCache.clear();
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
          if (skillsCache.has(skill.name)) {
            logger.warn(
              `重复 skill 名称 "${skill.name}"，跳过 ${entry.uri}（已存在于 ${skillsCache.get(skill.name)?.uri}）`,
            );
            continue;
          }
          skillsCache.set(skill.name, skill);
          count++;
        } else {
          // 没有 SKILL.md 的目录递归向下找
          await walk(entry.uri, depth + 1);
        }
      }
    };
    await walk(skillsUri, 0);
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
    const persona = ctx.getService<PersonaService>('persona');
    const whitelist = persona?.getPersonaSkills?.();
    if (whitelist === undefined) return all;
    const set = new Set(whitelist);
    return all.filter(s => set.has(s.name));
  }

  // ── 注入源标记 ──
  const DISCOVERY_SOURCE = 'skills-discovery';
  const ACTIVATION_SOURCE_PREFIX = 'skills-activation:';

  // ── Discovery: agent:llm:before 注入可用 skill 列表 ──
  if (config.discoveryEnabled) {
    ctx.middleware('agent:llm:before', async (data, next) => {
      // 防重：同一 messages 数组中已有 discovery system 块就跳过
      const hasDiscovery = data.messages.some(m => m.role === 'system' && m.metadata?.source === DISCOVERY_SOURCE);
      const visible = getAllowedSkills();
      if (!hasDiscovery && visible.length > 0) {
        const lines = visible.map(s => `- ${s.name}: ${s.description}`);
        const block =
          `📚 可用技能（共 ${visible.length}，按需调用 load_skill(name="...") 加载完整指令）：\n${lines.join('\n')}\n\n` +
          '当你识别到当前任务匹配某个技能时，先调用 load_skill 获取详细操作步骤，再继续执行。';
        const idx = data.messages.findIndex(m => m.role !== 'system');
        const insertIdx = idx === -1 ? data.messages.length : idx;
        data.messages.splice(insertIdx, 0, {
          role: 'system',
          content: block,
          metadata: { source: DISCOVERY_SOURCE },
        });
      }

      // 注入 session 已激活的 skill body（每个 skill 一个 system 块，按需）
      if (data.sessionId) {
        const loaded = sessionLoaded.get(data.sessionId);
        if (loaded && loaded.size > 0) {
          for (const skillName of loaded) {
            const sourceTag = ACTIVATION_SOURCE_PREFIX + skillName;
            const already = data.messages.some(m => m.role === 'system' && m.metadata?.source === sourceTag);
            if (already) continue;
            const skill = skillsCache.get(skillName);
            if (!skill) continue;
            const resourceLines: string[] = [];
            if (skill.scripts.length > 0)
              resourceLines.push(`- scripts/: ${skill.scripts.join(', ')}（可用 code_runner 等工具执行）`);
            if (skill.references.length > 0)
              resourceLines.push(`- references/: ${skill.references.join(', ')}（按需读取该文件获取详细参考）`);
            if (skill.assets.length > 0) resourceLines.push(`- assets/: ${skill.assets.join(', ')}（模板/资源）`);
            const resources =
              resourceLines.length > 0 ? `\n\n附属资源（位于 ${skill.uri}）：\n${resourceLines.join('\n')}` : '';
            const block = `═══ Skill 已激活: ${skill.name} ═══\n${skill.body}${resources}\n═════════════════════════════`;
            const idx = data.messages.findIndex(m => m.role !== 'system');
            const insertIdx = idx === -1 ? data.messages.length : idx;
            data.messages.splice(insertIdx, 0, {
              role: 'system',
              content: block,
              metadata: { source: sourceTag },
            });
          }
        }
      }

      await next();
    });
  }

  // ── 自动激活：agent:input:before 监听 user message 文本 ──
  if (config.triggersEnabled) {
    ctx.middleware('agent:input:before', async (data, next) => {
      const sessionId = data.message?.sessionId;
      const text = data.message?.content;
      if (sessionId && typeof text === 'string' && text.length > 0) {
        const visible = getAllowedSkills();
        const session = ensureSessionSet(sessionId);
        for (const skill of visible) {
          if (session.has(skill.name)) continue;
          const regexes = getTriggersFor(skill);
          for (const re of regexes) {
            if (re.test(text)) {
              session.add(skill.name);
              logger.info(`skill "${skill.name}" 已自动激活 (session=${sessionId}, regex=${re})`);
              break;
            }
          }
        }
      }
      await next();
    });
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
        for (const f of input.files) {
          const rel = validateSkillRelPath(f.relPath);
          const byteLen = typeof f.content === 'string' ? Buffer.byteLength(f.content, 'utf-8') : f.content.byteLength;
          if (byteLen > config.maxSkillBytes) {
            throw new Error(`附属文件 ${rel} 超出大小限制 ${byteLen}B > ${config.maxSkillBytes}B`);
          }
          await storage.writeFile(
            joinUri(dirUri, rel),
            typeof f.content === 'string' ? f.content : Buffer.from(f.content),
          );
        }
      }
      const loaded = await loadSkillFromDir(dirUri);
      if (loaded) skillsCache.set(loaded.name, loaded);
      logger.info(
        `技能已创建: ${input.name} (${dirUri})${input.files && input.files.length > 0 ? ` + ${input.files.length} 个附属文件` : ''}`,
      );
    },
    async updateSkill(skillName, updates) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      const { fm: oldFm } = parseSkillMd(existing.raw);
      const fm: SkillFrontmatter = {
        ...(updates.frontmatter ?? {}),
        ...(oldFm ?? {
          name: existing.name,
          description: existing.description,
          ...(existing.triggers ? { triggers: existing.triggers } : {}),
          ...(existing.license ? { license: existing.license } : {}),
        }),
      };
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
        for (const f of updates.files) {
          const rel = validateSkillRelPath(f.relPath);
          const byteLen = typeof f.content === 'string' ? Buffer.byteLength(f.content, 'utf-8') : f.content.byteLength;
          if (byteLen > config.maxSkillBytes) {
            throw new Error(`附属文件 ${rel} 超出大小限制 ${byteLen}B > ${config.maxSkillBytes}B`);
          }
          await storage.writeFile(
            joinUri(existing.uri, rel),
            typeof f.content === 'string' ? f.content : Buffer.from(f.content),
          );
        }
      }
      const reloaded = await loadSkillFromDir(existing.uri);
      if (reloaded) {
        skillsCache.set(reloaded.name, reloaded);
        compiledTriggers.delete(reloaded.name);
      }
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
      logger.info(`技能已删除: ${skillName}`);
      return true;
    },
    async addSkillFile(skillName, file) {
      const existing = skillsCache.get(skillName);
      if (!existing) return false;
      const rel = validateSkillRelPath(file.relPath);
      const byteLen =
        typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf-8') : file.content.byteLength;
      if (byteLen > config.maxSkillBytes) {
        throw new Error(`附属文件 ${rel} 超出大小限制 ${byteLen}B > ${config.maxSkillBytes}B`);
      }
      await storage.writeFile(
        joinUri(existing.uri, rel),
        typeof file.content === 'string' ? file.content : Buffer.from(file.content),
      );
      const reloaded = await loadSkillFromDir(existing.uri);
      if (reloaded) skillsCache.set(reloaded.name, reloaded);
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
      compiledTriggers.clear();
    },
    loadSkillForSession(sessionId, skillName) {
      if (!skillsCache.has(skillName)) return false;
      ensureSessionSet(sessionId).add(skillName);
      return true;
    },
    getLoadedSkills(sessionId) {
      const s = sessionLoaded.get(sessionId);
      return s ? [...s] : [];
    },
  };

  ctx.provide('skills', service);

  // ── 注册工具分组与工具 ──
  const tools = useToolService(ctx);
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
          '加载指定 skill 的完整 SKILL.md 内容到当前会话上下文。加载后下一次模型调用会自动看到该 skill 的详细指令与附属资源清单（scripts/references/assets）。当 system prompt 中的"可用技能列表"里某条 description 匹配当前任务时调用本工具。',
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
      ensureSessionSet(sessionId).add(skill.name);
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
        description: '列出可用 skills（受角色卡白名单过滤后），可按关键词模糊匹配 name/description。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：name/description 子串模糊匹配（不区分大小写）' },
            page: { type: 'number', description: '页码，从 1 开始' },
            pageSize: { type: 'number', description: '每页条数，默认 30' },
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
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));
      const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const curPage = Math.min(page, totalPages);
      const start = (curPage - 1) * pageSize;
      return JSON.stringify({
        total: visible.length,
        matched: filtered.length,
        page: curPage,
        pageSize,
        totalPages,
        hasMore: curPage < totalPages,
        skills: filtered.slice(start, start + pageSize).map(s => ({
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
            frontmatter: { type: 'object', description: '额外 frontmatter 字段（覆盖同名旧字段）' },
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

  // ── 启动：ready 后一次全量扫描 + 启用 storage watch 增量同步 ──
  // 使用 sticky 'ready' 事件：bouncePlugin 后新实例仍能收到。
  ctx.on('ready', async () => {
    try {
      await rescanSkills();
      logger.info(`技能系统已启动 (Anthropic Agent Skills) uri=${skillsUri} 已加载 ${skillsCache.size} 个技能`);
    } catch (err) {
      logger.warn(`首次扫描 skills 失败：${err}`);
    }
    // 监听变化 → 标脏 → 按需重扫（去抖靠 storage 层）
    try {
      const unwatch = storage.watch?.(skillsUri, async () => {
        try {
          await rescanSkills();
          compiledTriggers.clear();
          logger.debug(`skills 目录变化，已重新扫描，现有 ${skillsCache.size} 个技能`);
        } catch (err) {
          logger.warn(`重扫 skills 失败：${err}`);
        }
      });
      if (unwatch) ctx.onDispose(unwatch);
    } catch (err) {
      logger.warn(`skills 目录监听启动失败，请手动调用 skill_rescan: ${err}`);
    }
  });
}

// ----- 服务类型注册 -----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    skills: SkillsService;
  }
}
