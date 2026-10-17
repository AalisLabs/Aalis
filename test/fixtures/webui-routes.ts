import { localizeFor } from '../../packages/api-i18n/src/index.js';
import type { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;

interface RouteReply {
  status: number;
  body?: unknown;
}

/** i18n 缺席：回应里的文字对象按原文渲染，同真实出口在 i18n 不在时 */
const ABSENT = { present: false } as Parameters<typeof localizeFor>[0];
/** 缺席时不会调 onError，调了就是出了错，照样抛出 */
const rethrow = (err: unknown) => {
  throw err;
};

/**
 * 路由测试挂具，不起端口。路由注册器只调用 `app.<method>(path, ...handlers)`：`expressApp` 是把处理器链
 * 按「METHOD path」记下的假 app；`invoke` 取出链，带 res 桩（status / json 写进回复）经 next 逐个执行。
 * json 写进回复之前按 i18n 缺席渲染（读者语言与跳过原样数据的出口见 test/plugins/webui-i18n.test.ts）。
 */
export function captureRoutes(): {
  expressApp: Parameters<typeof registerPluginRoutes>[0];
  invoke: (key: string, req?: unknown) => Promise<RouteReply>;
} {
  const routes = new Map<string, Handler[]>();
  const expressApp = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (path: string, ...handlers: Handler[]) => {
          routes.set(`${String(method).toUpperCase()} ${path}`, handlers);
        },
    },
  );
  const invoke = async (key: string, req: unknown = {}): Promise<RouteReply> => {
    const handlers = routes.get(key);
    if (!handlers) throw new Error(`路由未注册: ${key}`);
    const out: RouteReply = { status: 200 };
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(payload: unknown) {
        out.body = localizeFor(ABSENT, payload, { languages: [] }, { onError: rethrow });
        return res;
      },
    };
    let i = 0;
    const next = async (): Promise<void> => {
      const h = handlers[i++];
      if (h) await h(req, res, next);
    };
    await next();
    return out;
  };
  return { expressApp: expressApp as never, invoke };
}
