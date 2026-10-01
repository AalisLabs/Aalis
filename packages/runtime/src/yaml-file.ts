import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  type FSWatcher,
  watch as fsWatch,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { ConfigSaveRefusedError } from '@aalis/api-host-config';
import type { Logger } from '@aalis/core';
import { parseDocument } from 'yaml';

// ============================================================
// yaml-file —— 家目录里的 YAML 文档文件：同步装载、写前比对、原子写、按目录监听
//
// 主配置 aalis.config.yaml 与密钥文件 secrets.yaml 共用。两者都可能含密钥：报错与日志只写位置，不写内容。
// ============================================================

interface YamlFileOptions<T> {
  /** 报错与日志里对文件的称呼，如「配置文件」「密钥文件」 */
  label: string;
  logger: Logger;
  serialize(value: T): string;
  /** 文件不存在时的初始值 */
  missing(): T;
  /**
   * 原子写的权限位。给定时临时文件一律以它创建，不沿用原文件的权限（密钥文件用 0o600）；
   * 不给时沿用原文件的权限位，没有原文件时用 0o600
   */
  mode?: number;
  /**
   * 运行中改成空文件（或只剩注释）时按 {@link missing} 的值投递。缺省拒收：主配置变空多是写坏了，
   * 放行会让全部插件按默认值重载；密钥文件清空是合法状态
   */
  emptyAsMissing?: boolean;
}

interface YamlFile<T> {
  /** 装载时读到的内容 */
  initial: T;
  /**
   * 原子写回。写前比对盘上内容：有尚未生效的外部修改时拒写，抛 {@link ConfigSaveRefusedError}（只带路径）
   */
  save(value: T): void;
  /**
   * 监听文件所在目录（按文件名过滤）+ 300ms 去抖，按与上次读入或写出的内容比对去重（自写回不触发）；
   * 拒写之后的下一次变更不去重；武装后立即对账一次。返回退订
   */
  watch(onChange: (next: T) => void): () => void;
}

/**
 * yaml 解析错误的可公开描述：只给错误码与行列。yaml 的报错 message 可能带原文（例如
 * `Unexpected ${token.source} in …`、block scalar 头部的多余字符），配置与密钥文件的原文可能就是密钥，
 * 随日志进 latest.log 与 WebUI 日志页就是泄漏。
 */
function describeYamlError(err: unknown): string {
  const e = err as { code?: unknown; linePos?: ReadonlyArray<{ line: number; col: number }> } | null;
  const code = typeof e?.code === 'string' ? e.code : '语法错误';
  const at = e?.linePos?.[0];
  return at ? `${code}（第 ${at.line} 行第 ${at.col} 列）` : code;
}

/**
 * 解析 YAML 文本：错误抛出，警告（例如把 `!xxx` 当成标签、值变成空）记一行错误码与行列。不用 yaml 的 parse()：
 * 它把警告连同原文经 process.emitWarning 打到 stderr
 */
function parseYamlText(text: string, label: string, logger: Logger): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw doc.errors[0];
  for (const warning of doc.warnings) logger.warn(`${label}有可疑写法：${describeYamlError(warning)}`);
  return doc.toJS();
}

/** 值必须是纯映射：裸标量、数组会被下游按 Object.entries 摊开写回垃圾 */
function describeNonMapping(v: unknown): string | null {
  if (v === null) return 'empty';
  if (Array.isArray(v)) return 'array';
  if (typeof v !== 'object') return typeof v;
  return null;
}

export function openYamlFile<T extends object>(absPath: string, opts: YamlFileOptions<T>): YamlFile<T> {
  const { label, logger } = opts;
  const dataDir = dirname(absPath);
  let raw: string | null = null;
  // 拒写之后调用方手里的文档（常连同运行态）已领先于文件：下一次文件变更不论内容是否等于 raw 都要投递，
  // 让宿主按文件重新对账。否则把文件原样改回的「修好」会被当成空变更跳过，文档与运行态从此偏离文件，
  // 下一次成功保存还会把被拒的改动写进去。
  let reconcilePending = false;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function load(): T {
    if (!existsSync(absPath)) {
      raw = null;
      return opts.missing();
    }
    raw = readFileSync(absPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = parseYamlText(raw, label, logger) ?? {};
    } catch (err) {
      // 启动时语法错误照样响亮拒启，消息里只有错误码与行列（崩溃日志同为暴露面）
      throw new Error(`${label}解析失败：${describeYamlError(err)}（${absPath}）`);
    }
    // 「解析成功但不是映射」同样上抛，不能放进下游摊开再写回磁盘。空文件视同空映射（?? {} 已兜）
    const kind = describeNonMapping(parsed);
    if (kind) throw new Error(`${label}不是一个映射（得到 ${kind}）：${absPath}`);
    return parsed as T;
  }

  const initial = load();

  return {
    initial,

    save(value) {
      // 写前比对磁盘实况：盘上内容必须仍是本进程最后读入或写出的那份。不是，就有尚未生效的外部修改
      // （去抖窗口内、监听未武装、解析失败被搁置、另一个进程写过），整份覆写会把它静默吃掉，所以拒写。
      // 文件不存在时没有可保护的内容，照写。
      let onDisk: string | null = null;
      try {
        onDisk = readFileSync(absPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (onDisk !== null && onDisk !== raw) {
        reconcilePending = true;
        throw new ConfigSaveRefusedError(`${label}有尚未生效的外部修改，为免覆盖已拒绝本次保存（${absPath}）`);
      }
      const text = opts.serialize(value);
      // 原子写：先写临时文件再 rename（同目录同分区，rename 原子覆盖）。直接 writeFileSync 是 O_CREAT|O_TRUNC，
      // 写中断（磁盘写满、进程被杀）时盘上留下 0 字节或半截 YAML，空文件还会被当成空文档放行。
      // watch() 守的是目录，rename 换 inode 不会打断监听。
      const tmp = `${absPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
      // 临时文件建出来就是收紧的权限：按默认 umask 建出再 chmod，其间或进程在 rename 前被杀时，目录里就有一份
      // 权限更宽的副本；rename 让目标继承 tmp 的权限
      let mode = opts.mode ?? 0o600;
      if (opts.mode === undefined) {
        try {
          mode = statSync(absPath).mode & 0o777;
        } catch {
          /* 原文件不存在或取不到权限：按 0o600 建 */
        }
      }
      try {
        writeFileSync(tmp, text, { encoding: 'utf-8', mode });
        // 建文件时的 mode 还会被 umask 收窄；对齐回目标权限位（不会宽于 mode 本身）
        try {
          chmodSync(tmp, mode);
        } catch {
          /* 对不齐就保持建出时更窄的权限，不拖累写入本身 */
        }
        renameSync(tmp, absPath);
      } catch (err) {
        // 临时文件是整份内容（可能含密钥），不能留在目录里
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* 删不掉也要把原始错误传出去 */
        }
        throw err;
      }
      raw = text;
      reconcilePending = false;
    },

    watch(onChange) {
      if (watcher) return () => {};
      // 守目录而非文件：文件可能尚未落盘，建出来时也要能接上
      if (!existsSync(dataDir)) return () => {};
      const fileName = basename(absPath);
      try {
        const schedule = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            // 读盘失败与解析失败分开：编辑器先删后建式保存的瞬时 ENOENT 不能报成「YAML 写错了」。
            // 读不到安静返回（下一个事件会来），解析失败才出声
            let current: string;
            try {
              current = readFileSync(absPath, 'utf-8');
            } catch {
              return;
            }
            // raw 在装载、save、本回调三处维护：一并挡掉自写回、目录里无关文件的杂音、touch 与改完又改回来的空变更。
            // 拒写之后的这一次除外（见 reconcilePending）
            if (current === raw && !reconcilePending) return;
            let parsed: unknown;
            try {
              parsed = parseYamlText(current, label, logger);
            } catch (err) {
              // raw 只在解析成功后推进：同一份坏内容每次保存都重新告警，直到改对为止
              logger.warn(`${label}解析失败，本次变更已忽略，仍在使用上一份内容：${describeYamlError(err)}`);
              return;
            }
            // 空文件、裸标量、数组：一道闸拒收，放行会让下游按空内容重载或写回垃圾
            if (parsed === null && opts.emptyAsMissing) parsed = opts.missing();
            const kind = describeNonMapping(parsed);
            if (kind) {
              logger.warn(`${label}不是一个映射（得到 ${kind}），本次变更已忽略`);
              return;
            }
            raw = current;
            reconcilePending = false;
            try {
              onChange(parsed as T);
            } catch (err) {
              logger.warn(`${label}变更处理器抛错：${err instanceof Error ? err.message : String(err)}`);
            }
          }, 300);
        };
        // 必须监听目录，不能监听文件本身：fs.watch 绑的是那一刻的 inode，编辑器保存与本模块的 save
        // 都是「写临时文件 → rename」，换了 inode 之后绑在旧 inode 上的 watcher 永不触发，也没有任何报错
        watcher = fsWatch(dataDir, (_event, filename) => {
          // filename 平台不保证非空；为空时不过滤，交给内容比对兜底
          if (filename && basename(filename.toString()) !== fileName) return;
          schedule();
        });
        // 武装即对账一次：武装前（启动期）的外部修改不会再有事件，不补就既不生效、又让 save 一直拒写
        schedule();
      } catch (err) {
        logger.warn(
          `无法监听${label}变更（${err instanceof Error ? err.message : String(err)}）：手动修改后需重启才生效，重启前的进程保存会被拒绝`,
        );
      }
      return () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        watcher?.close();
        watcher = null;
      };
    },
  };
}
