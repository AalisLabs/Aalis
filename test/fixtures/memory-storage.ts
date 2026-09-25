/**
 * 只够 scheduler 读写持久化文件的内存 storage：一个 data 根加 readFile / writeFile，不是通用 storage 桩。
 * `seed` 预置文件内容；`files` 供测试读写盘结果，`service` 交给 provide。
 */
export function memoryStorage(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    service: {
      listRoots: () => [
        {
          name: 'data',
          label: 'data(内存)',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
      async readFile(uri: string) {
        const v = files.get(uri);
        if (v === undefined) throw new Error(`ENOENT: ${uri}`);
        return v;
      },
      async writeFile(uri: string, data: string | Buffer) {
        files.set(uri, typeof data === 'string' ? data : data.toString('utf-8'));
      },
    },
  };
}
