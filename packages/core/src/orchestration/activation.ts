import { awaitWithTimeout, reportQuietly } from '../kernel/disposable-chain.js';

import type { ServiceContainer } from '../primitives/services.js';

import { closeActivations } from './close-plan.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

/** 一条跟随边：消费方的一次托管绑定挂在提供方的服务上，两端共用同一个对象 */
interface Edge {
  readonly from: Activation;
  /** 提供方身份 */
  readonly owner: symbol;
  readonly required: boolean;
  /** 让该跟随者向当前胜者收敛 */
  readonly pump: () => void;
  /** 撤回已发起、尚未落定 */
  settling?: Promise<void>;
  /** 从两端摘除（幂等） */
  readonly drop: () => void;
}

/** 内部激活记录：身份、资源寿命与依赖边。不提供事件、服务、配置管理等能力门面。 */
export class Activation {
  readonly children = new Set<Activation>();
  readonly declared = new Map<string, boolean>();
  /** 本激活挂出去的边：关停排序据此认提供者，撤回落定前一直在 */
  private readonly outbound = new Set<Edge>();
  /** 挂在本激活所提供服务上的边：撤回段据此先让它们交接 */
  private readonly inbound = new Set<Edge>();
  private closing?: Promise<void>;

  constructor(
    readonly id: string,
    readonly owner: symbol,
    readonly logger: Logger,
    readonly config: Readonly<Record<string, unknown>>,
    readonly resources: Resources,
    private readonly services: ServiceContainer,
    private readonly owners: Map<symbol, Activation>,
  ) {}

  /** 登记一条跟随边；释放时带上撤回的落定，边留到落定为止 */
  retainBinding(name: string, pump: () => void): (settling?: Promise<void>) => void {
    // 只在 pump 解析到提供者之后调用：条目存在，owner 必有
    const owner = this.services.ownerOf(name)!;
    const provider = this.owners.get(owner);
    const edge: Edge = {
      from: this,
      owner,
      required: this.declared.get(name) === true,
      pump,
      drop: () => {
        this.outbound.delete(edge);
        provider?.inbound.delete(edge);
      },
    };
    this.outbound.add(edge);
    provider?.inbound.add(edge);
    // 每次挂载只释放一次（binding 取出 releaseEdge 即清空）；drop 本身幂等
    return settling => {
      if (!settling) return edge.drop();
      edge.settling = settling;
      settling.then(edge.drop);
    };
  }

  /** 本激活已关完：撤回仍未落定的边不再让提供者等——自己的撤回段已按超时放弃过 */
  dropOutbound(): void {
    for (const edge of [...this.outbound]) edge.drop();
  }

  /**
   * 撤回段：本激活的服务已下线，就地驱动仍挂在上面的跟随者交接，返回交接落定。不经事件投递，
   * 慢跟随者不拖住别人。已进关闭计划的跟随者不驱动——拆卸窗口内的服务事件不引爆清理，它们由各自的撤回段收。
   */
  handover(): Promise<unknown> | undefined {
    const pending: Promise<void>[] = [];
    for (const edge of [...this.inbound]) {
      if (!edge.settling && !edge.from.resources.disposed) edge.pump();
      if (edge.settling) pending.push(edge.settling);
    }
    return pending.length === 0 ? undefined : Promise.all(pending);
  }

  closeInfo(): { children: Activation[]; providers: Map<Activation, boolean> } {
    const providers = new Map<Activation, boolean>();
    const depend = (owner: symbol | undefined, required: boolean): void => {
      const provider = owner && this.owners.get(owner);
      if (provider && provider !== this) providers.set(provider, required || providers.get(provider) === true);
    };
    for (const [name, required] of this.declared) depend(this.services.ownerOf(name), required);
    for (const edge of this.outbound) depend(edge.owner, edge.required);
    return { children: [...this.children], providers };
  }

  joinPlan(): (() => void) | undefined {
    if (this.closing) return undefined;
    this.resources.markClosing();
    let done!: () => void;
    this.closing = new Promise<void>(resolve => {
      done = resolve;
    });
    return done;
  }

  disposeAsync(timeoutMs?: number): Promise<void> {
    if (this.closing)
      return awaitWithTimeout(this.closing, timeoutMs, limit =>
        reportQuietly(() => this.logger.warn(`激活 "${this.id}": 等待在飞拆卸超过 ${limit}ms，放弃等待`)),
      );
    if (this.children.size === 0) return this.resources.disposeAsync(timeoutMs);
    return closeActivations([this], timeoutMs, this.logger);
  }
}
