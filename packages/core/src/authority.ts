import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ConfigManager } from './config.js';
import type { Logger } from './logger.js';

/** 高危操作确认请求信息 */
export interface DangerousConfirmRequest {
  /** 操作名称（指令名或工具名） */
  name: string;
  /** 操作类型 */
  type: 'command' | 'tool';
  /** 操作参数（工具调用时存在） */
  args?: Record<string, unknown>;
  /** 会话 ID */
  sessionId: string;
  /** 来源平台 */
  platform: string;
}

/** 确认回调：返回 true 表示放行，false 表示拒绝 */
export type DangerousConfirmHandler = (request: DangerousConfirmRequest) => Promise<boolean>;

/**
 * 权限管理器
 *
 * 职责:
 * - 解析用户权限等级 (owner > 数据库记录 > 默认等级)
 * - 管理用户权限数据的持久化 (JSON 文件)
 * - 判断 dangerous 操作是否被白名单放行
 */
export class AuthorityManager {
  /** platform:userId → authority level */
  private users = new Map<string, number>();
  private config: ConfigManager;
  private logger: Logger;
  private filePath: string;
  private dirty = false;
  private confirmHandlers = new Map<string, DangerousConfirmHandler>();

  constructor(config: ConfigManager, logger: Logger) {
    this.config = config;
    this.logger = logger.child('authority');
    this.filePath = resolve(config.getConfigDir(), 'data', 'users.json');
    this.load();
  }

  /**
   * 获取用户权限等级
   *
   * 优先级: owner 列表 → 持久化记录 → 默认等级
   */
  getAuthority(platform: string, userId?: string): number {
    if (!userId) return this.config.get('defaultAuthority') ?? 1;

    // WebUI 控制台用户始终拥有 owner 权限（与 internal-framework 控制台模型一致）
    if (platform === 'webui' && userId === 'console') {
      return this.config.get('ownerAuthority') ?? 5;
    }

    // 检查 owner 列表
    const owners = this.config.get('owners') ?? [];
    if (owners.some(o => o.platform === platform && o.userId === userId)) {
      return this.config.get('ownerAuthority') ?? 5;
    }

    // 检查持久化记录
    const key = `${platform}:${userId}`;
    if (this.users.has(key)) {
      return this.users.get(key)!;
    }

    return this.config.get('defaultAuthority') ?? 1;
  }

  /**
   * 设置用户权限等级
   */
  setAuthority(platform: string, userId: string, level: number): void {
    const key = `${platform}:${userId}`;
    this.users.set(key, level);
    this.dirty = true;
    this.logger.debug(`设置用户权限: ${key} → ${level}`);
  }

  /**
   * 检查某个 dangerous 操作是否被白名单放行
   */
  isDangerousAllowed(name: string): boolean {
    const policy = this.config.get('dangerousPolicy');
    if (!policy?.allow || policy.allow.length === 0) return false;

    // 检查有效期
    if (policy.duration && policy.duration > 0 && policy.enabledAt) {
      const elapsed = (Date.now() - policy.enabledAt) / 1000;
      if (elapsed > policy.duration) {
        this.logger.info('dangerous 白名单已过期');
        return false;
      }
    }

    // '*' 表示全部放行
    if (policy.allow.includes('*')) return true;

    return policy.allow.includes(name);
  }

  /**
   * 注册交互式确认回调（由平台插件按平台名设置）
   */
  setConfirmHandler(platform: string, handler: DangerousConfirmHandler): void {
    this.confirmHandlers.set(platform, handler);
  }

  /**
   * 检查高危操作是否可以执行：先查白名单，再尝试对应平台的交互确认
   */
  async confirmDangerous(request: DangerousConfirmRequest): Promise<boolean> {
    if (this.isDangerousAllowed(request.name)) return true;
    const handler = this.confirmHandlers.get(request.platform);
    if (handler) {
      try {
        return await handler(request);
      } catch (err) {
        this.logger.warn(`高危确认回调异常: ${err}`);
        return false;
      }
    }
    return false;
  }

  /**
   * 检查用户是否为 owner
   */
  isOwner(platform: string, userId?: string): boolean {
    if (!userId) return false;
    // WebUI 控制台始终为 owner
    if (platform === 'webui' && userId === 'console') return true;
    const owners = this.config.get('owners') ?? [];
    return owners.some(o => o.platform === platform && o.userId === userId);
  }

  /**
   * 获取所有已设置权限的用户
   */
  listUsers(): Array<{ platform: string; userId: string; authority: number }> {
    const result: Array<{ platform: string; userId: string; authority: number }> = [];
    for (const [key, level] of this.users) {
      const idx = key.indexOf(':');
      result.push({
        platform: key.slice(0, idx),
        userId: key.slice(idx + 1),
        authority: level,
      });
    }
    return result;
  }

  /**
   * 持久化到磁盘
   */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: Record<string, number> = {};
      for (const [key, level] of this.users) {
        data[key] = level;
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
      this.logger.debug('用户权限数据已保存');
    } catch (err) {
      this.logger.warn(`保存用户权限数据失败: ${err}`);
    }
  }

  /**
   * 从磁盘加载
   */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, number>;
      for (const [key, level] of Object.entries(data)) {
        if (typeof level === 'number') {
          this.users.set(key, level);
        }
      }
      this.logger.debug(`加载了 ${this.users.size} 条用户权限记录`);
    } catch (err) {
      this.logger.warn(`加载用户权限数据失败: ${err}`);
    }
  }
}
