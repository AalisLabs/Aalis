// ════════════════════════════════════════════════════════════
// 工具卡的展示：按工具定义上声明的展示种类（api-tools 的 display），从参数里逐字取出各项，调用结束后再从结果里取退出码。
// 实时的工具卡、历史里的工具卡与审批卡上的事实共用这一份解析。
// ════════════════════════════════════════════════════════════

import type { SessionItem } from '@aalis/api-session-protocol';
import type { ToolDisplay } from '@aalis/api-tools';

/** 工具卡上解析好的展示 */
export type ResolvedDisplay = NonNullable<Extract<SessionItem, { kind: 'tool-call' }>['display']>;

/** 按工具名、参数与结果（调用结束后才有）解析展示 */
export type DisplayOf = (tool: string, args: Record<string, unknown>, result?: string) => ResolvedDisplay | undefined;

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** 结果（JSON 对象）里 key 那一项的整数值；结果不是 JSON、那一项不是整数时没有 */
function integerIn(result: string, key: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return undefined;
  }
  const value: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, key) : undefined;
  return Number.isInteger(value) ? (value as number) : undefined;
}

/**
 * 没声明、种类不认识、必填的项（命令、路径）不是字符串时没有展示；可选的项（工作目录、删与加的两侧）不是字符串的不给。
 * 命令的退出码只在声明了取自结果的哪个键、给了结果且取得到整数时给
 */
export function resolveDisplay(
  spec: ToolDisplay | undefined,
  args: Record<string, unknown>,
  result?: string,
): ResolvedDisplay | undefined {
  const pick = (key: string | undefined) => (key === undefined ? undefined : text(args[key]));
  if (spec?.kind === 'command') {
    const command = pick(spec.fields.command);
    const cwd = pick(spec.fields.cwd);
    const exitCode = spec.result && result !== undefined ? integerIn(result, spec.result.exitCode) : undefined;
    if (command === undefined) return undefined;
    return {
      kind: 'command',
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
  if (spec?.kind === 'file-change') {
    const path = pick(spec.fields.path);
    const [removed, added] = [pick(spec.fields.removed), pick(spec.fields.added)];
    if (path === undefined) return undefined;
    return {
      kind: 'file-change',
      path,
      ...(removed === undefined ? {} : { removed }),
      ...(added === undefined ? {} : { added }),
    };
  }
  return undefined;
}
