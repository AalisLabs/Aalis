import type { HostPaths } from '../../packages/api-host-paths/src/index.js';
import { hostPaths } from '../../packages/api-host-paths/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import { derivePaths } from '../../packages/runtime/src/home.js';

/**
 * 像 runtime 一样在根上提供 host-paths：家目录与安装集都指到 `home`（测试的临时目录）。
 * 要在登记依赖它的插件（storage-local、package-manager 等）之前调用。
 */
export function provideHostPaths(app: App, home: string, appDir = home): HostPaths {
  const paths = derivePaths(home, appDir);
  app.bind({ provide }).provide.use(hostPaths, paths, { exclusive: true });
  return paths;
}
