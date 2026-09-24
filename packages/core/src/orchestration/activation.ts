import { awaitWithTimeout, reportQuietly } from '../kernel/disposable-chain.js';

import type { ServiceContainer } from '../primitives/services.js';

import { closeActivations } from './close-plan.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

/** 挂在某激活所提供服务上的一条跟随边 */
interface InboundEdge {
  readonly from: Activation;
  /** 让该跟随者向当前胜者收敛 */
  readonly pump: () => void;
  /** 撤回已发起、尚未落定 */
  settling?: Promise<void>;
}

/** 内部激活记录：身份、资源寿命与依赖边。不提供事件、服务、配置管理等能力门面。 */
export class Activation {
  readonly children = new Set<Activation>();
  readonly declared = new Map<string, boolean>();
  private readonly bindings = new Map<symbol, [optional: number, required: number]>();
  private readonly inbound = new Set<InboundEdge>();
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
    const owner = this.services.ownerOf(name);
    if (owner === undefined) return () => {};
    const kind = this.declared.get(name) ? 1 : 0;
    const counts = this.bindings.get(owner) ?? [0, 0];
    counts[kind]++;
    this.bindings.set(owner, counts);
    const provider = this.owners.get(owner);
    const edge: InboundEdge = { from: this, pump };
    provider?.inbound.add(edge);
    const release = (): void => {
      provider?.inbound.delete(edge);
      counts[kind]--;
      if (counts[0] === 0 && counts[1] === 0) this.bindings.delete(owner);
    };
    let released = false;
    return settling => {
      if (released) return;
      released = true;
      if (!settling) return release();
      edge.settling = settling;
      settling.then(release);
    };
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
    for (const [owner, counts] of this.bindings) depend(owner, counts[1] > 0);
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
