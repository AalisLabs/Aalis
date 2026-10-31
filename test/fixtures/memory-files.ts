import type { StorageService } from '../../packages/api-storage/src/index.js';

/** 文件表：键是完整 URI；文本以字符串存，二进制以字节存 */
export type MemoryFiles = Map<string, string | Uint8Array>;

const notFound = (uri: string) => Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
const sizeOf = (value: string | Uint8Array) =>
  typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength;

/**
 * pluginData 与 workspace 两个根的内存 storage：读写、列目录、stat、按前缀删目录；不存在的一律抛 ENOENT。
 * 目录不单独存，有文件在它下面就算存在。
 */
export function memoryStorage(files: MemoryFiles): StorageService {
  const roots = ['pluginData', 'workspace'].map(name => ({
    name,
    label: `${name}(内存)`,
    kind: name,
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  }));
  const under = (uri: string) => `${uri.replace(/\/+$/, '')}/`;
  const rootOf = (uri: string) => roots.find(r => uri.startsWith(`${r.name}:`)) ?? roots[0];
  return {
    listRoots: () => roots,
    async readFile(uri: string, encoding?: BufferEncoding) {
      const value = files.get(uri);
      if (value === undefined) throw notFound(uri);
      const bytes = Buffer.from(value);
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, typeof data === 'string' ? data : new Uint8Array(data));
    },
    async stat(uri: string) {
      const value = files.get(uri);
      const name = uri.split('/').pop() ?? '';
      if (value !== undefined) return { name, path: uri, uri, isDirectory: false, size: sizeOf(value) };
      if ([...files.keys()].some(k => k.startsWith(under(uri)))) {
        return { name, path: uri, uri, isDirectory: true, size: 0 };
      }
      throw notFound(uri);
    },
    async list(uri: string) {
      const base = under(uri);
      const entries = new Map<string, { isDirectory: boolean; size: number }>();
      for (const [key, value] of files) {
        if (!key.startsWith(base)) continue;
        const [head, ...rest] = key.slice(base.length).split('/');
        entries.set(
          head,
          rest.length > 0 ? { isDirectory: true, size: 0 } : { isDirectory: false, size: sizeOf(value) },
        );
      }
      if (entries.size === 0) throw notFound(uri);
      return {
        root: rootOf(uri),
        path: uri,
        entries: [...entries].map(([name, e]) => ({
          name,
          path: `${base}${name}`,
          uri: `${base}${name}`,
          isDirectory: e.isDirectory,
          size: e.size,
          mtime: '',
          ext: '',
        })),
      };
    },
    async delete(uri: string) {
      const hits = [...files.keys()].filter(k => k === uri || k.startsWith(under(uri)));
      if (hits.length === 0) throw notFound(uri);
      for (const key of hits) files.delete(key);
    },
  } as unknown as StorageService;
}
