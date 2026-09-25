/**
 * 文件操作工具组
 *
 * 路径语义（与 shell 一致的 unix 心智模型）：
 * - 完整 storage URI：如 `aalis:/packages/core`、`workspace:/notes/a.md`、`tmp:/x`
 * - 相对路径：如 `packages/core`、`./a.ts`、`../plugin-tools` —— 永远基于
 *   当前 session 的 cwd 解析（由 cwd / cd 工具查询/切换）
 * - 宿主机绝对路径（如 `/Users/...`、`C:\...`）一律拒绝
 *
 * 设计动机：LLM agent 在多轮对话中经常需要"在 X 目录下查看一系列文件"，
 * 如果每次都要写完整 URI 负担大且易错；有了 cwd + 相对路径后类似人在 shell 里。
 */

import { basename } from 'node:path';
import type { StorageService } from '@aalis/api-storage';
import { parseUriRoot, resolveAgainstCwd } from '@aalis/api-storage';
import type { BoundTools } from '@aalis/api-tools';
import type { CwdState } from './cwd-state.js';

interface FileConfig {
  maxReadSize: number;
  maxSearchBytes: number;
  maxWriteSize: number;
  allowedRoots: string[];
  /** 共享的 cwd 状态（与 cwd/cd 工具同源），决定相对路径的解析基准 */
  cwdState: CwdState;
  storage?: StorageService;
}

function getKnownRoots(config: FileConfig) {
  return config.storage?.listRoots() ?? [];
}

const ALL_ROOTS = '*';

function getAllowedRoots(config: FileConfig): string[] {
  if (config.allowedRoots.includes(ALL_ROOTS)) {
    return getKnownRoots(config)
      .filter(r => r.readable)
      .map(r => r.name);
  }
  return config.allowedRoots;
}

function allowedRootsText(config: FileConfig): string {
  const allowed = getAllowedRoots(config);
  return allowed.length ? allowed.join(', ') : '(无)';
}

/**
 * 把用户输入解析为完整 storage URI。
 *
 * 仅是 resolveAgainstCwd 的薄包装：从 cwdState 读取当前 session 的 cwd 作为基准。
 * 宿主机绝对路径的拒绝提示被加强为附带当前可用根信息，避免反复试错。
 */
function toStorageUri(input: string | undefined, config: FileConfig, sessionId: string | undefined): string {
  const cwd = config.cwdState.get(sessionId);
  try {
    return resolveAgainstCwd(input, cwd);
  } catch (err) {
    // 只在宿主绝对路径分支补充可读根提示。其余错误原样抛出。
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('宿主机绝对路径')) {
      const known =
        getKnownRoots(config)
          .map(r => r.name)
          .join(', ') || '(无)';
      throw new Error(`${message} 当前 cwd: ${cwd}。已注册根: ${known}。本工具允许根: ${allowedRootsText(config)}。`);
    }
    throw err;
  }
}

function ensureRootAllowed(uri: string, config: FileConfig): void {
  const root = parseUriRoot(uri);
  if (!getAllowedRoots(config).includes(root)) {
    const known = getKnownRoots(config).map(r => r.name);
    const unknown = !known.includes(root);
    throw new Error(
      unknown
        ? `根 "${root}" 不存在。当前已注册根: ${known.join(', ') || '(无)'}；本工具允许: ${allowedRootsText(config)}`
        : `本工具不允许访问 ${root}:/。允许的根: ${allowedRootsText(config)}（如需放开，改 file.allowedRoots 配置；可设为 ["*"] 允许全部可读根）`,
    );
  }
}

function requireStorage(config: FileConfig): StorageService {
  if (!config.storage) throw new Error('storage 服务不可用，文件工具已进入安全停用状态');
  return config.storage;
}

async function readText(storage: StorageService, uri: string): Promise<string> {
  const data = await storage.readFile(uri, 'utf-8');
  return typeof data === 'string' ? data : data.toString('utf-8');
}

function jsonError(err: unknown): string {
  return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
}

/**
 * 是否「文件不存在」错误。
 *
 * 只有这一类才允许被当成「新建」；权限、瞬时 IO 等其余错误必须原样上报——
 * 把它们也当成「不存在」会让读—改—写把原文静默截断成只剩新增部分。
 * storage 后端不保证透传 errno，故 code 与消息两条都认。
 */
function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') return true;
  return /ENOENT|不存在|not found/i.test(err instanceof Error ? err.message : String(err));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按 storage URI 的串行闸。
 *
 * agent 同一轮把所有 tool call 丢进 Promise.all 并行跑，而 file_edit / file_append 是
 * 「读—改—写」：两次改同一文件会各读到同一份原文、后写者盖掉前写者，两边都回「成功」。
 * 所有改动类工具（edit/append/write/move/delete）都经此闸，同一 URI 排队执行。
 * 多键（move 的两端）按字典序依次获取，避免两个交叉 move 互等。
 */
const fileLocks = new Map<string, Promise<void>>();

function withFileLock<T>(uris: readonly string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(uris)].sort();
  const acquire = (i: number): Promise<T> => {
    if (i >= keys.length) return fn();
    const key = keys[i];
    const prev = fileLocks.get(key) ?? Promise.resolve();
    const run = prev.then(() => acquire(i + 1));
    // tail 吞掉失败：前一个出错也要放行后来者；只有队尾自己跑完才清键，避免 Map 无界增长
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    fileLocks.set(key, tail);
    void tail.then(() => {
      if (fileLocks.get(key) === tail) fileLocks.delete(key);
    });
    return run;
  };
  return acquire(0);
}

/** 正则体检上限：正常搜索模式远够用，又挡住靠长度/量词堆叠爆开的写法 */
const MAX_SEARCH_PATTERN_LENGTH = 500;
const MAX_SEARCH_QUANTIFIERS = 20;
/** 无界量词（`+` `*` `{n,}`）单独限得更紧：`a+a+a+a+a+a+b` 这类堆叠不必嵌套就能指数级回溯 */
const MAX_SEARCH_UNBOUNDED_QUANTIFIERS = 5;

/**
 * 读 i 处的量词（含惰性后缀）。两个维度刻意分开：
 * - repeating：会把作用对象重复多次（`*` `+` `{n,}` `{n}` `{n,m}`），外层量词的嵌套判据看它，
 *   有上限的 `{n}` 一并按重复看待（`(a+){50}` 同样爆）；`?` 不重复。
 * - unbounded：重复次数没有上限（`*` `+` `{n,}`），堆叠计数与分组内部的危险标记都看它。
 */
function readQuantifier(
  pattern: string,
  i: number,
): { length: number; repeating: boolean; unbounded: boolean } | undefined {
  const ch = pattern[i];
  let length: number;
  let repeating: boolean;
  let unbounded: boolean;
  if (ch === '*' || ch === '+') {
    length = 1;
    repeating = true;
    unbounded = true;
  } else if (ch === '?') {
    length = 1;
    repeating = false;
    unbounded = false;
  } else if (ch === '{') {
    const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
    if (!m) return undefined; // 字面量 `{`
    length = m[0].length;
    repeating = true;
    unbounded = m[1] === ','; // `{n,}` 无上限；`{n}` / `{n,m}` 有上限
  } else {
    return undefined;
  }
  if (pattern[i + length] === '?') length++; // 惰性量词照样会回溯
  return { length, repeating, unbounded };
}

/** `(` 之后需跳过的分组前缀长度：`?:` / `?=` / `?!` / `?<=` / `?<!` / `?<name>` */
function groupPrefixLength(pattern: string, i: number): number {
  if (pattern[i + 1] !== '?') return 0;
  const n = pattern[i + 2];
  if (n === ':' || n === '=' || n === '!') return 2;
  if (n === '<') {
    if (pattern[i + 3] === '=' || pattern[i + 3] === '!') return 3;
    const close = pattern.indexOf('>', i + 3);
    return close < 0 ? 1 : close - i;
  }
  return 1;
}

/**
 * 正则模式体检：拦下已知的几类灾难性写法，**不是完备保证**。
 *
 * V8 正则同步执行、超时与 abort 都打不断，LLM 给的 `(a+)+$` 这类嵌套量词每多两个字符
 * 耗时翻数倍，n=30 已能把整进程冻死。故编译前拒掉这几类：
 * - 嵌套量词：重复量词（含 `{n}` / `{n,m}`）作用在「内部含无界量词或分支」的分组上（`(a+)+`、`((a+)a)+`）；
 *   内部全有界的嵌套（`(?:[0-9]{1,3}\.){3}`、`(\d{2}:){3}`）重复次数封顶为常数，照常放行
 * - 含量词的分支重复（`(a+|b)*`）
 * - 无界量词堆叠（多于 {@link MAX_SEARCH_UNBOUNDED_QUANTIFIERS} 个 `+` `*` `{n,}`）
 * - 模式过长、量词总数过多（`a?a?a?…x` 这类堆叠同样能爆）
 *
 * 判据是语法形状而非真实回溯代价，故两头都不精确：放行的模式里仍可能有慢写法，
 * 被拒的模式里也有无害的。取舍是被拒只需模型换个模式重试，冻死进程则不可恢复。
 * 字面量、字符类、单层量词、锚点、未加量词的分组/分支等常见写法照常放行；
 * 无内层量词的分支重复（如 `(?:foo|bar)+`）一并拒掉——分支是否重叠无法便宜判定。
 * 需要纯文本语义时传 `isRegex:false`，模式整体按字面量处理，不过体检。
 */
function assertSafeSearchPattern(pattern: string): void {
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    throw new Error(
      `正则模式过长（${pattern.length} > ${MAX_SEARCH_PATTERN_LENGTH} 字符）。请缩短模式，或用 isRegex:false 做纯文本搜索。`,
    );
  }
  // 每层分组记「内部是否含无界量词或分支」——只有这种内部配上外层重复量词才会指数级回溯；
  // 闭合后紧跟重复量词即拒，内部全有界的嵌套（`(?:[0-9]{1,3}\.){3}`）重复次数封顶为常数，放行
  const groups: boolean[] = [];
  let quantifiers = 0;
  let unbounded = 0;
  let inClass = false;
  let closedGroupInner = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    let justClosed = false;
    if (ch === '\\') {
      i++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === '(') {
      groups.push(false);
      i += groupPrefixLength(pattern, i);
    } else if (ch === ')') {
      justClosed = groups.pop() ?? false;
      // 子分组带标记时并给父层：否则 `((a+)a)+` 这类隔了一层的嵌套量词会漏检
      if (justClosed && groups.length) groups[groups.length - 1] = true;
    } else if (ch === '|') {
      if (groups.length) groups[groups.length - 1] = true;
    } else {
      const q = readQuantifier(pattern, i);
      if (q) {
        if (++quantifiers > MAX_SEARCH_QUANTIFIERS) {
          throw new Error(
            `正则模式量词过多（> ${MAX_SEARCH_QUANTIFIERS} 个），堆叠量词会触发指数级回溯。请简化模式，或用 isRegex:false 做纯文本搜索。`,
          );
        }
        if (q.unbounded && ++unbounded > MAX_SEARCH_UNBOUNDED_QUANTIFIERS) {
          throw new Error(
            `正则模式的无界量词过多（> ${MAX_SEARCH_UNBOUNDED_QUANTIFIERS} 个 \`+\` \`*\` \`{n,}\`），` +
              '堆叠无界量词会触发指数级回溯。请简化模式，或用 isRegex:false 做纯文本搜索。',
          );
        }
        if (closedGroupInner && q.repeating) {
          throw new Error(
            '正则模式含嵌套量词或分支重复（如 `(a+)+`、`(?:a|b)*`），会触发灾难性回溯把整个进程同步冻死，已拒绝编译。' +
              '请改用不含嵌套量词的模式，或用 isRegex:false 做纯文本搜索。',
          );
        }
        // 只有无界量词才把所在分组标危险：有界量词（`{n}` / `{n,m}`）撑不出指数级回溯
        if (q.unbounded && groups.length) groups[groups.length - 1] = true;
        i += q.length - 1;
      }
    }
    closedGroupInner = justClosed;
  }
}

async function searchTextStream(
  storage: StorageService,
  uri: string,
  regex: RegExp,
  startLine: number,
  maxResults: number,
  maxSearchBytes: number,
): Promise<{
  matches: Array<{ line: number; content: string }>;
  scannedBytes: number;
  scannedLines: number;
  truncated: boolean;
  nextStartLine?: number;
}> {
  const { stream } = await storage.createReadStream(uri);
  const matches: Array<{ line: number; content: string }> = [];
  let lineNumber = 0;
  let scannedBytes = 0;
  let scannedLines = 0;
  let truncated = false;

  try {
    for await (const { text: line } of iterLines(stream, maxSearchBytes)) {
      lineNumber++;
      if (lineNumber < startLine) continue;

      scannedLines++;
      scannedBytes += Buffer.byteLength(line, 'utf-8') + 1;
      if (regex.test(line)) matches.push({ line: lineNumber, content: line });

      if (matches.length >= maxResults || scannedBytes >= maxSearchBytes) {
        truncated = true;
        stream.destroy();
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  return {
    matches,
    scannedBytes,
    scannedLines,
    truncated,
    ...(truncated ? { nextStartLine: lineNumber + 1 } : {}),
  };
}

/** 把 startLine/endLine 参数解析成行区间；两者都没给（或都不是正数）返回 undefined。 */
function resolveLineRange(startArg: unknown, endArg: unknown): { start: number; end: number } | undefined {
  const startNum = Math.floor(Number(startArg));
  const endNum = Math.floor(Number(endArg));
  const hasStart = Number.isFinite(startNum) && startNum > 0;
  const hasEnd = Number.isFinite(endNum) && endNum > 0;
  if (!hasStart && !hasEnd) return undefined;
  const start = hasStart ? startNum : 1;
  return { start, end: hasEnd ? Math.max(start, endNum) : Number.MAX_SAFE_INTEGER };
}

/**
 * 按行范围流式读取（与 searchTextStream 同一套 createReadStream + readline 模式）。
 *
 * - 只把 [start, end] 区间的行收进内存，maxBytes 是**返回内容**的上限（不是扫描上限，
 *   否则深处的行范围永远读不到）
 * - 区间读完后只在扫描预算内继续数总行数：小文件能给出准确 totalLines，
 *   大文件则省掉整篇扫描、不返回 totalLines
 */
/**
 * 按行读取，且**单行自带字节上限**。
 *
 * 不用 node:readline：它在见到 \n 之前会把整条行累积成一个 JS 字符串，于是无换行的大文件
 * （单行 JSON、压缩产物）被整体物化——预算判定发生在行已成型之后，maxReadSize /
 * maxSearchBytes 形同虚设。更糟的是超过 V8 单字符串上限时抛的 RangeError 从
 * ReadStream.emit('data') 栈上同步抛出，for-await 的 try/catch 接不住，会一路逃到
 * runtime 的 uncaughtException 处理器把整个进程打掉（实测 640MB 无换行输入即触发）。
 *
 * 这里直接消费 Buffer 分块按 \n 切行：单行累计超过 maxLineBytes 时产出截断前缀并标记
 * cut，随后丢弃直到下一个换行，峰值内存因此有界。`\r\n` 与 readline 的
 * `crlfDelay: Infinity` 同义——按一个换行处理。
 */
async function* iterLines(
  stream: NodeJS.ReadableStream,
  maxLineBytes: number,
): AsyncGenerator<{ text: string; cut: boolean }> {
  const cap = Math.max(1, maxLineBytes);
  let pending: Buffer[] = [];
  let pendingLen = 0;
  /** 当前行已超上限：余下部分整段丢弃，直到下一个换行 */
  let dropping = false;

  const decode = (raw: Buffer): string => {
    const end = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.length - 1 : raw.length;
    return raw.subarray(0, end).toString('utf-8');
  };

  try {
    for await (const chunk of stream) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      while (buf.length > 0) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) {
          if (dropping) break;
          pending.push(buf);
          pendingLen += buf.length;
          if (pendingLen > cap) {
            yield { text: Buffer.concat(pending).subarray(0, cap).toString('utf-8'), cut: true };
            pending = [];
            pendingLen = 0;
            dropping = true;
          }
          break;
        }
        const head = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        if (dropping) {
          dropping = false;
          continue;
        }
        pending.push(head);
        pendingLen += head.length;
        const whole = Buffer.concat(pending);
        yield pendingLen > cap
          ? { text: whole.subarray(0, cap).toString('utf-8'), cut: true }
          : { text: decode(whole), cut: false };
        pending = [];
        pendingLen = 0;
      }
    }
    if (!dropping && pendingLen > 0) {
      const whole = Buffer.concat(pending);
      yield pendingLen > cap
        ? { text: whole.subarray(0, cap).toString('utf-8'), cut: true }
        : { text: decode(whole), cut: false };
    }
  } finally {
    // 提前 break 时主动断流，否则底层 fd 悬着
    (stream as { destroy?: () => void }).destroy?.();
  }
}

async function readLineRange(
  storage: StorageService,
  uri: string,
  start: number,
  end: number,
  maxBytes: number,
): Promise<{ lines: string[]; totalLines?: number; truncated: boolean; firstLineCut: boolean }> {
  const { stream } = await storage.createReadStream(uri);
  const lines: string[] = [];
  let lineNumber = 0;
  let scannedBytes = 0;
  let collectedBytes = 0;
  let truncated = false;
  let firstLineCut = false;
  let stopped = false;

  try {
    for await (const { text: line } of iterLines(stream, maxBytes)) {
      lineNumber++;
      const size = Buffer.byteLength(line, 'utf-8') + 1;
      scannedBytes += size;
      if (lineNumber >= start && lineNumber <= end) {
        collectedBytes += size;
        if (collectedBytes > maxBytes) {
          // 区间首行自身就超预算（单行压缩 js / 超长日志行）：按字节截断放进去，
          // 否则返回空内容再建议「缩小行范围」，模型无路可走
          if (lines.length === 0) {
            lines.push(Buffer.from(line, 'utf-8').subarray(0, maxBytes).toString('utf-8'));
            firstLineCut = true;
          }
          truncated = true;
          stopped = true;
          break;
        }
        lines.push(line);
      } else if (lineNumber > end && scannedBytes > maxBytes) {
        stopped = true;
        break;
      }
    }
  } finally {
    stream.destroy();
  }

  // 循环自然跑完 = 读到了文件末尾，此时行号即总行数
  return { lines, truncated, firstLineCut, ...(stopped ? {} : { totalLines: lineNumber }) };
}

/**
 * 在原文里定位 oldText，行尾感知：先按原样找，再试 CRLF 写法、LF 写法（去重后逐个尝试）。
 * 返回命中次数、首个命中的位置与长度，以及该处该按哪种行尾写入 newText：
 * 多行匹配看命中文本自己的行尾；单行匹配看命中处所在行的行尾。
 */
function locateEdit(raw: string, oldText: string): { count: number; index: number; length: number; crlf: boolean } {
  const lf = oldText.replace(/\r\n/g, '\n');
  for (const text of new Set([oldText, lf.replace(/\n/g, '\r\n'), lf])) {
    const index = raw.indexOf(text);
    if (index === -1) continue;
    const count = raw.split(text).length - 1;
    let crlf: boolean;
    if (text.includes('\n')) {
      crlf = text.includes('\r\n');
    } else {
      const after = raw.indexOf('\n', index + text.length);
      const probe = after !== -1 ? after : raw.lastIndexOf('\n', index);
      crlf = probe > 0 && raw[probe - 1] === '\r';
    }
    return { count, index, length: text.length, crlf };
  }
  return { count: 0, index: -1, length: 0, crlf: false };
}

/**
 * 默认排除目录：扫描树时几乎从不需要进入的"噪声目录"。
 *
 * 设计动机：file_search/file_tree 走的是字典序深度优先 walk，扫到第一个含
 * node_modules 的子目录就可能把 maxSearchBytes 预算耗光，导致 `truncated: true`
 * 而真正想找的源码一行都没扫到。把这些目录默认排除是工业标准（VS Code grep、
 * ripgrep、ag 等都默认排除）。用户传 `exclude: []` 可关闭全部默认。
 */
const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.venv/**',
  '**/__pycache__/**',
];

/**
 * 路径级 glob，编译成按 `/` 切好的段数组。
 *
 * - `**` 匹配任意多段（含零段），故 `**` + `/node_modules/**` 同时匹配
 *   `node_modules/x` 与 `a/b/node_modules/x`
 * - `*` 单段内任意字符（不跨 `/`）
 * - `?` 单段内一个字符（不跨 `/`）
 *
 * 匹配的是相对扫描根的路径。
 */
type CompiledGlob = readonly string[];

export function compileGlob(pattern: string): CompiledGlob {
  return pattern.split('/');
}

/**
 * 段级双指针：`**` 记回溯点吃任意多段，其余段交给 `matchGlob`（段内同样无回溯）。
 *
 * **不编译成正则**：`*` 译成 `[^/]*` 后，在无斜杠的单段路径上退化为 `.*`，与 `matchGlob`
 * 同源的灾难性回溯——`*?*?…` 这类 pattern 数十字符即可耗时数秒，而 V8 正则同步执行、
 * 超时打不断。exclude / include 由调用方给定且对每个 entry 各调一次，不能留这个面。
 */
export function matchGlobPath(relPath: string, segs: CompiledGlob): boolean {
  const parts = relPath.split('/');
  let si = 0;
  let pi = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < parts.length) {
    if (pi < segs.length && segs[pi] === '**') {
      starPi = pi++;
      starSi = si;
    } else if (pi < segs.length && matchGlob(parts[si], segs[pi])) {
      si++;
      pi++;
    } else if (starPi >= 0) {
      pi = starPi + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (pi < segs.length && segs[pi] === '**') pi++;
  return pi === segs.length;
}

function matchAnyGlob(relPath: string, patterns: readonly CompiledGlob[]): boolean {
  for (const g of patterns) if (matchGlobPath(relPath, g)) return true;
  return false;
}

function resolveExcludePatterns(arg: unknown): CompiledGlob[] {
  if (arg === undefined || arg === null) return DEFAULT_EXCLUDE_PATTERNS.map(compileGlob);
  if (!Array.isArray(arg)) return DEFAULT_EXCLUDE_PATTERNS.map(compileGlob);
  // 显式传空数组 → 关闭全部默认；其它情况只用用户值
  return (arg as unknown[]).filter((x): x is string => typeof x === 'string').map(compileGlob);
}

function resolveIncludePatterns(arg: unknown): CompiledGlob[] | undefined {
  if (!Array.isArray(arg)) return undefined;
  const list = (arg as unknown[]).filter((x): x is string => typeof x === 'string');
  return list.length ? list.map(compileGlob) : undefined;
}

/** 从 storage URI 提取相对扫描根的 path（不含协议头与根名） */
function relPathFromRoot(rootUri: string, childUri: string): string {
  // rootUri 形如 "workspace:/packages"，childUri 形如 "workspace:/packages/core/src/foo.ts"
  if (!childUri.startsWith(rootUri)) return childUri;
  let rel = childUri.slice(rootUri.length);
  if (rel.startsWith('/')) rel = rel.slice(1);
  return rel;
}

/**
 * 递归收集目录下所有非隐藏的文件 URI（深度优先、字典序稳定）。
 *
 * 用于 file_search 在目录上的批量搜索。失败的子目录会被跳过而不抛出。
 *
 * 关键：**目录级 exclude 在 walk 时早停**，命中的目录及其子树根本不进入，
 * 这才是避免 maxSearchBytes 预算被 node_modules 等噪声目录耗尽的根本手段。
 * 同时对文件维度也应用 exclude/include 做最终过滤。
 */
async function collectFiles(
  storage: StorageService,
  rootUri: string,
  exclude: readonly CompiledGlob[],
  include: readonly CompiledGlob[] | undefined,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(uri: string): Promise<void> {
    const result = await storage.list(uri).catch(() => null);
    if (!result) return;
    const entries = [...result.entries]
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const entry of entries) {
      const rel = relPathFromRoot(rootUri, entry.uri);
      if (entry.isDirectory) {
        if (matchAnyGlob(rel, exclude)) continue;
        await walk(entry.uri);
      } else {
        if (matchAnyGlob(rel, exclude)) continue;
        if (include && !matchAnyGlob(rel, include)) continue;
        out.push(entry.uri);
      }
    }
  }
  await walk(rootUri);
  return out;
}

export function registerFileTools(tools: BoundTools, config: FileConfig): void {
  // ==================== file_read ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_read',
        description:
          '读取受控存储中的文件。路径使用完整 storage URI（如 aalis:/packages/core/index.ts），或相对当前 cwd 的路径。' +
          '不允许读取宿主绝对路径。给定 startLine/endLine 时按行流式读取，超过大小限制的文件也可按行范围读取部分内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
            startLine: { type: 'number', description: '起始行号（从 1 开始，可选）' },
            endLine: { type: 'number', description: '结束行号（包含，可选）' },
            encoding: { type: 'string', description: '编码方式（可选，默认 utf-8；base64 读取二进制）' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        if (info.isDirectory) return JSON.stringify({ error: '路径是一个目录，请使用 file_list' });
        const encoding = args.encoding as string | undefined;
        const range = resolveLineRange(args.startLine, args.endLine);

        // 给了行范围就按行流式读：真正进内存的只有该区间，故不受整篇 maxReadSize 闸限制。
        // （闸若前置且不看行范围，模型照提示补上 startLine/endLine 后仍撞同一个错，无路可走。）
        if (range && encoding !== 'base64') {
          const result = await readLineRange(storage, uri, range.start, range.end, config.maxReadSize);
          return JSON.stringify({
            uri,
            ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
            startLine: range.start,
            endLine: range.start + result.lines.length - 1,
            content: result.lines.map((line, i) => `${range.start + i}\t${line}`).join('\n'),
            ...(result.truncated
              ? {
                  truncated: true,
                  advice: result.firstLineCut
                    ? `第 ${range.start} 行本身超过 ${config.maxReadSize} 字节上限，已按字节截断；该行其余内容请用 file_search 或 exec 处理。`
                    : `本次返回已达 ${config.maxReadSize} 字节上限，请缩小行范围继续读取。`,
                }
              : {}),
          });
        }

        if (info.size > config.maxReadSize) {
          return JSON.stringify({
            error: `文件过大 (${info.size} 字节)，超过限制 ${config.maxReadSize} 字节。${
              encoding === 'base64'
                ? 'base64 读取不支持行范围，请改用其它方式获取该文件。'
                : '请使用 startLine/endLine 参数读取部分内容。'
            }`,
            size: info.size,
            uri,
          });
        }

        if (encoding === 'base64') {
          const buffer = await storage.readFile(uri);
          const content = Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
          return JSON.stringify({ uri, encoding: 'base64', size: info.size, content });
        }

        // 与 readLineRange（readline）同口径：\n / \r\n 都算换行、行内容不带 \r，结尾换行不算多一行
        const lines = (await readText(storage, uri)).split(/\r?\n/);
        if (lines[lines.length - 1] === '') lines.pop();
        return JSON.stringify({
          uri,
          totalLines: lines.length,
          startLine: 1,
          endLine: lines.length,
          content: lines.map((line, i) => `${i + 1}\t${line}`).join('\n'),
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_write ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_write',
        description: '在受控存储中创建或覆盖文件。危险操作：会完全覆盖已有文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    // 写文件是 confused-deputy 向量（注入诱导覆盖/落恶意文件）→ owner 也需确认（本会话记住）
    confirm: 'session',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const content = args.content as string;
        if (Buffer.byteLength(content, 'utf-8') > config.maxWriteSize) {
          return JSON.stringify({ error: `内容过大，超过限制 ${config.maxWriteSize} 字节` });
        }
        return await withFileLock([uri], async () => {
          await storage.writeFile(uri, content);
          const info = await storage.stat(uri);
          return JSON.stringify({ uri, size: info.size, message: '文件写入成功' });
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_move ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_move',
        description:
          '移动或重命名受控存储中的文件/目录。from 与 to 都用 storage URI（如 workspace:/a.txt → workspace:/小说/a.txt），' +
          '或相对当前 cwd 的路径。自动创建目标父目录；目标已存在则拒绝（不覆盖）。底层原子 rename，大文件也瞬间完成。' +
          '不允许宿主机绝对路径、不能跨存储根——整理/归档文件请用本工具，勿用 shell mv（shell 不认 storage URI）。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源 storage URI 或相对 cwd 的路径' },
            to: { type: 'string', description: '目标 storage URI 或相对 cwd 的路径（含新文件名）' },
          },
          required: ['from', 'to'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    // 移动是 confused-deputy 向量（注入诱导挪走/覆盖文件）→ owner 也需确认（本会话记住），与 file_write 一致
    confirm: 'session',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const fromUri = toStorageUri(args.from as string, config, callCtx.sessionId);
        const toUri = toStorageUri(args.to as string, config, callCtx.sessionId);
        // 与其余 file_* 工具同门槛：两端都必须落在 allowedRoots 内（审计抓的漏配——
        // 少这道闸时 data:/users.json 可被 move 挪走，对 authority 等价于删除）
        ensureRootAllowed(fromUri, config);
        ensureRootAllowed(toUri, config);
        return await withFileLock([fromUri, toUri], async () => {
          const result = await storage.move(fromUri, toUri);
          return JSON.stringify({ from: fromUri, to: result, message: '移动成功' });
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_mkdir ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_mkdir',
        description:
          '在受控存储中创建目录（递归，自动建所有缺失的父目录；已存在则无操作）。' +
          'path 用 storage URI（如 workspace:/小说/淫魔女（原版）），或相对当前 cwd 的路径。' +
          '不允许宿主机绝对路径。整理/归档需要建目录时用本工具，勿用 shell mkdir（shell 不认 storage URI，会造出字面目录）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的目录路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    // 建目录约束在存储根内、不覆盖不注入内容，风险低于写/移动；restricted 挡住 level-0 即可，不弹确认。
    visibility: 'restricted',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const result = await storage.mkdir(uri);
        return JSON.stringify({ uri: result, message: '目录已创建' });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_edit ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_edit',
        description:
          '通过唯一精确字符串替换编辑受控存储中的文件。危险操作：会修改文件内容。' +
          '匹配时容忍 CRLF/LF 差异，并按命中处的行尾写入 newText；只改动命中的那一段，其它内容原样保留。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
            oldText: { type: 'string', description: '要被替换的原始文本（必须唯一精确匹配）' },
            newText: { type: 'string', description: '替换后的新文本' },
          },
          required: ['path', 'oldText', 'newText'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    confirm: 'session',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const oldText = args.oldText as string;
        const newText = args.newText as string;
        if (!oldText) return JSON.stringify({ error: 'oldText 不能为空' });

        // 读—改—写全程持 URI 串行闸：并行的同文件编辑不再各读同一份原文、互相盖掉
        return await withFileLock([uri], async () => {
          const raw = await readText(storage, uri);
          // 行尾感知定位：只替换命中的那一段，编辑处之外的字节（含混合行尾、孤 \r）原样保留
          const hit = locateEdit(raw, oldText);
          if (hit.count === 0) {
            return JSON.stringify({ error: '在文件中未找到 oldText。请确保文本精确匹配（包括空格和缩进）。' });
          }
          if (hit.count > 1) {
            return JSON.stringify({
              error: 'oldText 在文件中有多处匹配。请提供更多上下文以确保唯一匹配。',
              matchCount: hit.count,
            });
          }
          const insert = hit.crlf ? newText.replace(/\r?\n/g, '\r\n') : newText.replace(/\r\n/g, '\n');
          // 用 slice 拼接而非 String.replace：后者把 newText 当替换模式，
          // 其中的 $$ / $& / $` / $' 会被展开成别的内容，改坏文件。
          const newContent = raw.slice(0, hit.index) + insert + raw.slice(hit.index + hit.length);
          if (Buffer.byteLength(newContent, 'utf-8') > config.maxWriteSize) {
            return JSON.stringify({ error: `编辑后内容过大，超过限制 ${config.maxWriteSize} 字节` });
          }
          await storage.writeFile(uri, newContent);

          // 行号按命中位置直接算：indexOf(newText) 在 newText 于前文出现过时会偏小
          return JSON.stringify({
            uri,
            message: '编辑成功',
            editedLines: {
              start: raw.slice(0, hit.index).split(/\r?\n/).length,
              count: insert.split(/\r?\n/).length,
            },
          });
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_append ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_append',
        description: '向受控存储中的文件末尾追加内容。危险操作：会修改文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件路径' },
            content: { type: 'string', description: '要追加的内容' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    confirm: 'session',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const appendContent = args.content as string;
        // 读—改—写全程持 URI 串行闸，理由同 file_edit
        return await withFileLock([uri], async () => {
          // 读原文失败不能吞成空串——整篇写回等于把原文静默截断成只剩新增部分。
          // 只有 not-found 才走「创建」；读原文的其余错误（权限/瞬时 IO）一律原样上报，
          // 宁可这次追加失败，也不拿空串当原文。
          let existing: string;
          try {
            existing = await readText(storage, uri);
          } catch (err) {
            if (!isNotFoundError(err)) return jsonError(err);
            existing = '';
          }
          const content = existing + appendContent;
          if (Buffer.byteLength(content, 'utf-8') > config.maxWriteSize) {
            return JSON.stringify({ error: `追加后内容过大，超过限制 ${config.maxWriteSize} 字节` });
          }
          await storage.writeFile(uri, content);
          const info = await storage.stat(uri);
          return JSON.stringify({ uri, size: info.size, message: '内容追加成功' });
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_delete ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_delete',
        description: '删除受控存储中的文件或目录。危险操作：目录会递归删除。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的文件/目录路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    visibility: 'restricted',
    // 删文件不可逆 → owner 也需确认（本会话记住）
    confirm: 'session',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        return await withFileLock([uri], async () => {
          await storage.delete(uri);
          return JSON.stringify({ uri, message: '删除成功' });
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_list ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_list',
        description:
          '列出受控存储目录中的文件和子目录，支持关键词过滤、类型过滤与分页。' +
          '不传 path 默认列出当前 cwd；要查看有哪些 storage 根，调 cwd 工具获得完整根清单。' +
          '翻页：下次调用传 offset = 上次 offset + limit，直到 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '目录 storage URI（<根名>:/<路径>）或相对当前 cwd 的路径；不传则列当前 cwd',
            },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            keyword: { type: 'string', description: '按名称子串模糊匹配（不区分大小写）' },
            type: { type: 'string', enum: ['file', 'directory'], description: '只返回指定类型' },
            limit: { type: 'number', description: '本页最多返回条数，默认 50' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri((args.path as string | undefined) || undefined, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const result = await storage.list(uri);
        const showHidden = (args.showHidden as boolean) ?? false;
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
        const typeFilter = typeof args.type === 'string' ? args.type : '';
        const filtered = result.entries.filter(entry => {
          if (!showHidden && entry.name.startsWith('.')) return false;
          if (typeFilter === 'file' && entry.isDirectory) return false;
          if (typeFilter === 'directory' && !entry.isDirectory) return false;
          if (keyword && !entry.name.toLowerCase().includes(keyword)) return false;
          return true;
        });
        const limit = Math.max(1, Math.floor(Number(args.limit) || 50));
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
        const pageItems = filtered.slice(offset, offset + limit).map(entry => ({
          name: entry.name,
          uri: entry.uri,
          path: entry.path,
          type: entry.isDirectory ? 'directory' : 'file',
          size: entry.isDirectory ? undefined : entry.size,
          modified: entry.mtime,
        }));

        return JSON.stringify({
          uri,
          root: result.root.name,
          path: result.path,
          total: result.entries.length,
          matched: filtered.length,
          limit,
          offset,
          returned: pageItems.length,
          has_more: offset + pageItems.length < filtered.length,
          ...(keyword ? { keyword } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
          entries: pageItems,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_info ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_info',
        description: '获取受控存储中文件或目录的元信息。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'storage URI 或相对当前 cwd 的路径' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        return JSON.stringify({
          uri,
          path: info.path,
          type: info.isDirectory ? 'directory' : 'file',
          size: info.size,
          created: info.birthtime,
          modified: info.mtime,
          extension: info.ext,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_search ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_search',
        description:
          '在受控存储中按行搜索匹配文本（内容搜索，非文件名搜索）。path 可为文件，也可为目录（目录将递归搜索所有文件并跨文件累计预算）。支持正则表达式和大小写控制。' +
          '目录搜索默认排除 node_modules / dist / build / .git / coverage / __pycache__ 等噪声目录；传 `exclude` 覆盖默认，或传 `exclude: []` 关闭全部默认。' +
          '结果被预算截断时（truncated: true）会给出 nextStartFile / nextStartLine：传同一个 path 加这两个值即从断点续搜。' +
          '如需按文件名/目录名查找，请使用 file_tree 的 pattern 参数。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要搜索的文件或目录的 storage URI 或相对当前 cwd 的路径' },
            pattern: { type: 'string', description: '搜索模式（纯文本或正则表达式）' },
            isRegex: {
              type: 'boolean',
              description:
                '模式是否为正则表达式（默认 false）。编译前过体检，拦下已知的几类灾难性写法（嵌套量词、含量词的分支重复、无界量词堆叠），不是完备保证；isRegex:false 走字面量。',
            },
            ignoreCase: { type: 'boolean', description: '是否忽略大小写（默认 true）' },
            startLine: {
              type: 'number',
              description:
                '从第几行开始搜索（默认 1，用于继续上次截断的搜索）。文件模式=文件内起始行；目录模式须与 startFile 同传，表示在 startFile 内的起始行。',
            },
            startFile: {
              type: 'string',
              description:
                '目录模式续搜：从这个文件开始扫（相对 path 的文件路径，取上次返回的 nextStartFile），排序在它之前的文件整体跳过。仅目录搜索生效。',
            },
            maxResults: { type: 'number', description: '最大返回结果数（默认 50，最多 200）' },
            maxSearchBytes: { type: 'number', description: `单次最多扫描字节数（默认/上限 ${config.maxSearchBytes}）` },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                '路径级 glob 排除模式（支持 ** / * / ?），仅目录搜索生效。例：["**/node_modules/**","**/dist/**"]。' +
                '不传 → 使用默认排除集；传 [] → 关闭默认全量搜索。',
            },
            include: {
              type: 'array',
              items: { type: 'string' },
              description: '路径级 glob 白名单，仅目录搜索生效。例：["**/*.ts","**/*.md"]。',
            },
          },
          required: ['path', 'pattern'],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const info = await storage.stat(uri);
        const pattern = args.pattern as string;
        const ignoreCase = (args.ignoreCase as boolean) ?? true;
        const maxResults = Math.min((args.maxResults as number) || 50, 200);
        const startLine = Math.max(1, Math.floor(Number(args.startLine) || 1));
        const maxSearchBytes = Math.min(
          Math.max(1024, Math.floor(Number(args.maxSearchBytes) || config.maxSearchBytes)),
          config.maxSearchBytes,
        );
        let regex: RegExp;
        if ((args.isRegex as boolean) ?? false) {
          // 模型给的正则先过体检：嵌套量词的回溯是同步的，超时与 abort 都打不断
          assertSafeSearchPattern(pattern);
          regex = new RegExp(pattern, ignoreCase ? 'i' : '');
        } else {
          regex = new RegExp(escapeRegExp(pattern), ignoreCase ? 'i' : '');
        }
        const excludeProvided = args.exclude !== undefined;
        const excludePatterns = resolveExcludePatterns(args.exclude);
        const includePatterns = resolveIncludePatterns(args.include);

        // 目录：递归收集所有文件并逐个搜索，预算（maxResults / maxSearchBytes）跨文件累加。
        //
        // 续搜协议（定死）：截断时返回 nextStartFile（相对本目录的文件路径）+ nextStartLine，
        // 下一次调用传同一个 path 加这两个值，就从断点原地接着扫——零重复、零遗漏。
        // 断点必落在停下的那个文件里（预算一旦耗尽，searchTextStream 即报 truncated 并带回
        // nextStartLine，循环当场停）：maxResults 耗尽=同文件最后一条命中行 +1；
        // maxSearchBytes 耗尽=同文件最后扫描行 +1。
        if (info.isDirectory) {
          const files = await collectFiles(storage, uri, excludePatterns, includePatterns);
          const startFile = typeof args.startFile === 'string' ? (args.startFile as string).trim() : '';
          // 遍历顺序由 collectFiles 定（深度优先、字典序、稳定），故「跳过 startFile 之前的文件」可复现
          const startIndex = startFile ? files.findIndex(f => relPathFromRoot(uri, f) === startFile) : 0;
          if (startIndex < 0) {
            return JSON.stringify({
              error:
                `startFile 在该目录下未找到：${startFile}。它须是相对 path 的文件路径（取上次返回的 nextStartFile）；` +
                '续搜须把 exclude / include 原样重传——文件集一变，断点文件可能已被排除在外。',
            });
          }
          const pending = files.slice(startIndex);
          const allMatches: Array<{ uri: string; line: number; content: string }> = [];
          let totalScannedBytes = 0;
          let totalScannedLines = 0;
          let scannedFiles = 0;
          /** 读不出来而被跳过的文件数（权限、枚举后被删…）：不计入命中也不该无声无息 */
          let skippedFiles = 0;
          let next: { file: string; line: number } | undefined;

          for (let idx = 0; idx < pending.length; idx++) {
            const fileUri = pending[idx];
            // 只有续搜的首个文件从 startLine 起；其余文件整篇扫
            const fileStartLine = idx === 0 && startFile ? startLine : 1;
            // 走到下一个文件必然是上个文件没耗尽预算（耗尽即 truncated 并 break），故跨文件时两者恒 > 0；
            // 首个文件的余量就是入参本身（maxResults 未钳下界，非法负数会让首文件扫一行即截断，与文件模式一致）
            const remainingResults = maxResults - allMatches.length;
            const remainingBytes = maxSearchBytes - totalScannedBytes;
            scannedFiles++;
            const r = await searchTextStream(
              storage,
              fileUri,
              regex,
              fileStartLine,
              remainingResults,
              remainingBytes,
            ).catch(() => null);
            if (!r) {
              // 此前静默 continue：该文件一行未扫，返回体却照常给 matchCount、truncated 仍为
              // false，模型拿着这个「非截断」的可信信号断言「不存在」。
              skippedFiles++;
              continue;
            }
            for (const m of r.matches) allMatches.push({ uri: fileUri, ...m });
            totalScannedBytes += r.scannedBytes;
            totalScannedLines += r.scannedLines;
            if (!r.truncated) continue;
            // 文件中途停下：断点落在同一文件。预算恰好在该文件最后一行用完时 nextStartLine
            // 会越过文件末尾，下次从这里续搜只多开一次空文件，不会重复也不会遗漏。
            next = { file: relPathFromRoot(uri, fileUri), line: r.nextStartLine ?? fileStartLine };
            break;
          }

          const budgetAdvice = next
            ? '搜索因预算（maxResults 或 maxSearchBytes）耗尽而中断。请采取以下任一行动再查：' +
              `(1) 继续请传 path=${uri}, startFile=${next.file}, startLine=${next.line}，` +
              '并把本次的 pattern / isRegex / ignoreCase / exclude / include 原样重传' +
              '（任一不同则断点失效：文件集或匹配规则一变，断点指向的位置就不再是同一个）；' +
              '(2) 用更精确的 path 缩小扫描范围；' +
              '(3) 传 exclude 缩小文件集（传了就替换默认集，默认集含 node_modules/dist/.git/build/coverage 等，要留着须一并列上）；' +
              '(4) 用 include 限定文件类型（如 ["**/*.ts","**/*.md"]）；' +
              '(5) 提高 maxResults / maxSearchBytes。' +
              '**不要根据本次结果断言"找不到"——它可能只是被预算截断了。**'
            : undefined;
          const skipAdvice =
            skippedFiles > 0
              ? `有 ${skippedFiles} 个文件未能读取（权限或读取错误）被跳过，其内容未参与匹配。` +
                '**不要根据本次结果断言"找不到"。**'
              : undefined;
          const advice = [budgetAdvice, skipAdvice].filter(Boolean).join(' ') || undefined;

          return JSON.stringify({
            uri,
            pattern,
            isDirectory: true,
            totalFiles: files.length,
            scannedFiles,
            ...(skippedFiles > 0 ? { skippedFiles } : {}),
            ...(startFile ? { startFile, startLine } : {}),
            matches: allMatches,
            matchCount: allMatches.length,
            scannedBytes: totalScannedBytes,
            scannedLines: totalScannedLines,
            truncated: next !== undefined,
            excludeApplied: excludeProvided ? '(user)' : '(default)',
            ...(next ? { nextStartFile: next.file, nextStartLine: next.line } : {}),
            ...(advice ? { advice } : {}),
          });
        }

        const result = await searchTextStream(storage, uri, regex, startLine, maxResults, maxSearchBytes);
        const advice = result.truncated
          ? '文件搜索因预算耗尽而中断。可提高 maxSearchBytes / maxResults，或用 nextStartLine 继续。' +
            '**不要据此断言"没有更多匹配"。**'
          : undefined;
        return JSON.stringify({
          uri,
          pattern,
          fileSize: info.size,
          startLine,
          maxSearchBytes,
          matches: result.matches,
          matchCount: result.matches.length,
          scannedBytes: result.scannedBytes,
          scannedLines: result.scannedLines,
          truncated: result.truncated,
          ...(result.nextStartLine ? { nextStartLine: result.nextStartLine } : {}),
          ...(advice ? { advice } : {}),
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });

  // ==================== file_tree ====================
  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'file_tree',
        description:
          '递归显示受控存储目录树。用于快速了解 workspace/tmp 等安全根的布局。配合 pattern 参数可筛选目录名和文件名（支持 glob: *.ts, *scheduler* 等）。' +
          '默认排除 node_modules / dist / build / .git / coverage 等噪声目录；传 `exclude` 覆盖默认，或传 `exclude: []` 关闭全部默认（如需查看 node_modules 时）。' +
          '注意：pattern 匹配的是文件/目录名，而非文件内容。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '根目录 storage URI 或相对当前 cwd 的路径；不传则以 cwd 为根' },
            maxDepth: { type: 'number', description: '最大递归深度（默认 3，最多 10）' },
            showHidden: { type: 'boolean', description: '是否显示隐藏文件（默认 false）' },
            pattern: {
              type: 'string',
              description: '文件与目录名过滤模式（简单 glob: *.ts, *scheduler* 等）。匹配的是文件/目录名，非文件内容。',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description:
                '路径级 glob 排除模式（支持 ** / * / ?）。例：["**/node_modules/**"]。' +
                '不传 → 使用默认排除集；传 [] → 关闭默认。',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），朋友档挡 level-0；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      try {
        const storage = requireStorage(config);
        const uri = toStorageUri(args.path as string | undefined, config, callCtx.sessionId);
        ensureRootAllowed(uri, config);
        const maxDepth = Math.min((args.maxDepth as number) || 3, 10);
        const showHidden = (args.showHidden as boolean) ?? false;
        const pattern = args.pattern as string | undefined;
        const excludePatterns = resolveExcludePatterns(args.exclude);
        const lines: string[] = [`${basename(uri) || `${parseUriRoot(uri)}:/`}`];
        let totalFiles = 0;
        let totalDirs = 0;
        let excluded = 0;

        async function walk(currentUri: string, prefix: string, depth: number): Promise<void> {
          if (depth > maxDepth) return;
          const result = await storage.list(currentUri).catch(() => null);
          if (!result) return;
          const entries = result.entries
            .filter(entry => showHidden || !entry.name.startsWith('.'))
            .filter(entry => {
              const rel = relPathFromRoot(uri, entry.uri);
              if (entry.isDirectory) {
                if (matchAnyGlob(rel, excludePatterns)) {
                  excluded++;
                  return false;
                }
                return true;
              }
              if (matchAnyGlob(rel, excludePatterns)) return false;
              return !pattern || matchGlob(entry.name, pattern);
            })
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const isLast = i === entries.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const childPrefix = prefix + (isLast ? '    ' : '│   ');
            if (entry.isDirectory) {
              totalDirs++;
              lines.push(`${prefix}${connector}${entry.name}/`);
              await walk(entry.uri, childPrefix, depth + 1);
            } else {
              totalFiles++;
              lines.push(`${prefix}${connector}${entry.name}`);
            }
          }
        }

        await walk(uri, '', 1);
        return JSON.stringify({
          uri,
          tree: lines.join('\n'),
          summary: `${totalDirs} 个目录，${totalFiles} 个文件${excluded ? `（已排除 ${excluded} 个噪声目录）` : ''}`,
          excludedDirs: excluded,
        });
      } catch (err) {
        return jsonError(err);
      }
    },
  });
}

/**
 * 单段文件名的 glob 匹配（`*` 任意串、`?` 单字符），大小写不敏感。
 *
 * **不走正则。** 把 glob 翻译成 `.*` / `.` 会引入灾难性回溯：`*?*?*?…*zz` 这类 pattern
 * 与文件名内容无关（`?` 匹配任意字符），几十字符即可让匹配耗时数十秒；而 V8 正则同步执行，
 * 事件循环被整段阻塞、任何超时都打不断，且 `file_tree` 对每个 entry 各调一次。
 *
 * 双指针通配匹配：遇 `*` 记回溯点继续，失配则退回上一个 `*` 让它多吃一个字符。
 * 最坏 O(name × pattern)，无回溯爆炸，也不需要拍脑袋的长度阈值。
 */
export function matchGlob(name: string, pattern: string): boolean {
  const s = name.toLowerCase();
  const p = pattern.toLowerCase();
  let si = 0;
  let pi = 0;
  let starPi = -1;
  let starSi = 0;
  while (si < s.length) {
    // **`*` 必须最先判**：文件名里也可能含 `*`，此时 `p[pi] === s[si]` 会成立，
    // 通配符被当字面量消耗掉、回溯点不记，后续失配就无处可退。
    if (pi < p.length && p[pi] === '*') {
      starPi = pi++;
      starSi = si;
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
      si++;
      pi++;
    } else if (starPi >= 0) {
      // 失配：退回最近的 `*`，让它多吃一个字符
      pi = starPi + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}
