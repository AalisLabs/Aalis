// ════════════════════════════════════════════════════════════
// 四个后台任务工具（执行器提供）：列出、取输出、等待、停止本会话里的后台任务。只看本会话里与本轮同一授权身份起的
// （owner 看得到全部），别的一律回「不存在」。不设 restricted 与 risk：可转后台的工具多是 public，房间里谁都能起；
// 结束通知开的那一轮按起它的人的身份运行，取结果的工具挡掉 0 级就取不到。按身份放行等同前台：同一个人在前台本来就
// 拿得到这次结果。
// ════════════════════════════════════════════════════════════

import type { BackgroundTask, RegisteredTool, ToolCallContext, ToolExecutionResult } from '@aalis/api-tools';
import { type BackgroundTasks, DEFAULT_YIELD_SECONDS, viewOf } from './background.js';

type Tool = Omit<RegisteredTool, 'pluginName'>;

const error = (message: string) => JSON.stringify({ error: message });
const missing = (id: unknown) => error(`后台任务 "${String(id)}" 不存在`);

/** 任务连同结束时工具的结果；调用方能看图时带上结果里的图 */
function withResults(
  fields: Record<string, unknown>,
  tasks: BackgroundTask[],
  ctx: ToolCallContext,
): ToolExecutionResult {
  const images = ctx.acceptsImages ? tasks.flatMap(task => task.result?.images ?? []) : [];
  return { content: JSON.stringify(fields), ...(images.length > 0 ? { images } : {}) };
}

const resultOf = (task: BackgroundTask) => (task.result ? { result: task.result.content } : {});

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  handler: Tool['handler'],
): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    },
    handler,
  };
}

export function backgroundTaskTools(tasks: BackgroundTasks): Tool[] {
  const { maxWaitSeconds } = tasks.limits;
  const find = (ctx: ToolCallContext, id: unknown) => tasks.visible(ctx).find(task => task.id === id);
  const taskId = { type: 'string', description: '任务 id（转到后台时回给你的 taskId）' };

  return [
    tool(
      'background_list',
      '列出本会话里你起的后台任务（转到后台的工具调用）：任务 id、工具、状态、开始与结束时间、输出的最后一行与最后输出时间，' +
        '失败或中断的带原因，命令带退出码。',
      {},
      [],
      async (_args, ctx) => JSON.stringify({ tasks: tasks.visible(ctx).map(viewOf) }),
    ),

    tool(
      'background_output',
      '取一个后台任务的输出（只保留最近 64 KiB）。返回的 end 是至今的输出总字数，下次带作 after 只取新增的部分；' +
        '早于保留范围的取不到时 truncated 为 true。结束的任务一并给出工具的结果。',
      { taskId, after: { type: 'integer', description: '只取这个位置之后的输出（上次返回的 end）' } },
      ['taskId'],
      async (args, ctx) => {
        const { after } = args;
        if (after !== undefined && !(Number.isInteger(after) && (after as number) >= 0)) {
          return error('after 要是不小于 0 的整数');
        }
        const task = find(ctx, args.taskId);
        const output = task && tasks.output(task.id, after as number | undefined);
        if (!task || !output) return missing(args.taskId);
        return withResults(
          { ...viewOf(task), output: output.text, end: output.end, truncated: output.truncated, ...resultOf(task) },
          [task],
          ctx,
        );
      },
    ),

    tool(
      'background_wait',
      `等列出的后台任务都结束，最多等 waitSeconds 秒（默认 ${DEFAULT_YIELD_SECONDS}，最多 ${maxWaitSeconds}），这一轮被中止时不再等。` +
        '返回各任务的状态与最后输出时间，结束的带工具的结果。在对话里转到后台的任务结束时会通知你，不必一直等。',
      {
        taskIds: { type: 'array', items: { type: 'string' }, description: '要等的任务 id' },
        waitSeconds: {
          type: 'number',
          description: `最多等多少秒（默认 ${DEFAULT_YIELD_SECONDS}，最多 ${maxWaitSeconds}）`,
        },
      },
      ['taskIds'],
      async (args, ctx) => {
        const { taskIds, waitSeconds = DEFAULT_YIELD_SECONDS } = args;
        if (!Array.isArray(taskIds) || taskIds.length === 0) return error('taskIds 要是非空的任务 id 列表');
        if (!(typeof waitSeconds === 'number' && Number.isFinite(waitSeconds) && waitSeconds >= 0)) {
          return error('waitSeconds 要是不小于 0 的秒数');
        }
        const unknown = taskIds.filter(id => !find(ctx, id));
        if (unknown.length > 0) return missing(unknown.join('、'));
        await tasks.wait(taskIds as string[], Math.min(waitSeconds, maxWaitSeconds) * 1000, ctx.signal);
        const settled = taskIds.flatMap(id => find(ctx, id) ?? []);
        return withResults({ tasks: settled.map(task => ({ ...viewOf(task), ...resultOf(task) })) }, settled, ctx);
      },
    ),

    tool(
      'background_stop',
      '停掉一个后台任务，等它停下后如实回报（最多等 3 秒）。被停掉的任务不再通知你。',
      { taskId },
      ['taskId'],
      async (args, ctx) => {
        const task = find(ctx, args.taskId);
        if (!task) return missing(args.taskId);
        if (task.status !== 'running') return JSON.stringify({ ...viewOf(task), message: '任务已结束' });
        const after = await tasks.stop(task.id);
        if (!after) return missing(args.taskId);
        return JSON.stringify({
          ...viewOf(after),
          message: after.status === 'running' ? '已发出停止，3 秒内还没停下；它停下后记为已停止，不会通知你' : '已停止',
        });
      },
    ),
  ];
}
