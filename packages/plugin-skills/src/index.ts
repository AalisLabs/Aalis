import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import { useToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import '@aalis/plugin-tools-api';

// ════════════════════════════════════════════════════════════
// plugin-skills — AI 自生成技能系统
//
// Agent 可以将经验总结为可复用的"技能"（Skill）：
// 包含名称、描述、提示词模板和可选参数。
// 技能持久化为 YAML 文件，可通过工具调用或定时任务执行。
// ════════════════════════════════════════════════════════════

// ──────────── 数据结构 ────────────

interface SkillDefinition {
  /** 技能名称（也是文件名） */
  name: string;
  /** 技能描述（给 Agent 看） */
  description: string;
  /** 提示词模板，支持 {{param}} 占位符 */
  prompt: string;
  /** 参数定义 */
  parameters?: Record<string, { description: string; default?: string }>;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
  /** 标签 */
  tags?: string[];
  /** 执行次数 */
  execCount?: number;
}

interface SkillsConfig {
  /** 技能文件存储目录 */
  skillsDir: string;
  /** 单个技能提示词最大字符数 */
  maxPromptLength: number;
  /** 技能总数上限 */
  maxSkills: number;
}

// ──────────── 技能服务接口 ────────────

export interface SkillsService {
  listSkills(): SkillDefinition[];
  getSkill(name: string): SkillDefinition | undefined;
  createSkill(skill: Omit<SkillDefinition, 'createdAt' | 'updatedAt'>): void;
  updateSkill(name: string, updates: Partial<SkillDefinition>): boolean;
  deleteSkill(name: string): boolean;
}

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-skills';
export const displayName = '技能系统';
export const subsystem = 'skills';

export const provides = ['skills'];

export const configSchema: ConfigSchema = {
  skillsDir: {
    type: 'string',
    label: '技能存储目录',
    default: 'data/skills',
    description: '技能 YAML 文件的存储目录路径（相对于项目根目录）。',
  },
  maxPromptLength: {
    type: 'number',
    label: '最大提示词长度',
    default: 10000,
    description: '单个技能提示词模板的最大字符数。',
  },
  maxSkills: {
    type: 'number',
    label: '技能数量上限',
    default: 100,
    description: '最多可创建的技能数量。',
  },
};

export const defaultConfig = {
  skillsDir: 'data/skills',
  maxPromptLength: 10000,
  maxSkills: 100,
};

// ──────────── WebUI 页面 ────────────

const webuiPages: WebuiPage[] = [
  {
    key: 'skills',
    label: '技能库',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>',
    order: 56,
    content: [
      {
        type: 'table',
        label: '技能列表',
        source: 'listSkills',
        columns: [
          { key: 'name', label: '名称' },
          { key: 'description', label: '描述' },
          { key: 'tags', label: '标签' },
          { key: 'execCount', label: '执行次数' },
          { key: 'updatedAt', label: '最后更新' },
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

// ──────────── WebUI Handlers ────────────

export const actions: PluginModule['actions'] = {
  async listSkills(ctx) {
    const svc = ctx.getService<SkillsService>('skills');
    if (!svc) return [];
    return svc.listSkills().map(s => ({
      ...s,
      tags: s.tags?.join(', ') || '',
    }));
  },
  async getSkill(ctx, args) {
    const svc = ctx.getService<SkillsService>('skills');
    return svc?.getSkill(args.name as string) ?? { error: '技能不存在' };
  },
  async deleteSkill(ctx, args) {
    const svc = ctx.getService<SkillsService>('skills');
    return svc?.deleteSkill(args.name as string) ? { ok: true } : { error: '技能不存在' };
  },
  async getStats(ctx) {
    const svc = ctx.getService<SkillsService>('skills');
    return { value: svc?.listSkills().length ?? 0 };
  },
};

// ──────────── 插件入口 ────────────

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('skills');

  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // 确保目录存在
  const skillsDir = resolve(process.cwd(), config.skillsDir);
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  // ── 磁盘读写 ──

  function loadSkill(filePath: string): SkillDefinition | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return parseYaml(content) as SkillDefinition;
    } catch {
      return null;
    }
  }

  function saveSkill(skill: SkillDefinition): void {
    const filePath = join(skillsDir, `${sanitizeFilename(skill.name)}.yaml`);
    writeFileSync(filePath, stringifyYaml(skill, { lineWidth: 0 }), 'utf-8');
  }

  function loadAllSkills(): SkillDefinition[] {
    if (!existsSync(skillsDir)) return [];
    const files = readdirSync(skillsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    const skills: SkillDefinition[] = [];
    for (const file of files) {
      const skill = loadSkill(join(skillsDir, file));
      if (skill) skills.push(skill);
    }
    return skills;
  }

  // ── 缓存 ──

  const skillsCache: SkillDefinition[] = loadAllSkills();

  // ── 工具注册映射：每个技能 → 一个可 dispose 的 LLM 工具 ──

  const tools = useToolService(ctx);
  const skillDisposers = new Map<string, () => void>();

  /**
   * 将技能名转为合法工具名（OpenAI: ^[a-zA-Z0-9_-]{1,64}$）。
   * 中文/特殊字符会被剥离；剥离后若不含字母数字，回退到基于 SHA-1 的短 hash，
   * 这样纯中文名技能也能注册成独立 LLM 工具。
   */
  function toolNameForSkill(skillName: string): string {
    const sanitized = skillName
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    if (sanitized && /[a-zA-Z0-9]/.test(sanitized)) {
      return `skill_${sanitized}`.slice(0, 64);
    }
    const hash = createHash('sha1').update(skillName).digest('hex').slice(0, 10);
    return `skill_x_${hash}`;
  }

  /** 将一个技能注册成独立 LLM 工具 */
  function registerSkillTool(skill: SkillDefinition): void {
    const toolName = toolNameForSkill(skill.name);
    // 构造 JSONSchema parameters
    const props: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];
    if (skill.parameters) {
      for (const [k, def] of Object.entries(skill.parameters)) {
        props[k] = { type: 'string', description: def?.description ?? '' };
        if (def?.default === undefined) required.push(k);
      }
    }
    const parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    } = { type: 'object', properties: props };
    if (required.length > 0) parameters.required = required;

    const dispose = tools.register({
      groups: ['skills'],
      definition: {
        type: 'function',
        function: {
          name: toolName,
          description:
            `[用户技能·原名"${skill.name}"] ${skill.description}\n` +
            '（Agent 自定义可复用技能，可通过 skill_update / skill_delete 修改或删除。' +
            '调用后返回展开的提示词，你需要据此执行后续动作。）',
          parameters,
        },
      },
      handler: async args => {
        return executeSkillExpand(skill.name, (args ?? {}) as Record<string, string>);
      },
    });
    skillDisposers.set(skill.name, dispose);
  }

  /** 注销一个技能对应的 LLM 工具 */
  function unregisterSkillTool(skillName: string): void {
    const dispose = skillDisposers.get(skillName);
    if (dispose) {
      try {
        dispose();
      } catch (err) {
        logger.warn(`注销技能工具失败 ${skillName}: ${err}`);
      }
      skillDisposers.delete(skillName);
    }
  }

  /** 展开技能 prompt 模板并更新执行计数 */
  function executeSkillExpand(skillName: string, params: Record<string, string>): string {
    const skill = skillsCache.find(s => s.name === skillName);
    if (!skill) return JSON.stringify({ error: `技能 "${skillName}" 不存在` });
    let prompt = skill.prompt;
    if (skill.parameters) {
      for (const [key, def] of Object.entries(skill.parameters)) {
        const value = params[key] ?? def.default ?? '';
        prompt = prompt.replaceAll(`{{${key}}}`, value);
      }
    }
    prompt = prompt.replace(/\{\{(\w+)\}\}/g, (m, k) => params[k] ?? m);

    const idx = skillsCache.findIndex(s => s.name === skill.name);
    if (idx >= 0) {
      skillsCache[idx] = {
        ...skillsCache[idx],
        execCount: (skillsCache[idx].execCount ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      saveSkill(skillsCache[idx]);
    }
    return JSON.stringify({
      skill: skill.name,
      expandedPrompt: prompt,
      message: '请根据以上展开后的提示词内容执行相应操作。',
    });
  }

  // ── 核心服务实现 ──

  const service: SkillsService = {
    listSkills() {
      return [...skillsCache];
    },

    getSkill(skillName) {
      return skillsCache.find(s => s.name === skillName);
    },

    createSkill(skill) {
      if (skillsCache.length >= config.maxSkills) {
        throw new Error(`技能数量已达上限 (${config.maxSkills})`);
      }
      if (skill.prompt.length > config.maxPromptLength) {
        throw new Error(`提示词超出长度限制 (${config.maxPromptLength})`);
      }
      if (skillsCache.some(s => s.name === skill.name)) {
        throw new Error(`技能 "${skill.name}" 已存在`);
      }

      const now = new Date().toISOString();
      const full: SkillDefinition = {
        ...skill,
        createdAt: now,
        updatedAt: now,
        execCount: 0,
      };
      saveSkill(full);
      skillsCache.push(full);
      registerSkillTool(full);
      logger.info(`技能已创建: ${skill.name}`);
    },

    updateSkill(skillName, updates) {
      const idx = skillsCache.findIndex(s => s.name === skillName);
      if (idx < 0) return false;
      const existing = skillsCache[idx];
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      if (updates.prompt && updates.prompt.length > config.maxPromptLength) {
        throw new Error(`提示词超出长度限制`);
      }
      saveSkill(updated);
      skillsCache[idx] = updated;
      // 重新注册工具（description/parameters 可能变了）
      unregisterSkillTool(skillName);
      registerSkillTool(updated);
      logger.info(`技能已更新: ${skillName}`);
      return true;
    },

    deleteSkill(skillName) {
      const idx = skillsCache.findIndex(s => s.name === skillName);
      if (idx < 0) return false;
      const filePath = join(skillsDir, `${sanitizeFilename(skillName)}.yaml`);
      try {
        unlinkSync(filePath);
      } catch {}
      skillsCache.splice(idx, 1);
      unregisterSkillTool(skillName);
      logger.info(`技能已删除: ${skillName}`);
      return true;
    },
  };

  ctx.provide('skills', service);

  // ── 注册工具分组 ──

  useToolService(ctx).registerGroup({
    name: 'skills',
    label: '技能管理',
    description: '创建、查看、执行和管理可复用的提示词技能模板',
  });

  // ── 注册 AI 工具 ──

  // 1. 创建技能
  useToolService(ctx).register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_create',
        description:
          '创建一个新的可复用技能。技能是保存的提示词模板，可以包含 {{参数名}} 占位符。用于将经验总结为可复用的能力。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称（唯一标识，英文推荐）' },
            description: { type: 'string', description: '技能描述（用途说明）' },
            prompt: { type: 'string', description: '提示词模板内容。可以包含 {{param}} 形式的占位符。' },
            parameters: {
              type: 'object',
              description: '参数定义，key 为参数名，value 包含 description 和可选的 default',
              additionalProperties: true,
            },
            tags: {
              type: 'array',
              description: '标签列表，用于分类',
            },
          },
          required: ['name', 'description', 'prompt'],
        },
      },
    },
    handler: async args => {
      try {
        service.createSkill({
          name: args.name as string,
          description: args.description as string,
          prompt: args.prompt as string,
          parameters: args.parameters as Record<string, { description: string; default?: string }>,
          tags: args.tags as string[] | undefined,
        });
        return JSON.stringify({ ok: true, message: `技能 "${args.name}" 已创建` });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 2. 列出技能
  useToolService(ctx).register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_list',
        description:
          '列出已保存的技能，支持按关键词 / 标签筛选与分页。技能仓库大时务必使用 keyword 或 tag 过滤，避免一次拉全量。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按名称与描述子串模糊匹配（不区分大小写）' },
            tag: { type: 'string', description: '可选：按单个标签筛选' },
            page: { type: 'number', description: '页码，从 1 开始，默认 1' },
            pageSize: { type: 'number', description: '每页条数，默认 30（可自行设定）' },
          },
        },
      },
    },
    handler: async args => {
      const all = service.listSkills().map(s => ({
        name: s.name,
        description: s.description,
        parameters: s.parameters ? Object.keys(s.parameters) : [],
        tags: s.tags || [],
        execCount: s.execCount ?? 0,
      }));
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      const filtered = all.filter(s => {
        if (tag && !s.tags.includes(tag)) return false;
        if (keyword) {
          const hay = `${s.name} ${s.description ?? ''}`.toLowerCase();
          if (!hay.includes(keyword)) return false;
        }
        return true;
      });
      const page = Math.max(1, Math.floor(Number(args.page) || 1));
      const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));
      const matched = filtered.length;
      const totalPages = Math.max(1, Math.ceil(matched / pageSize));
      const curPage = Math.min(page, totalPages);
      const start = (curPage - 1) * pageSize;
      return JSON.stringify({
        total: all.length,
        matched,
        page: curPage,
        pageSize,
        totalPages,
        hasMore: curPage < totalPages,
        ...(keyword ? { keyword } : {}),
        ...(tag ? { tag } : {}),
        skills: filtered.slice(start, start + pageSize),
      });
    },
  });

  // 3. 更新技能
  useToolService(ctx).register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_update',
        description: '更新一个已有技能的内容。可以修改描述、提示词、参数等。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要更新的技能名称' },
            description: { type: 'string', description: '新的描述' },
            prompt: { type: 'string', description: '新的提示词模板' },
            parameters: { type: 'object', description: '新的参数定义', additionalProperties: true },
            tags: { type: 'array', description: '新的标签列表' },
          },
          required: ['name'],
        },
      },
    },
    handler: async args => {
      try {
        const updates: Partial<SkillDefinition> = {};
        if (args.description) updates.description = args.description as string;
        if (args.prompt) updates.prompt = args.prompt as string;
        if (args.parameters)
          updates.parameters = args.parameters as Record<string, { description: string; default?: string }>;
        if (args.tags) updates.tags = args.tags as string[];

        const ok = service.updateSkill(args.name as string, updates);
        return JSON.stringify({ ok, message: ok ? '已更新' : '技能不存在' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 4. 删除技能
  useToolService(ctx).register({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_delete',
        description: '删除一个已保存的技能。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要删除的技能名称' },
          },
          required: ['name'],
        },
      },
    },
    handler: async args => {
      const ok = service.deleteSkill(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已删除' : '技能不存在' });
    },
  });

  // ── 启动时为所有已加载技能注册 LLM 工具（取代原全量注入 system prompt 的做法） ──
  for (const skill of skillsCache) {
    registerSkillTool(skill);
  }

  logger.info(`技能系统已启动 (目录: ${skillsDir}, 已加载 ${skillsCache.length} 个技能)`);
}

// ──────────── 辅助函数 ────────────

function resolveConfig(raw: Record<string, unknown>): SkillsConfig {
  return {
    skillsDir: (raw.skillsDir as string) ?? 'data/skills',
    maxPromptLength: (raw.maxPromptLength as number) ?? 10000,
    maxSkills: (raw.maxSkills as number) ?? 100,
  };
}

/** 清理文件名中的不安全字符 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 100);
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    skills: SkillsService;
  }
}
