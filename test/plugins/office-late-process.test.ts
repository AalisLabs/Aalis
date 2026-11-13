import { afterEach, describe, expect, it } from 'vitest';
import { type ExecResult, processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import office from '../../packages/plugin-office/src/index.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// process 是 office 的 optional 依赖：不参与激活先后，本插件激活时它在不在只看时机。之后才上线（启用、安装、
// 晚一步激活）的 process 服务，pdf_convert 也要用得上。替身进程服务，不启动 LibreOffice。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('office：process 晚于本插件上线', () => {
  it('pdf_convert 调到之后上线的 process 服务', async () => {
    const app = new App({ logLevel: 'error', logHub: new LogHub() });
    apps.push(app);
    const host = app.bind({ provide });
    let convert: Omit<RegisteredTool, 'pluginName'> | undefined;
    host.provide.use(tools, {
      register(tool: Omit<RegisteredTool, 'pluginName'>) {
        if (tool.definition.function.name === 'pdf_convert') convert = tool;
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    host.provide.use(storage, {
      resolveLocalPath: async (uri: string) => `/zz-host/${uri.replace(':/', '/')}`,
    } as never);
    await app.plugins.register(office, {});
    await app.plugins.idle();
    if (!convert) throw new Error('pdf_convert 没有登记');

    const commands: string[] = [];
    host.provide.use(processService, {
      execFile: async (cmd: string) => {
        commands.push(cmd);
        return { code: 0, signal: null, stdout: '', stderr: '' } satisfies ExecResult;
      },
    } as never);
    await convert.handler({ inputPath: 'workspace:/a.docx' }, toolContext({ sessionId: 's' }));
    expect(commands).toEqual(['soffice']);
  });
});
