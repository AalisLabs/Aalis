import type { DisposableChain } from './disposable-chain.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './service.js';
import type { RegisteredTool, ToolGroupInfo, CommandDefinition, ToolService, CommandService, AalisEvents } from './types/index.js';

/**
 * 工具/指令注册缓冲
 *
 * 用途：插件加载顺序无法保证 tools/commands 服务已就绪时，
 * 调用 `ctx.registerTool / registerToolGroup / command` 会被临时收纳，
 * 等 `service:registered` 事件触发后自动刷入真实服务。
 *
 * 从 Context 抽出以便独立测试与理解。
 *
 * 设计要点：
 * - 该缓冲是"按 Context 实例一份"的，因为每条注册都要归属到发起者 contextId
 * - 刷入成功后获得的 dispose 函数会被加入传入的 DisposableChain，保证 Context
 *   dispose 时能统一回收
 * - 如调用方尚未刷入前主动 dispose，会从本地数组里移除条目，不会到达底层服务
 */
export class PendingRegistrationBuffer {
  private _tools: Omit<RegisteredTool, 'pluginName'>[] = [];
  private _toolGroups: Omit<ToolGroupInfo, 'pluginName'>[] = [];
  private _commands: { def: CommandDefinition; ctxId: string }[] = [];
  private _flushListenerAttached = false;

  constructor(
    private readonly contextId: string,
    private readonly services: ServiceContainer,
    private readonly logger: Logger,
    private readonly disposables: DisposableChain,
    /** 由 Context 注入的 `on(event, handler)` —— 让生命周期统一托管 */
    private readonly onEvent: <E extends string & keyof AalisEvents>(
      event: E,
      handler: (...args: AalisEvents[E]) => void | Promise<void>,
    ) => () => void,
  ) {}

  /** 注册 AI 工具。服务可用则直接注册，否则缓冲到 tools 服务就绪。 */
  registerTool(tool: Omit<RegisteredTool, 'pluginName'>): () => void {
    const tools = this.services.get<ToolService>('tools');
    if (tools) {
      const dispose = tools.register(tool, this.contextId);
      this.disposables.push(dispose);
      return dispose;
    }
    this._tools.push(tool);
    this._ensureFlushListener();
    this.logger.debug(`工具 "${tool.definition.function.name}" 已缓冲，等待 tools 服务就绪`);
    return () => {
      const idx = this._tools.indexOf(tool);
      if (idx >= 0) this._tools.splice(idx, 1);
    };
  }

  /** 注册工具分组。行为同 registerTool。 */
  registerToolGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void {
    const tools = this.services.get<ToolService>('tools');
    if (tools) {
      const dispose = tools.registerGroup(group, this.contextId);
      this.disposables.push(dispose);
      return dispose;
    }
    this._toolGroups.push(group);
    this._ensureFlushListener();
    this.logger.debug(`工具分组 "${group.name}" 已缓冲，等待 tools 服务就绪`);
    return () => {
      const idx = this._toolGroups.indexOf(group);
      if (idx >= 0) this._toolGroups.splice(idx, 1);
    };
  }

  /** 注册斜杠指令。服务可用则直接注册，否则缓冲到 commands 服务就绪。 */
  registerCommand(def: CommandDefinition): () => void {
    const commands = this.services.get<CommandService>('commands');
    if (commands) {
      const dispose = commands.register(def, this.contextId);
      this.disposables.push(dispose);
      return dispose;
    }
    const entry = { def, ctxId: this.contextId };
    this._commands.push(entry);
    this._ensureFlushListener();
    this.logger.debug(`指令 "${def.name}" 已缓冲，等待 commands 服务就绪`);
    return () => {
      const idx = this._commands.indexOf(entry);
      if (idx >= 0) this._commands.splice(idx, 1);
    };
  }

  /** 清空本地缓冲（Context.dispose 时调用，底层服务已由 DisposableChain 回收） */
  clear(): void {
    this._tools = [];
    this._toolGroups = [];
    this._commands = [];
  }

  private _ensureFlushListener(): void {
    if (this._flushListenerAttached) return;
    this._flushListenerAttached = true;

    const off = this.onEvent('service:registered', (svcName: string) => {
      if (svcName === 'tools') this._flushTools();
      if (svcName === 'commands') this._flushCommands();
    });
    this.disposables.push(off);
  }

  private _flushTools(): void {
    const tools = this.services.get<ToolService>('tools');
    if (!tools) return;
    for (const tool of this._tools) {
      const dispose = tools.register(tool, this.contextId);
      this.disposables.push(dispose);
    }
    this._tools = [];
    for (const group of this._toolGroups) {
      const dispose = tools.registerGroup(group, this.contextId);
      this.disposables.push(dispose);
    }
    this._toolGroups = [];
  }

  private _flushCommands(): void {
    const commands = this.services.get<CommandService>('commands');
    if (!commands) return;
    for (const { def, ctxId } of this._commands) {
      const dispose = commands.register(def, ctxId);
      this.disposables.push(dispose);
    }
    this._commands = [];
  }
}
