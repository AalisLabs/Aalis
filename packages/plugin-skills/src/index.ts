import type { Context, ConfigSchema, WebuiPage, PluginModule } from '@aalis/core';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

export const provides = ['skills'];

export const inject = {
  optional: ['agent'],
};

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

export const webuiPages: WebuiPage[] = [
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

export const webuiHandlers: PluginModule['webuiHandlers'] = {
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

  let skillsCache: SkillDefinition[] = loadAllSkills();

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
      logger.info(`技能已更新: ${skillName}`);
      return true;
    },

    deleteSkill(skillName) {
      const idx = skillsCache.findIndex(s => s.name === skillName);
      if (idx < 0) return false;
      const filePath = join(skillsDir, `${sanitizeFilename(skillName)}.yaml`);
      try { unlinkSync(filePath); } catch {}
      skillsCache.splice(idx, 1);
      logger.info(`技能已删除: ${skillName}`);
      return true;
    },
  };

  ctx.provide('skills', service);

  // ── 注册工具分组 ──

  ctx.registerToolGroup({
    name: 'skills',
    label: '技能管理',
    description: '创建、查看、执行和管理可复用的提示词技能模板',
  });

  // ── 注册 AI 工具 ──

  // 1. 创建技能
  ctx.registerTool({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_create',
        description: '创建一个新的可复用技能。技能是保存的提示词模板，可以包含 {{参数名}} 占位符。用于将经验总结为可复用的能力。',
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
    handler: async (args) => {
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
  ctx.registerTool({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_list',
        description: '列出已保存的技能，支持按关键词 / 标签筛选与分页。技能仓库大时务必使用 keyword 或 tag 过滤，避免一次拉全量。',
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
    handler: async (args) => {
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

  // 3. 执行技能（展开模板 → 发送给自己作为新对话输入）
  ctx.registerTool({
    groups: ['skills'],
    definition: {
      type: 'function',
      function: {
        name: 'skill_execute',
        description: '执行一个已保存的技能。将模板中的参数替换后，返回展开后的提示词内容。你应该根据这个内容来执行相应的操作。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要执行的技能名称' },
            args: {
              type: 'object',
              description: '传入的参数值，对应技能模板中的 {{参数名}} 占位符',
              additionalProperties: true,
            },
          },
          required: ['name'],
        },
      },
    },
    handler: async (args) => {
      const skill = service.getSkill(args.name as string);
      if (!skill) return JSON.stringify({ error: `技能 "${args.name}" 不存在` });

      const params = (args.args as Record<string, string>) ?? {};
      let prompt = skill.prompt;

      // 替换占位符
      if (skill.parameters) {
        for (const [key, def] of Object.entries(skill.parameters)) {
          const value = params[key] ?? def.default ?? '';
          prompt = prompt.replaceAll(`{{${key}}}`, value);
        }
      }
      // 替换未定义但存在的占位符
      prompt = prompt.replace(/\{\{(\w+)\}\}/g, (match, key) => params[key] ?? match);

      // 更新执行计数
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
    },
  });

  // 4. 更新技能
  ctx.registerTool({
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
    handler: async (args) => {
      try {
        const updates: Partial<SkillDefinition> = {};
        if (args.description) updates.description = args.description as string;
        if (args.prompt) updates.prompt = args.prompt as string;
        if (args.parameters) updates.parameters = args.parameters as Record<string, { description: string; default?: string }>;
        if (args.tags) updates.tags = args.tags as string[];

        const ok = service.updateSkill(args.name as string, updates);
        return JSON.stringify({ ok, message: ok ? '已更新' : '技能不存在' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 5. 删除技能
  ctx.registerTool({
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
    handler: async (args) => {
      const ok = service.deleteSkill(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已删除' : '技能不存在' });
    },
  });

  // ── 在 agent:llm:before 钩子中注入可用技能摘要 ──

  ctx.middleware('agent:llm:before', async (data, next) => {
    const skills = service.listSkills();
    if (skills.length > 0) {
      const skillSummary = skills.map(s =>
        `- ${s.name}: ${s.description}${s.parameters ? ` (参数: ${Object.keys(s.parameters).join(', ')})` : ''}`
      ).join('\n');

      // 在 system 消息后追加技能提示
      const systemIdx = data.messages.findIndex(m => m.role === 'system');
      if (systemIdx >= 0 && data.messages[systemIdx].content) {
        const appendText = `\n\n你拥有以下可复用技能，可以通过 skill_execute 工具调用它们：\n${skillSummary}`;
        const prevContributions = (data.messages[systemIdx].metadata?._tokenContributions as Record<string, number>) ?? {};
        data.messages[systemIdx] = {
          ...data.messages[systemIdx],
          content: data.messages[systemIdx].content + appendText,
          metadata: {
            ...data.messages[systemIdx].metadata,
            _tokenContributions: { ...prevContributions, skills: appendText.length },
          },
        };
      }
    }
    await next();
  });

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
