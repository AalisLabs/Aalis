// ----- 服务系统数据契约（与容器实现同文件，同 contributions.ts 的 Spec/Handle 惯例） -----

/** ServiceContainer.getAll / ServiceRef.all 的元素：ServiceEntry 的投影，不含清理归属 owner。 */
export interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;
  priority: number;
  label?: string;
}

export interface ServiceInfo {
  contextId: string;
  priority: number;
  label?: string;
  exclusive: boolean;
}

interface ServiceEntry {
  instance: unknown;
  exclusive?: boolean;
  /**
   * 数字越大越优先；同值先注册者胜（稳定降序）。解析序恒为
   * 「偏好 > 优先级 > 注册顺序」——优先级是静态默认序，偏好是用户显式覆盖。
   * 数值含义由 provider 自行记载（部署可调，如 asr 插件把它开进 config）。
   */
  priority: number;
  contextId: string;
  /**
   * 清理归属：注册方本次激活的身份。与 `contextId`（逻辑身份，供
   * 路由 / 显示 / 偏好 / 前缀查询）分开——同名激活各有各的 owner，一方拆卸不清另一方。
   * @internal
   */
  owner: symbol;
  /** 可选的展示标签（如 "OpenAI / gpt-4o"） */
  label?: string;
}

/**
 * 服务容器 —— 支持同名多实现
 *
 * 设计要点：
 * - 同一个服务名可以有多个提供者（按 priority + 偏好解析）
 * - 服务选择走「偏好 > 优先级 > 注册顺序」；领域级筛选（如按 LLM 模型能力）由各 -api 自理，不在内核 DI
 * - 经 provide 能力注册的条目带清理归属 owner，插件卸载时按它批量清理（unregisterByOwner）；
 *   contextId 只是逻辑身份（路由 / 显示 / 偏好 / 前缀查询），不参与清理
 */
export class ServiceContainer {
  private entries = new Map<string, ServiceEntry[]>();
  /** 服务偏好：service name → preferred contextId（preferred 永远胜过 priority） */
  private preferences = new Map<string, string>();

  /**
   * 注册一个服务实例。容器只按名字存取，不认识类型——实现是否满足契约由服务描述符在
   * `provide(descriptor, impl)` 处约束。
   *
   * @param owner 清理归属（注册方这次激活的身份），拆卸时按它整体摘除。
   * @returns 退订闭包；返回这次是否真的摘掉了条目——同一条目退订两次、或已被 unregisterByOwner
   *   清走时为 false，门面据此决定要不要发 `service:unregistered`。
   */
  register(
    name: string,
    instance: unknown,
    contextId: string,
    owner: symbol,
    options?: { priority?: number; label?: string; exclusive?: boolean },
  ): () => boolean {
    // 空实现会骗过 require() 的缺席判断；非有限 priority 让 sort 比较器返回 NaN，先登记者盖过后来的有限值
    if (instance === null || instance === undefined) {
      throw new Error('provide 的实现不能为空');
    }
    if (options?.priority !== undefined && !Number.isFinite(options.priority)) {
      throw new Error(`provide 的 priority 必须是有限数字（收到 ${String(options.priority)}）`);
    }
    let list = this.entries.get(name);
    if (list?.length && (options?.exclusive || list.some(entry => entry.exclusive))) {
      throw new Error(`服务 "${name}" 为独占登记，不能添加另一个提供者`);
    }
    if (!list) {
      list = [];
      this.entries.set(name, list);
    }
    const entry: ServiceEntry = {
      instance,
      exclusive: options?.exclusive,
      priority: options?.priority ?? 0,
      contextId,
      owner,
      label: options?.label,
    };
    list.push(entry);
    // 按优先级降序排列（稳定排序：同优先级先注册者在前）
    list.sort((a, b) => b.priority - a.priority);

    return () => {
      // 查 registry 当前数组而非闭包捕获的 list：服务名空掉时表项会被删，再注册会新建数组
      const current = this.entries.get(name);
      const idx = current?.indexOf(entry) ?? -1;
      if (!current || idx < 0) return false;
      current.splice(idx, 1);
      if (current.length === 0) this.entries.delete(name);
      return true;
    };
  }

  /**
   * 按解析顺序返回某服务的所有 entry：
   *
   *   1. 用户偏好的 entry（如有，且仍存在）
   *   2. 其余 entry，按 priority 降序 + 注册顺序
   *
   * 这是 get/getAll 的共同基础——保证「偏好 > 优先级 > 注册顺序」语义在所有读路径一致。
   */
  private resolveEntries(name: string): ServiceEntry[] {
    const list = this.entries.get(name);
    if (!list || list.length === 0) return [];
    const preferredCtxId = this.preferences.get(name);
    if (!preferredCtxId) return list;
    const preferred = list.find(e => e.contextId === preferredCtxId);
    if (!preferred) return list;
    return [preferred, ...list.filter(e => e !== preferred)];
  }

  /**
   * 获取当前胜者实例（偏好 > 优先级 > 注册顺序）。
   *
   * 不走 `resolveEntries`：那里在设了偏好时要 `find` + `filter` + spread 出一条全新的重排
   * 数组，而这里只取首个、其余全丢。每次 `current` / `require()` 都走到这里，是最频繁的读，
   * 且「锁定默认 LLM」这类偏好在真实部署里是常态，那条被算出来又被丢掉的尾巴不划算。
   *
   * 语义与 `resolveEntries` 保持一致：偏好项存在则取它，否则取 `list[0]` ——
   * `list` 在 `register` 里就按 priority 降序排好（稳定排序，同优先级保持注册顺序）。
   */
  get<T = unknown>(name: string): T | undefined {
    const list = this.entries.get(name);
    if (!list || list.length === 0) return undefined;
    const preferredCtxId = this.preferences.get(name);
    if (preferredCtxId) {
      const preferred = list.find(e => e.contextId === preferredCtxId);
      if (preferred) return preferred.instance as T;
    }
    return list[0].instance as T;
  }

  /**
   * 检查指定 contextId 是否注册了某个服务。
   *
   * "拥有" 语义：同时匹配 `contextId === ownerId` 和 per-entry 拆粒度的
   * `contextId` 以 `ownerId + '/'` 为前缀的子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。
   */
  hasByContext(name: string, contextId: string): boolean {
    const list = this.entries.get(name);
    if (!list) return false;
    const prefix = `${contextId}/`;
    return list.some(e => e.contextId === contextId || e.contextId.startsWith(prefix));
  }

  /**
   * 按清理归属移除本次激活注册的所有 entry，返回被移除的服务名列表。
   *
   * 按 owner 而非 contextId：同名激活（内部构造重名、拆卸在飞时同名新激活）各有各的
   * owner，互不误清。per-entry 子 entry（`id/sub`）与主 entry 同 owner，一并清掉——
   * 不再依赖 id 前缀约定，前缀只留给 {@link hasByContext} 这类逻辑身份查询。
   */
  unregisterByOwner(owner: symbol): string[] {
    const removed: string[] = [];
    for (const [name, list] of this.entries) {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].owner === owner) list.splice(i, 1);
      }
      if (list.length < before) removed.push(name);
      if (list.length === 0) this.entries.delete(name);
    }
    return removed;
  }

  /**
   * 列出所有已注册的服务名
   */
  getServiceNames(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 当前胜者的清理归属（关停编排用它认「这个服务现在由哪次激活提供」，不从 contextId 字符串猜）。
   * @internal
   */
  ownerOf(name: string): symbol | undefined {
    return this.resolveEntries(name)[0]?.owner;
  }

  /** 只读登记元数据（不含实例）：展示与诊断用 */
  inspect(name: string): ServiceInfo[] {
    return this.resolveEntries(name).map(entry => ({
      contextId: entry.contextId,
      priority: entry.priority,
      label: entry.label,
      exclusive: entry.exclusive ?? false,
    }));
  }

  /**
   * 获取某个服务的所有实例（带提供者信息与优先级）
   *
   * 返回顺序遵循「偏好 > 优先级 > 注册顺序」。
   */
  getAll<T = unknown>(name: string): ServiceView<T>[] {
    return this.resolveEntries(name).map(entry => ({
      instance: entry.instance as T,
      contextId: entry.contextId,
      priority: entry.priority,
      label: entry.label,
    }));
  }

  /**
   * 设置某服务的偏好 provider（按 contextId）
   *
   * 语义：偏好 > 优先级 > 注册顺序。即偏好 entry 总会被 `get()` 第一个返回，
   * 哪怕它的 priority 数值低于其它 entry。
   *
   * @returns true 表示偏好已记录（即使目标 entry 当下尚未注册也会接受——一旦注册即生效）
   * 插件经 `services.prefer()` 调用（额外发出 service:preference-changed 触发绑定更新）；
   * 直接调用容器不会通知绑定层。
   * @internal
   */
  prefer(name: string, contextId: string): boolean {
    const exclusive = this.entries.get(name)?.find(entry => entry.exclusive);
    if (exclusive && exclusive.contextId !== contextId) return false;
    this.preferences.set(name, contextId);
    return true;
  }

  /**
   * 清除某服务的偏好（恢复 priority + 注册顺序解析）
   * 插件经 `services.unprefer()` 调用；直接调用容器不会通知绑定层。
   * @internal
   */
  unprefer(name: string): boolean {
    return this.preferences.delete(name);
  }

  /**
   * 读取某服务当前的偏好 contextId（无偏好返回 undefined）
   * 插件经 `services.preferred()` 读取。
   * @internal
   */
  getPreferred(name: string): string | undefined {
    return this.preferences.get(name);
  }
}
