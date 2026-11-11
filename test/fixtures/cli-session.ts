import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import { provideHostPaths } from './host-paths.js';
import { registerHubs } from './hubs.js';
import { memoryStorage } from './memory-files.js';

/**
 * 给终端接上会话服务：钩子与贡献点枢纽、内存记忆、宿主路径（home）、存储替身、会话管理与会话服务，再给终端的会话（cli-default）
 * 建档。在装 plugin-cli 与 app.start 之前调；subscribed 在终端界面启动、订上这个会话之后落定。订上没有别的看得见的信号：会话服务
 * 回了订阅之后为没有用量的会话请 agent 重发用量（token:request），借它认
 */
export async function attachSessionServer(app: App, home: string): Promise<{ subscribed: Promise<void> }> {
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  provideHostPaths(app, home);
  const host = app.bind({ provide, events, sessionManager });
  host.provide.use(storage, memoryStorage(new Map()));
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  const subscribed = new Promise<void>(resolve => host.events.use.on('token:request', () => resolve()));
  await host.sessionManager.use.ensureSession('cli-default', {}, { createdFrom: 'cli' });
  return { subscribed };
}
