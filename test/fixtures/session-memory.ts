/**
 * 只实现 SessionManager 用到的四个方法的假 memory，元数据按命名空间分开存。initial 预置会话表，places 预置场所记录；
 * 测试从 meta（会话表）与 places 读落盘结果。
 */
export function fakeMemory(
  initial: Record<string, Record<string, unknown>> = {},
  places: Record<string, Record<string, unknown>> = {},
) {
  const namespaces = new Map([
    ['sessions', new Map(Object.entries(initial))],
    ['places', new Map(Object.entries(places))],
  ]);
  const table = (namespace: string) => {
    const rows = namespaces.get(namespace) ?? new Map<string, Record<string, unknown>>();
    namespaces.set(namespace, rows);
    return rows;
  };
  return {
    meta: table('sessions'),
    places: table('places'),
    listMetadata: async (namespace: string) => [...table(namespace)].map(([key, data]) => ({ key, data })),
    commitMetadata: async (
      ops: Array<{ op: string; namespace: string; key: string; data?: Record<string, unknown> }>,
    ) => {
      for (const o of ops) {
        if (o.op === 'put' && o.data) table(o.namespace).set(o.key, o.data);
        else if (o.op === 'del') table(o.namespace).delete(o.key);
      }
    },
    getHistory: async () => [],
    clearSession: async () => {},
  };
}
