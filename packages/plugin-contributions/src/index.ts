// ============================================================
// @aalis/plugin-contributions — contributions 服务的默认提供者
//
// 登记表只做同步的数据插入与快照枚举，永不执行插件代码。归属与撤回由绑定门面的账本负责：
// 激活关闭时账本与事件、服务登记同一拍撤回，本表只按条目身份删除。
// ============================================================

import {
  assertContributionId,
  type ContributionHandle,
  type ContributionRegistry,
  type ContributionSpec,
  contributions,
} from '@aalis/api-contributions';
import { definePlugin, provide } from '@aalis/core';

interface Entry {
  readonly spec: ContributionSpec;
}

export class Registry implements ContributionRegistry {
  /** point → 全局键 → 条目（每次登记一个独立条目：退订按条目身份，同键已被替换时无动作） */
  readonly #points = new Map<string, Map<string, Entry>>();

  register(point: string, spec: ContributionSpec, contextId: string): () => void {
    assertContributionId(point, spec.id);
    let byKey = this.#points.get(point);
    if (!byKey) {
      byKey = new Map();
      this.#points.set(point, byKey);
    }
    const key = `${contextId}/${spec.id}`;
    const entry: Entry = { spec };
    byKey.set(key, entry);
    return () => {
      const current = this.#points.get(point);
      if (current?.get(key) !== entry) return;
      current.delete(key);
      if (current.size === 0) this.#points.delete(point);
    };
  }

  /** 按全局键码元序（默认比较，无 locale 依赖）；spec 按引用给出 */
  collect(point: string): ReadonlyArray<ContributionHandle> {
    const byKey = this.#points.get(point);
    if (!byKey) return [];
    return [...byKey.keys()].sort().map(key => ({ key, spec: (byKey.get(key) as Entry).spec }));
  }
}

export default definePlugin({
  name: '@aalis/plugin-contributions',
  displayName: '贡献点',
  subsystem: 'core',
  provides: [contributions],
  uses: { provide },
  apply({ provide }) {
    provide(contributions, new Registry());
  },
});
