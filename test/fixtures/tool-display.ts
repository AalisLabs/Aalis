import type { BoundTools, ToolDisplay } from '../../packages/api-tools/src/index.js';
import type { Events, LifecycleCap } from '../../packages/core/src/index.js';
import { registerFileTools } from '../../packages/plugin-tool-system/src/tools/file.js';
import { registerShellTools } from '../../packages/plugin-tool-system/src/tools/shell.js';
import { silentLogger } from './authority.js';
import { stubBoundTools } from './bound-tools.js';

/** plugin-tool-system 给工具声明的展示种类：取自它真实的登记，不在测试里另抄一份。登记期不碰进程与存储 */
export function toolSystemDisplays(): Map<string, ToolDisplay> {
  const displays = new Map<string, ToolDisplay>();
  const capture = stubBoundTools({
    onRegister: tool => {
      if (tool.display) displays.set(tool.definition.function.name, tool.display);
    },
  });
  registerShellTools(capture, {
    logger: silentLogger(),
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} } as unknown as LifecycleCap,
    events: { on: () => () => {}, emit: async () => {} } as unknown as Events,
    isOwner: () => false,
    cwdUri: 'workspace:/',
    proc: {} as never,
    storage: {} as never,
    defaultTimeout: 30000,
    maxTimeout: 300000,
    maxOutputSize: 65536,
  });
  registerFileTools(capture, {
    maxReadSize: 1048576,
    maxSearchBytes: 1048576,
    maxWriteSize: 10485760,
    allowedRoots: ['*'],
    storage: {} as never,
    cwdState: {} as never,
  } as never);
  return displays;
}

/** 按 plugin-tool-system 的声明登记同名的空工具：会话服务据此解析工具卡的展示与审批卡上的事实 */
export function declareToolSystemDisplays(tools: BoundTools): void {
  for (const [name, display] of toolSystemDisplays()) {
    tools.register({
      definition: {
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties: {} } },
      },
      handler: async () => '',
      display,
    });
  }
}
