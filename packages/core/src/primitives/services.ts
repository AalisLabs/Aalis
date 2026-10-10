// ----- 服务系统数据契约（与容器实现同文件） -----

/** ServiceContainer.getAll 的元素：ServiceEntry 的投影，不含清理归属 owner。 */
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
  /** 是否为所查口径（全局或 `{ for }` 那个插件）选中的那一条 */
  selected: boolean;
  /** 选中依据，只在选中的那一条上有 */
  basis?: SelectionBasis;
}

/** 选中依据：本插件偏好、全局偏好，或优先级与登记顺序（排名） */
export type SelectionBasis = 'plugin' | 'global' | 'rank';

/**
 * 一条登记
 * @internal
 */
export interface ServiceEntry {
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
   * 路由 / 显示 / 偏好）分开——同名激活各有各的 owner，一方拆卸不清另一方。
   * @internal
   */
  owner: symbol;
  /** 可选的展示标签（如 "OpenAI / gpt-4o"） */
  label?: string;
  /** 登记所用的描述符，只比身份（见 {@link ServiceContainer.rivalOf}） */
  descriptor?: object;
}

const NO_ENTRIES: readonly ServiceEntry[] = [];

/**
 * 服务容器 —— 支持同名多实现
 *
 * 设计要点：
 * - 同一个服务名可以有多个提供者，挑选只有一条规则（{@link #select}）：本插件偏好 > 全局偏好 > 优先级 > 注册顺序；
 *   偏好指向的那家不在场就按下一级挑，回来后自动切回
 * - 经 provide 能力注册的条目带清理归属 owner，插件卸载时按它批量清理（unregisterByOwner）；
 *   contextId 只是逻辑身份（路由 / 显示 / 偏好），不参与清理，core 不规定它的格式
 * - 归属可暂不对外（hold，编排层对转入后台的激活使用）：解析类读口一律看不见它的条目，
 *   登记事实类读口（namesOf / hasEntry / getServiceNames / 独占冲突）照常看得见
 */
export class ServiceContainer {
  #entries = new Map<string, ServiceEntry[]>();
  /** 偏好：service name → (消费者实例 id → contextId)；键 undefined 是全局偏好 */
  readonly #preferences = new Map<string, Map<string | undefined, string>>();
  /** 暂不对外的清理归属（见 {@link hold}） */
  readonly #held = new Set<symbol>();

  /**
   * 注册一个服务实例。容器只按名字存取，不认识类型——实现是否满足契约由服务描述符在
   * `provide(descriptor, impl)` 处约束。
   *
   * @param owner 清理归属（注册方这次激活的身份），拆卸时按它整体摘除。
   * @returns 退订闭包；条目已不在（退订过、已被 unregisterByOwner 清走）时无动作
   */
  register(
    name: string,
    instance: unknown,
    contextId: string,
    owner: symbol,
    options?: { priority?: number; label?: string; exclusive?: boolean; descriptor?: object },
  ): () => void {
    // 空实现会骗过缺席判断；非有限 priority 让 sort 比较器返回 NaN，先登记者盖过后来的有限值
    if (instance === null || instance === undefined) {
      throw new Error('provide 的实现不能为空');
    }
    if (options?.priority !== undefined && !Number.isFinite(options.priority)) {
      throw new Error(`provide 的 priority 必须是有限数字（收到 ${String(options.priority)}）`);
    }
    let list = this.#entries.get(name);
    if (list?.length && (options?.exclusive || list.some(entry => entry.exclusive))) {
      throw new Error(`服务 "${name}" 为独占登记，不能添加另一个提供者`);
    }
    if (!list) {
      list = [];
      this.#entries.set(name, list);
    }
    const entry: ServiceEntry = {
      instance,
      exclusive: options?.exclusive,
      priority: options?.priority ?? 0,
      contextId,
      owner,
      label: options?.label,
      descriptor: options?.descriptor,
    };
    list.push(entry);
    // 按优先级降序排列（稳定排序：同优先级先注册者在前）
    list.sort((a, b) => b.priority - a.priority);

    return () => {
      // 查 registry 当前数组而非闭包捕获的 list：服务名空掉时表项会被删，再注册会新建数组
      const current = this.#entries.get(name);
      const idx = current?.indexOf(entry) ?? -1;
      if (!current || idx < 0) return;
      current.splice(idx, 1);
      if (current.length === 0) this.#entries.delete(name);
    };
  }

  /**
   * 暂不对外：该归属名下的条目照常登记、照常占独占位，但不参与解析（get / getAll / inspect / ownerOf），
   * 直到 {@link release} 或整体摘除。返回该归属名下已有条目的服务名（它们此刻对外少了一个提供者）。
   * @internal
   */
  hold(owner: symbol): string[] {
    this.#held.add(owner);
    return this.namesOf(owner);
  }

  /**
   * 恢复对外：返回该归属名下有条目的服务名（它们此刻对外多了一个提供者）；未暂扣时返回空。
   * @internal
   */
  release(owner: symbol): string[] {
    return this.#held.delete(owner) ? this.namesOf(owner) : [];
  }

  /**
   * 该归属名下有条目的服务名（登记事实：暂不对外的也算）
   * @internal
   */
  namesOf(owner: symbol): string[] {
    return [...this.#entries].filter(([, list]) => list.some(entry => entry.owner === owner)).map(([name]) => name);
  }

  /**
   * 该归属是否已以这个逻辑身份登记过该服务（登记事实：暂不对外的也算）
   * @internal
   */
  hasEntry(name: string, contextId: string, owner: symbol): boolean {
    return this.#entries.get(name)?.some(entry => entry.owner === owner && entry.contextId === contextId) === true;
  }

  /**
   * 同名条目里不是以这个描述符登记的一条的逻辑身份（登记事实：暂不对外的也算）；没有则 undefined
   * @internal
   */
  rivalOf(name: string, descriptor: object): string | undefined {
    return this.#entries.get(name)?.find(entry => entry.descriptor !== descriptor)?.contextId;
  }

  /** 参与解析的条目：暂不对外的归属不算。没有暂扣时原样返回登记数组，不另分配 */
  #visible(name: string): readonly ServiceEntry[] {
    const list = this.#entries.get(name) ?? NO_ENTRIES;
    return this.#held.size === 0 ? list : list.filter(entry => !this.#held.has(entry.owner));
  }

  /**
   * 唯一的挑选规则：本插件偏好 > 全局偏好 > 优先级 > 注册顺序（register 已按 priority 稳定降序排好）。
   * 偏好指向的那家不在场就按下一级挑。不给 consumer 即全局口径
   */
  #select(list: readonly ServiceEntry[], name: string, consumer?: string): [ServiceEntry, SelectionBasis] | undefined {
    const preferred = (who: string | undefined): ServiceEntry | undefined => {
      const id = this.#preferences.get(name)?.get(who);
      return id === undefined ? undefined : list.find(entry => entry.contextId === id);
    };
    const own = consumer === undefined ? undefined : preferred(consumer);
    if (own) return [own, 'plugin'];
    const global = preferred(undefined);
    if (global) return [global, 'global'];
    return list.length > 0 ? [list[0], 'rank'] : undefined;
  }

  /**
   * 按该消费者的解析顺序排列的对外条目：选中的那一条在前（basis 是它的选中依据），其余保持优先级与登记顺序
   * @internal
   */
  ranked(name: string, consumer?: string): { entries: readonly ServiceEntry[]; basis?: SelectionBasis } {
    const list = this.#visible(name);
    const [selected, basis] = this.#select(list, name, consumer) ?? [];
    if (selected === undefined || selected === list[0]) return { entries: list, basis };
    return { entries: [selected, ...list.filter(entry => entry !== selected)], basis };
  }

  /** 获取全局胜者实例（全局偏好 > 优先级 > 注册顺序） */
  get<T = unknown>(name: string): T | undefined {
    return this.ranked(name).entries[0]?.instance as T | undefined;
  }

  /**
   * 按清理归属移除本次激活注册的所有 entry（暂扣随之解除），返回摘掉了条目的服务名。
   *
   * 按 owner 而非 contextId：同名激活（内部构造重名、拆卸在飞时同名新激活）各有各的
   * owner，互不误清。一个激活登记的多条（各带 entryId）同 owner，一并清掉。
   */
  unregisterByOwner(owner: symbol): string[] {
    const removed: string[] = [];
    for (const [name, list] of this.#entries) {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].owner === owner) list.splice(i, 1);
      }
      if (list.length < before) removed.push(name);
      if (list.length === 0) this.#entries.delete(name);
    }
    this.#held.delete(owner);
    return removed;
  }

  /** 列出所有已登记的服务名，含暂不对外的归属名下的（登记事实） */
  getServiceNames(): string[] {
    return [...this.#entries.keys()];
  }

  /**
   * 该消费者选中那一条的清理归属（编排用它认「这个服务现在由哪次激活提供」，不从 contextId 字符串猜）
   * @internal
   */
  ownerOf(name: string, consumer?: string): symbol | undefined {
    return this.ranked(name, consumer).entries[0]?.owner;
  }

  /**
   * 此刻对外的全部提供者的清理归属（关停编排给声明了该服务的激活建边用）
   * @internal
   */
  ownersOf(name: string): symbol[] {
    return this.#visible(name).map(entry => entry.owner);
  }

  /**
   * 去掉 leaving 判为要走的归属的条目之后，该服务是否还有对外的提供者（重算预判连带退场用）
   * @internal
   */
  survives(name: string, leaving: (owner: symbol) => boolean): boolean {
    return this.#visible(name).some(entry => !leaving(entry.owner));
  }

  /** 只读登记元数据（不含实例），按该消费者的解析顺序（不给即全局口径）：展示与诊断用 */
  inspect(name: string, consumer?: string): ServiceInfo[] {
    const { entries, basis } = this.ranked(name, consumer);
    return entries.map((entry, i) => ({
      contextId: entry.contextId,
      priority: entry.priority,
      label: entry.label,
      exclusive: entry.exclusive ?? false,
      selected: i === 0,
      basis: i === 0 ? basis : undefined,
    }));
  }

  /**
   * 获取某个服务的所有实例（带提供者信息与优先级）
   *
   * 返回顺序遵循「全局偏好 > 优先级 > 注册顺序」。
   */
  getAll<T = unknown>(name: string): ServiceView<T>[] {
    return this.ranked(name).entries.map(entry => ({
      instance: entry.instance as T,
      contextId: entry.contextId,
      priority: entry.priority,
      label: entry.label,
    }));
  }

  /**
   * 设置偏好（按 contextId）：给 consumer 是该消费者实例的本插件偏好，否则是全局偏好。
   * 指向的那家不在场照样记下，登记后生效。管理面经 `services.prefer()` 调用（另发 service:changed）；
   * 直接调用容器不会通知绑定层。
   * @returns false 表示服务有独占条目且不是这个 contextId（拒绝）
   * @internal
   */
  prefer(name: string, contextId: string, consumer?: string): boolean {
    const exclusive = this.#entries.get(name)?.find(entry => entry.exclusive);
    if (exclusive && exclusive.contextId !== contextId) return false;
    if (!this.#preferences.has(name)) this.#preferences.set(name, new Map());
    this.#preferences.get(name)!.set(consumer, contextId);
    return true;
  }

  /**
   * 清除偏好（consumer 同 {@link prefer}）；管理面经 `services.unprefer()` 调用
   * @internal
   */
  unprefer(name: string, consumer?: string): boolean {
    return this.#preferences.get(name)?.delete(consumer) === true;
  }

  /**
   * 读取偏好的 contextId（consumer 同 {@link prefer}；无偏好为 undefined）；管理面经 `services.preferred()` 读取
   * @internal
   */
  getPreferred(name: string, consumer?: string): string | undefined {
    return this.#preferences.get(name)?.get(consumer);
  }
}
