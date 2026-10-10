import type { BoundStorage, OwnStorage, StorageService } from '../../packages/api-storage/src/index.js';

/**
 * 插件私有目录视图的替身：相对路径接到 `pluginData:/<dir>/` 下转给 storage，地址与真实视图一致。
 * 越界检查归 api-storage 的绑定（见 storage-own.test.ts），替身不查
 */
export function ownView(storage: StorageService, dir: string): OwnStorage {
  const uri = (path = '') => `pluginData:/${[dir, ...path.split('/').filter(Boolean)].join('/')}`;
  return {
    uri,
    list: path => storage.list(uri(path)),
    stat: path => storage.stat(uri(path)),
    readFile: (path, encoding) => storage.readFile(uri(path), encoding),
    readFileRange: (path, start, end) => storage.readFileRange!(uri(path), start, end),
    createReadStream: path => storage.createReadStream(uri(path)),
    writeFile: (path, data, options) => storage.writeFile(uri(path), data, options),
    rename: (path, newName) => storage.rename(uri(path), newName),
    move: (from, to) => storage.move(uri(from), uri(to)),
    mkdir: path => storage.mkdir(uri(path)),
    delete: path => storage.delete(uri(path)),
    resolveLocalPath: (path, access) => storage.resolveLocalPath!(uri(path), access),
    watch: (path, listener) => storage.watch!(uri(path), listener),
  };
}

/** 业务层替身：storage 上的方法照原样，另带名为 dir 的插件的私有目录 */
export function boundStorage(storage: StorageService, dir: string): BoundStorage {
  return Object.assign(Object.create(storage) as BoundStorage, { own: ownView(storage, dir) });
}
