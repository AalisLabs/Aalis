import { defineService } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 测试用的登记型枢纽：与契约包枢纽（tools、hooks、contributions）同一做法——提供者是一张被动登记表，
// 门面经资源口的 registrar 登记、随激活同栈撤回，提供者换人时账本整体重挂。
// test/core 用它锚定 core 自己的登记语义（撤回时机、关闭后登记的政策、归属与标签），不依赖插件包。
// ════════════════════════════════════════════════════════════

/** 提供者：按登记次序保存 `激活 id/键 → 值`；同全局键为替换，退订按条目身份 */
export class HubRegistry {
  readonly #entries = new Map<string, { value: string }>();

  register(globalKey: string, value: string): () => void {
    const entry = { value };
    this.#entries.delete(globalKey);
    this.#entries.set(globalKey, entry);
    return () => {
      if (this.#entries.get(globalKey) === entry) this.#entries.delete(globalKey);
    };
  }

  /** 登记次序的快照：`全局键=值` */
  list(): string[] {
    return [...this.#entries].map(([key, { value }]) => `${key}=${value}`);
  }
}

export interface Hub {
  /** 登记一条（局部键自动冠本激活 id）；返回退订，随本次激活撤回 */
  add(key: string, value: string): () => void;
  /** 当前提供者的快照 */
  list(): string[];
}

export const hub = defineService<HubRegistry, Hub>('__t:hub', port => {
  const ledger = port.registrar<{ key: string; value: string }>({
    key: ({ key }) => key,
    register: (registry, { key, value }) => registry.register(`${port.id}/${key}`, value),
  });
  return {
    add: (key, value) => ledger.add({ key, value }),
    list: () => port.require().list(),
  };
});
