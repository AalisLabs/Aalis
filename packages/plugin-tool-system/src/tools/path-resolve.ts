/**
 * Storage URI 的解析、归一化与"基于 cwd 的相对路径"求值。
 *
 * 背景：所有 file_* 工具都接受三类输入：
 *   1) 完整 storage URI（`aalis:/packages/core`）
 *   2) 相对路径（`packages/core`、`./a.ts`、`../plugin-tools`）
 *   3) 宿主机绝对路径（`/Users/...`、`C:\...`）—— 一律拒绝
 *
 * 改造前 (2) 永远拼到一个静态的 `defaultRoot`，与 `cwd` 工具的返回值
 * 完全脱钩，造成 LLM 心智模型崩坏。改造后 (2) 严格基于当前 session 的
 * cwd 求值，行为与 unix shell 一致。
 *
 * 不引入额外依赖：拆/合 URI 都用纯字符串，避免引入 path posix/win32 分歧。
 */

interface ParsedUri {
  root: string;
  /** 不含前导 `/`；空数组表示根目录 `<root>:/` */
  segments: string[];
}

/**
 * 拆分一个完整的 storage URI 为根名 + 路径段。
 * 仅接受 `<root>:/<path>` 格式；任何不带 `:/` 的输入都视为非法。
 */
export function parseStorageUri(uri: string): ParsedUri {
  const idx = uri.indexOf(':/');
  if (idx <= 0) {
    throw new Error(`存储 URI 不合法: "${uri}"（应为 <根名>:/<相对路径>，例如 workspace:/notes/a.md）`);
  }
  const root = uri.slice(0, idx);
  const rest = uri.slice(idx + 2).replace(/^\/+/, '');
  const segments = rest ? rest.split('/').filter(Boolean) : [];
  return { root, segments: normalizeSegments(segments) };
}

/** 把根名 + 段重新拼回 URI；空段返回 `<root>:/`。 */
function joinStorageUri(root: string, segments: readonly string[]): string {
  const tail = segments.length ? segments.join('/') : '';
  return `${root}:/${tail}`;
}

/**
 * 归一化路径段：消除空段、`.`、`..`。
 * `..` 在根目录处会被 clamp（不允许越过 root）。
 */
function normalizeSegments(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const seg of input) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      // 已在根目录则忽略，永远不会越过 <root>:/
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** 用反斜杠/正斜杠混排的路径统一成正斜杠。 */
function unifySlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

/**
 * 把用户输入的"路径"求值为完整 storage URI。
 *
 * 规则（按顺序）：
 * 1. 空 / `.` → 当前 cwd 自身
 * 2. 含 `:/` → 视为完整 storage URI，归一化后返回
 * 3. 宿主机绝对路径（`/abs` 或 `C:\path`）→ 抛错（带可操作的提示）
 * 4. 其它 → 视为相对当前 cwd 的路径求值
 *
 * 抛错信息会引导 agent 用 `cwd` 工具查看可用根，避免反复试错。
 */
export function resolveAgainstCwd(input: string | undefined, cwd: string): string {
  const raw = (input ?? '').trim();
  const cwdParsed = parseStorageUri(cwd);

  if (!raw || raw === '.') return joinStorageUri(cwdParsed.root, cwdParsed.segments);

  // 完整 storage URI（含协议头），优先匹配以避免与 windows 盘符冲突
  if (/^[a-zA-Z][a-zA-Z0-9_-]*:\//.test(raw)) {
    const parsed = parseStorageUri(unifySlashes(raw));
    return joinStorageUri(parsed.root, parsed.segments);
  }

  // 宿主机绝对路径：windows 盘符 或 posix `/...`
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/')) {
    throw new Error(
      `不接受宿主机绝对路径 "${raw}"。请改用 storage URI（如 aalis:/packages/core）` +
        `或相对当前 cwd 的路径。调用 cwd 工具可查看当前目录与所有可用 storage 根。`,
    );
  }

  // 相对路径：拼到当前 cwd 之下
  const relSegments = unifySlashes(raw).split('/').filter(Boolean);
  return joinStorageUri(cwdParsed.root, normalizeSegments([...cwdParsed.segments, ...relSegments]));
}

/** 仅取出 URI 的根名（用于权限检查、所属根校验）。 */
export function rootOf(uri: string): string {
  return parseStorageUri(uri).root;
}
