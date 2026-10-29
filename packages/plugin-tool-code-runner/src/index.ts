import { codeSandbox } from '@aalis/api-code-sandbox';
import { processService } from '@aalis/api-process';
import { resolveAgainstCwd, storage } from '@aalis/api-storage';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { type RunnerConfig, runCode } from './runner.js';
import { t } from './texts.js';

const configSchema = defineConfig({
  python: {
    label: 'Python',
    fields: {
      enabled: { type: 'boolean', label: t('enableTool', { tool: 'run_python' }), default: true, onInvalid: 'error' },
      interpreter: {
        type: 'string',
        label: t('interpreterLabel'),
        default: 'python3',
        required: true,
        onInvalid: 'error',
        description: t('pythonInterpreterDescription'),
      },
    },
  },
  javascript: {
    label: 'JavaScript (Node.js)',
    fields: {
      enabled: {
        type: 'boolean',
        label: t('enableTool', { tool: 'run_javascript' }),
        default: true,
        onInvalid: 'error',
      },
      interpreter: {
        type: 'string',
        label: t('interpreterLabel'),
        default: 'node',
        required: true,
        onInvalid: 'error',
        description: t('javascriptInterpreterDescription'),
      },
    },
  },
  maxOutputSize: {
    type: 'number',
    label: t('maxOutputSizeLabel'),
    default: 131072,
    description: t('maxOutputSizeDescription'),
  },
  workingDirectory: {
    type: 'string',
    label: t('workingDirectoryLabel'),
    default: 'workspace:/',
    onInvalid: 'error',
    description: t('workingDirectoryDescription'),
  },
  sandbox: {
    label: t('sandboxLabel'),
    fields: {
      mode: {
        type: 'select',
        label: t('modeLabel'),
        default: 'auto',
        onInvalid: 'error',
        options: [
          { label: t('modeAuto'), value: 'auto' },
          { label: t('modeNone'), value: 'none' },
        ],
        description: t('modeDescription'),
      },
      network: {
        type: 'select',
        label: t('networkLabel'),
        default: 'deny',
        onInvalid: 'error',
        options: [
          { label: t('networkDeny'), value: 'deny' },
          { label: t('networkAllow'), value: 'allow' },
        ],
        description: t('networkDescription'),
      },
    },
  },
});

// ===== 配置解析 =====

type CodeRunnerConfig = ConfigOf<typeof configSchema>;

function toRunnerCwdUri(input: string | undefined): string {
  return resolveAgainstCwd(input, 'workspace:/');
}

/**
 * 交给脚本的环境变量白名单，两种模式下都只交这些（runner 另加 PYTHONIOENCODING）。SystemRoot 以下几项给 Windows：
 * 它没有沙箱后端、只能 mode=none，系统组件要 SystemRoot 等，解释器的临时目录与用户目录取 TEMP、TMP、USERPROFILE
 */
function safeEnv(): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'LANG',
    'LC_ALL',
    'TERM',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// ===== 插件入口 =====

// storage 仅按名等待；local-path 由 createRunnerConfig 运行时探测 resolveLocalPath 守卫。
// tools 只被登记、不被读，缺席时记在归属表里等提供者到场，因此不设激活闸。
const uses = {
  tools: optional(tools),
  storage,
  proc: processService,
  codeSandbox: optional(codeSandbox),
  logger,
  config,
};
type Caps = BoundOf<typeof uses>;

async function createRunnerConfig(
  caps: Pick<Caps, 'storage' | 'codeSandbox'>,
  cfg: CodeRunnerConfig,
): Promise<RunnerConfig> {
  if (!caps.storage.present) throw new Error('代码执行器需要 storage 服务');
  const gateway = caps.storage.use;
  const cwdUri = toRunnerCwdUri(cfg.workingDirectory);
  return {
    maxOutputSize: cfg.maxOutputSize,
    cwd: await gateway.resolveLocalPath(cwdUri, 'read'),
    env: safeEnv(),
    // mode='none' → 不带 sandbox（裸跑）；mode='auto' → 带策略，runCode 经 code-sandbox 强制隔离或 fail-closed
    sandbox: cfg.sandbox.mode === 'none' ? undefined : { network: cfg.sandbox.network },
    codeSandbox: caps.codeSandbox.present ? caps.codeSandbox.use : undefined,
  };
}

export default definePlugin({
  name: '@aalis/plugin-tool-code-runner',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  uses,
  apply(caps) {
    const { tools, proc, storage, codeSandbox, logger } = caps;
    const cfg = parseConfig(configSchema, caps.config.use, logger.use);
    if (cfg.sandbox.mode === 'none') {
      logger.use.warn(
        '注意：code-runner 运行在【无隔离】模式（sandbox.mode=none）：代码以宿主用户全权限裸跑，仅在完全可信环境使用。',
      );
    }
    const cwdUri = toRunnerCwdUri(cfg.workingDirectory);
    // 每次调用现取：cwd 要按当时的 storage 实况解析，沙箱后端也可能中途上下线
    const runnerDeps = { storage, codeSandbox };

    // 创建带分组标记的工具视图
    const groupTools = withToolGroups(tools.use, ['code-runner']);

    // 注册工具分组
    tools.use.registerGroup({
      name: 'code-runner',
      label: t('groupLabel'),
      summary: t('groupSummary'),
      description: '编写并运行 Python / JavaScript 代码来解决计算、分析、文件处理等问题',
    });

    const osName = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';

    // ==================== run_python ====================
    if (cfg.python.enabled) {
      groupTools.register({
        definition: {
          type: 'function',
          function: {
            name: 'run_python',
            description:
              `在本机 ${osName} 系统上编写并执行一段 Python 脚本，返回 stdout 和 stderr。` +
              '代码会保存到临时文件后执行，无需担心转义问题，可以编写任意多行代码。\n\n' +
              '**适用场景（请在合适时主动使用）：**\n' +
              '- 复杂数学计算、方程求解、符号推导（math / sympy / numpy / scipy）\n' +
              '- 数据统计分析、CSV/JSON 数据处理（pandas / json / csv）\n' +
              '- 批量文件解析与文本处理（正则匹配、格式转换、批量重命名）\n' +
              '- 编码转换、加解密、哈希计算（base64 / hashlib）\n' +
              '- 日期 / 时间计算（datetime / calendar）\n' +
              '- 需要精确结果而非近似回答的任何计算问题\n' +
              '- 生成结构化输出（表格、Markdown、LaTeX）\n\n' +
              '**使用技巧：**\n' +
              '- 将最终结果通过 print() 输出，该输出会作为工具返回值\n' +
              '- 可使用标准库和已安装的第三方库（如 numpy, sympy, pandas 等）\n' +
              '- 处理多个文件时，在一个脚本内循环处理并汇总输出，效率远高于多次调用\n' +
              '- 若需读写文件，请优先使用相对于逻辑工作目录的路径；不要依赖宿主机绝对路径',
            parameters: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: '完整的 Python 脚本源代码',
                },
              },
              required: ['code'],
              additionalProperties: false,
            },
          },
        },
        visibility: 'restricted',
        background: {},
        handler: async (args, callCtx) => {
          const code = args.code as string;
          logger.use.debug(`run_python: ${code.length} 字符`);
          const runnerConfig = await createRunnerConfig(runnerDeps, cfg);
          const result = await runCode(
            proc.use,
            storage.use,
            cfg.python.interpreter,
            code,
            '.py',
            runnerConfig,
            [],
            callCtx.signal,
          );
          return JSON.stringify(result);
        },
      });

      logger.use.info(`Python 代码执行工具已启用 (解释器: ${cfg.python.interpreter})`);
    }

    // ==================== run_javascript ====================
    if (cfg.javascript.enabled) {
      groupTools.register({
        definition: {
          type: 'function',
          function: {
            name: 'run_javascript',
            description:
              `在本机 ${osName} 系统上编写并执行一段 JavaScript (Node.js) 脚本，返回 stdout 和 stderr。` +
              '代码会保存为 .mjs 文件（ESM 模块）后执行，支持 top-level await。\n\n' +
              '**适用场景（请在合适时主动使用）：**\n' +
              '- JSON 数据处理与转换\n' +
              '- 正则表达式测试与文本处理\n' +
              '- Node.js API 调用、文件系统操作\n' +
              '- HTTP 请求与 API 测试（fetch）\n' +
              '- 需要 JavaScript 运行时特性的验证和计算\n\n' +
              '**使用技巧：**\n' +
              '- 通过 console.log() 输出结果\n' +
              '- 使用 ESM import 语法导入模块\n' +
              '- 支持 top-level await，可直接使用 await fetch(...) 等',
            parameters: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: '完整的 JavaScript (Node.js ESM) 脚本源代码',
                },
              },
              required: ['code'],
              additionalProperties: false,
            },
          },
        },
        visibility: 'restricted',
        background: {},
        handler: async (args, callCtx) => {
          const code = args.code as string;
          logger.use.debug(`run_javascript: ${code.length} 字符`);
          const runnerConfig = await createRunnerConfig(runnerDeps, cfg);
          const result = await runCode(
            proc.use,
            storage.use,
            cfg.javascript.interpreter,
            code,
            '.mjs',
            runnerConfig,
            [],
            callCtx.signal,
          );
          return JSON.stringify(result);
        },
      });

      logger.use.info(`JavaScript 代码执行工具已启用 (解释器: ${cfg.javascript.interpreter})`);
    }

    logger.use.info(`代码执行器插件已启动 (工作目录: ${cwdUri})`);
  },
});
