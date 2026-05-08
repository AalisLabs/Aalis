import { useState, useRef, useEffect } from 'react';
import type { LogEntry } from '../types';

export function LogPage({ logs }: { logs: LogEntry[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const filteredLogs = filter ? logs.filter(l => l.level === filter) : logs;

  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filteredLogs.length]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  const toggleExpand = (i: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
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
        {filteredLogs.map((entry, i) => {
          const isExpanded = expanded.has(i);
          return (
            <div
              className={`log-entry ${isExpanded ? 'expanded' : ''}`}
              key={i}
              onClick={() => toggleExpand(i)}
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
