import { awaitWithTimeout, reportQuietly } from '../kernel/disposable-chain.js';

import type { ServiceContainer } from '../primitives/services.js';

import { closeActivations } from './close-plan.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

/** 内部激活记录：身份、资源寿命与依赖边。不提供事件、服务、配置管理等能力门面。 */
export class Activation {
  readonly children = new Set<Activation>();
  readonly declared = new Map<string, boolean>();
  private readonly bindings = new Map<symbol, [optional: number, required: number]>();
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

  retainBinding(name: string): () => void {
    const owner = this.services.ownerOf(name);
    if (owner === undefined) return () => {};
    const kind = this.declared.get(name) ? 1 : 0;
    const counts = this.bindings.get(owner) ?? [0, 0];
    counts[kind]++;
    this.bindings.set(owner, counts);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      counts[kind]--;
      if (counts[0] === 0 && counts[1] === 0) this.bindings.delete(owner);
    };
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
