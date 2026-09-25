/** 只实现 SessionManager 用到的四个方法的假 memory；initial 预置会话表，测试从 meta 读落盘结果。 */
export function fakeMemory(initial: Record<string, Record<string, unknown>> = {}) {
  const meta = new Map(Object.entries(initial));
  return {
    meta,
    listMetadata: async () => [...meta].map(([key, data]) => ({ key, data })),
    commitMetadata: async (ops: Array<{ op: string; key: string; data?: Record<string, unknown> }>) => {
      for (const o of ops) {
        if (o.op === 'put' && o.data) meta.set(o.key, o.data);
        else if (o.op === 'del') meta.delete(o.key);
      }
    },
    getHistory: async () => [],
    clearSession: async () => {},
  };
}
