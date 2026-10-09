// ============================================================
// 污点与来源账本：落在插件数据 pluginData:/reach/provenance.json
//
// 污点：每个会话读进过谁的内容（来源称呼），粘在会话上，之后签发的凭据都带着。
// 来源账本：受污染的会话经凭据写进白纸的文件（真实路径）→ 写入会话、来源称呼与时间。
// 整份原子写；改动之后排队写盘。文件不存在时从空起步；存在但读不出或形状不对时抛错，插件不激活：
// 从空起步等于当作谁都没读进过别人的内容，凭据会把受污染的会话当成干净的签发。
// ============================================================

import type { ProvenanceRecord } from '@aalis/api-reach';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

const URI = 'pluginData:/reach/provenance.json';

const isSources = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(s => typeof s === 'string' && s.trim() !== '');

const isRecord = (value: unknown): value is ProvenanceRecord => {
  const r = value as Partial<ProvenanceRecord> | null;
  return typeof r?.sessionId === 'string' && isSources(r.sources) && typeof r.at === 'number';
};

function parse(text: string): { taint: Map<string, readonly string[]>; ledger: Map<string, ProvenanceRecord> } {
  const doc = JSON.parse(text) as { taint?: unknown; ledger?: unknown } | null;
  const entries = (value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.entries(value) : undefined;
  const taint = entries(doc?.taint);
  const ledger = entries(doc?.ledger);
  if (!taint?.every(([, sources]) => isSources(sources))) throw new Error('taint 要是「会话 id → 来源称呼的数组」');
  if (!ledger?.every(([, record]) => isRecord(record))) {
    throw new Error('ledger 要是「真实路径 → { sessionId, sources, at }」');
  }
  return {
    taint: new Map(taint as Array<[string, string[]]>),
    ledger: new Map(ledger as Array<[string, ProvenanceRecord]>),
  };
}

export async function openProvenance(storage: StorageService, logger: Logger) {
  const text = await storage.readFile(URI, 'utf-8').then(
    data => String(data),
    err => {
      if (isStorageNotFound(err)) return undefined;
      throw err;
    },
  );
  let state: ReturnType<typeof parse>;
  try {
    state = text === undefined ? { taint: new Map(), ledger: new Map() } : parse(text);
  } catch (err) {
    throw new Error(
      `污点与来源记录 ${URI}（家目录的 state/plugins/reach/provenance.json）读不出：${err instanceof Error ? err.message : String(err)}。修好或移走后重启`,
    );
  }
  const { taint, ledger } = state;

  // 写盘排队：每次写当时的整份，失败上报，下一次改动照常再写整份
  let saving = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify({ taint: Object.fromEntries(taint), ledger: Object.fromEntries(ledger) });
    saving = saving
      .then(() => storage.writeFile(URI, snapshot))
      .catch(err => logger.error('污点与来源记录写盘失败（本次运行里照常生效）:', err));
  };

  return {
    taintOf: (sessionId: string): readonly string[] | undefined => taint.get(sessionId),
    markTainted(sessionId: string, sources: readonly string[]): void {
      if (!isSources(sources)) throw new Error('污点要带来源称呼：至少一个，且不能是空白');
      const merged = [...new Set([...(taint.get(sessionId) ?? []), ...sources])];
      if (merged.length === taint.get(sessionId)?.length) return;
      taint.set(sessionId, merged);
      save();
    },
    record(realPath: string, entry: ProvenanceRecord): void {
      ledger.set(realPath, entry);
      save();
    },
    provenanceOf: (realPath: string): ProvenanceRecord | undefined => ledger.get(realPath),
    /** 等排队的写盘落定 */
    flushed: () => saving,
  };
}
