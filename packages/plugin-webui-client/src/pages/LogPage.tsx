import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useDeferredValue } from 'react';
import type { LogEntry } from '../types';

interface LogPageProps {
  logs: LogEntry[];
  /** 滚动到顶部时触发；实现方应通过 /api/logs/range 取更早的条目并前置。
   *  返回新加载的条目数（0 表示已无更早数据）。 */
  onLoadOlder?: () => Promise<number>;
}

const NEAR_BOTTOM_PX = 40;
const NEAR_TOP_PX = 40;

export function LogPage({ logs, onLoadOlder }: LogPageProps) {
  const [filter, setFilter] = useState<string | null>(null);
  // 关键词过滤：空格分隔=同时满足(AND)，`-词`=排除，大小写不敏感的子串匹配。
  // 刻意不用正则：子串匹配可预测、无 ReDoS 面、对 2000 行也是毫秒级。
  const [query, setQuery] = useState('');
  // 低优先级跟随输入：打字不被 2000 行过滤重渲染卡住
  const deferredQuery = useDeferredValue(query);
  // 展开态 = 模式开关 + 例外集合（以 seq 为 key，前置加载/裁剪不会错位）：
  // expandAll 关 → overrides 是"单行展开"集合；开 → overrides 是"单行收起"的例外。
  // 做成模式而非快照式全选：日志持续流入，快照会被新到达的折叠行立刻稀释。
  const [expandAll, setExpandAll] = useState(false);
  const [overrides, setOverrides] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  // 自动跟随底部：每次 scroll 事件根据真实位置重算，不持有过期 state
  const autoScrollRef = useRef(true);
  // 防并发加载更早历史
  const loadingOlderRef = useRef(false);
  // 加载更早历史后保留视口位置的锚点
  const preserveScrollRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  // 跟踪 logs 长度变化方向，区分"追加新条目"与"前置历史"
  const prevFirstSeqRef = useRef<number | null>(null);
  const prevLengthRef = useRef(0);

  const filteredLogs = useMemo(() => {
    let out = filter ? logs.filter(l => l.level === filter) : logs;
    const terms = deferredQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
      out = out.filter(l => {
        const hay = `${l.scope} ${l.message}`.toLowerCase();
        // 裸 '-' 当字面量搜；'-xxx' 为排除项
        return terms.every(t => (t.startsWith('-') && t.length > 1 ? !hay.includes(t.slice(1)) : hay.includes(t)));
      });
    }
    return out;
  }, [logs, filter, deferredQuery]);

  /**
   * 钉到底部。一次性赋值会漂移：折叠行的 contentVisibility 估算高度与真实行高有偏差，
   * 滚动后附近行materialize 触发浏览器滚动锚定回调整 scrollTop（实测停在中段）。
   * rAF 再补一拍，以最终布局为准；.log-list 同时设 overflow-anchor: none 关掉
   * 浏览器锚定，让本组件成为 scrollTop 的唯一写者。
   */
  const anchorToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      const el2 = listRef.current;
      if (el2 && autoScrollRef.current) el2.scrollTop = el2.scrollHeight;
    });
  }, []);

  // 可见列表变化后的滚动处理：先恢复"加载更早"留下的视口，再做"跟随底部"判定。
  // useLayoutEffect（绘制前）：大批量流入时 useEffect 在绘制后才钉底，
  // 会闪出一帧"底部在视口外"的画面（实测采样撞见过）。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // 1. 前置加载发生：保持用户视口在原内容上（避免视觉跳动）
    if (preserveScrollRef.current) {
      const { prevScrollHeight, prevScrollTop } = preserveScrollRef.current;
      const delta = el.scrollHeight - prevScrollHeight;
      el.scrollTop = prevScrollTop + delta;
      preserveScrollRef.current = null;
      prevFirstSeqRef.current = filteredLogs[0]?.seq ?? null;
      prevLengthRef.current = filteredLogs.length;
      return;
    }

    // 2. 可见条目数变化（新到达/过滤增减）且用户在底部附近：跟随到底
    if (autoScrollRef.current && filteredLogs.length !== prevLengthRef.current) {
      anchorToBottom();
    }
    prevFirstSeqRef.current = filteredLogs[0]?.seq ?? null;
    prevLengthRef.current = filteredLogs.length;
  }, [filteredLogs, anchorToBottom]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_PX;

    // 向上滚到顶部时拉取更早历史
    if (scrollTop < NEAR_TOP_PX && onLoadOlder && !loadingOlderRef.current && logs.length > 0) {
      loadingOlderRef.current = true;
      // 记录锚点用于 useEffect 恢复
      preserveScrollRef.current = { prevScrollHeight: scrollHeight, prevScrollTop: scrollTop };
      onLoadOlder()
        .catch(() => {})
        .finally(() => {
          loadingOlderRef.current = false;
        });
    }
  }, [onLoadOlder, logs.length]);

  const toggleExpand = (seq: number) => {
    setOverrides(prev => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq); else next.add(seq);
      return next;
    });
  };

  // 模式切换时清空例外，语义回到干净的"全开/全收"基线；新到达的行跟随当前模式。
  // 切换前按"当下真实几何"重判跟随态——autoScrollRef 只在 scroll 事件里更新，
  // 高度剧变前的旧值不可靠。
  const toggleExpandAll = () => {
    const el = listRef.current;
    if (el) autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setExpandAll(v => !v);
    setOverrides(new Set());
  };

  // 模式切换整体改变行高；若此前正跟随底部，重新钉到底（否则视口停在旧偏移的中段）
  useLayoutEffect(() => {
    if (autoScrollRef.current) anchorToBottom();
  }, [expandAll, anchorToBottom]);

  const levels = ['debug', 'info', 'warn', 'error'];

  return (
    <div className="page-logs">
      <div className="log-controls">
        {levels.map(l => (
          <button
            key={l}
            className={`log-filter ${filter === l ? 'active' : ''}`}
            onClick={() => setFilter(prev => prev === l ? null : l)}
          >
            {l.toUpperCase()}
          </button>
        ))}
        <button className={`log-filter ${expandAll ? 'active' : ''}`} onClick={toggleExpandAll}>
          {expandAll ? '全部收起' : '全部展开'}
        </button>
        <input
          className="log-search"
          type="search"
          placeholder="关键词过滤（空格=同时含，-词=排除）"
          value={query}
          onChange={e => setQuery(e.target.value)}
          title="对 scope 与内容做大小写不敏感的子串匹配；只过滤已加载的行，上滚可加载更早历史"
        />
        <span className="log-count">{filteredLogs.length}/{logs.length}</span>
      </div>
      <div className="log-list" ref={listRef} onScroll={handleScroll}>
        {filteredLogs.map(entry => {
          const isExpanded = expandAll ? !overrides.has(entry.seq) : overrides.has(entry.seq);
          return (
            <div
              className={`log-entry ${isExpanded ? 'expanded' : ''}`}
              key={entry.seq}
              onClick={() => toggleExpand(entry.seq)}
              // 轻量虚拟化只给折叠行；估算尺寸用 `auto 28px`——auto 让浏览器记住
              // 每行真实渲染高度作占位值，消除"固定 28px vs 真实行高"的偏差
              // （该偏差 ×200 行 ≈ 2000px，会让钉底后的视口持续差一截，实测复现）。
              // 展开行不虚拟化：行高差数量级，估算失真会让滚动几何整体不可信。
              style={isExpanded ? undefined : ({ contentVisibility: 'auto', containIntrinsicSize: 'auto 28px' } as React.CSSProperties)}
            >
              <span className="log-time" title={entry.timestamp}>{entry.timestamp.slice(11, 23)}</span>
              <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase().padEnd(5)}</span>
              <span className="log-scope">{entry.scope}</span>
              <span className="log-msg" title={isExpanded ? '' : entry.message}>{entry.message}</span>
            </div>
          );
        })}
        {filteredLogs.length === 0 && (
          <div className="empty-hint" style={{ padding: 16 }}>暂无日志</div>
        )}
      </div>
    </div>
  );
}
