import { type HostConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import { type Localized, localize, resolveText } from '../../packages/schema-i18n/src/index.js';

const I18N = '@aalis/plugin-i18n';

/**
 * 宿主配置文档的替身：plugin-i18n 的配置段写了全局语言（它的 language，会话设置的全局层），plugin-i18n 的宿主读者（WebUI、
 * 会话协议、终端）取它，语言诊断枚举的层只有它；plugins 给了就另写这些实例的配置段，其余实例的配置段是空的。返回改语言的
 * 函数，改了下一次读取即生效
 */
export function provideHostLanguage(
  app: App,
  language: string[],
  plugins: Record<string, Record<string, unknown>> = {},
): (next: string[]) => void {
  let current = language;
  const sections = (): Record<string, Record<string, unknown>> => ({ ...plugins, [I18N]: { language: [...current] } });
  app.bind({ provide }).provide.use(hostConfig, {
    getAll: () => ({ logLevel: 'info', plugins: sections() }),
    getPluginConfig: (id: string) => sections()[id] ?? {},
  } as unknown as HostConfig);
  return next => {
    current = next;
  };
}

/** 带宿主配置文档的 App（hostedApp）里写全局语言：文档里 plugin-i18n 的配置段 */
export const i18nSection = (language: string[]) => ({ plugins: { [I18N]: { language } } });

/** 改带宿主配置文档的 App 里的全局语言：改 plugin-i18n 的配置段，下一次读取即生效 */
export function setHostLanguage(app: App, language: string[]): void {
  app.bind({ hostConfig }).hostConfig.use.setPluginConfig(I18N, { language });
}

/** 值里的文字对象按 language 渲染，字符串、undefined 与其余值原样 */
export const renderIn = <T>(value: T, language: string): Localized<T> =>
  localize(value, text => resolveText(text, [language]));
