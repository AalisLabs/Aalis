import { useState, useRef, useEffect, useCallback } from 'react';
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
  // 展开态以 seq 为 key（不是数组下标）——前置加载/裁剪不会错位
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
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

  const filteredLogs = filter ? logs.filter(l => l.level === filter) : logs;

  // logs 变化后的滚动处理：先恢复"加载更早"留下的视口，再做"跟随底部"判定
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // 1. 前置加载发生：保持用户视口在原内容上（避免视觉跳动）
    if (preserveScrollRef.current) {
      const { prevScrollHeight, prevScrollTop } = preserveScrollRef.current;
      const delta = el.scrollHeight - prevScrollHeight;
      el.scrollTop = prevScrollTop + delta;
      preserveScrollRef.current = null;
      prevFirstSeqRef.current = logs[0]?.seq ?? null;
      prevLengthRef.current = logs.length;
      return;
    }

    // 2. 追加新条目且用户在底部附近：跟随到底
    if (autoScrollRef.current && logs.length > prevLengthRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirstSeqRef.current = logs[0]?.seq ?? null;
    prevLengthRef.current = logs.length;
  }, [logs]);

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
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq); else next.add(seq);
      return next;
    });
  };

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
        <span className="log-hint">点击单行展开/折叠完整内容</span>
      </div>
      <div className="log-list" ref={listRef} onScroll={handleScroll}>
        {filteredLogs.map(entry => {
          const isExpanded = expanded.has(entry.seq);
          return (
            <div
              className={`log-entry ${isExpanded ? 'expanded' : ''}`}
              key={entry.seq}
              onClick={() => toggleExpand(entry.seq)}
              style={{ contentVisibility: 'auto', containIntrinsicSize: '28px' } as React.CSSProperties}
            >
              <span className="log-time">{entry.timestamp}</span>
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
