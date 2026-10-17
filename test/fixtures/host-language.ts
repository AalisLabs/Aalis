import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';

/**
 * 会话管理的替身，只给全局默认层的语言：plugin-i18n 的宿主读者（WebUI、会话协议、终端）取它，语言诊断枚举的层只有它。设置项的
 * 登记收下不管，会话一律不存在。返回改这一层语言的函数
 */
export function provideHostLanguage(app: App, language: string[]): (next: string[]) => void {
  const layer = { language };
  app.bind({ provide }).provide.use(sessionManager, {
    getLayer: () => layer,
    listLayers: () => [{ scope: 'defaults' }],
    resolveConfig: () => ({}),
    getSession: () => undefined,
    registerSetting: () => () => {},
  } as never);
  return next => {
    layer.language = next;
  };
}
