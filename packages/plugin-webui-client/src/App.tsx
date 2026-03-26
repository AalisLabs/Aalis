import { useState, useRef, useEffect, useCallback } from 'react';
import 'highlight.js/styles/github-dark-dimmed.css';

import { api, SESSION_ID } from './api';
import type { ChatMessage, LogEntry, SystemStatus, PluginInfo, ServiceInfo, WebuiPageDef, ContentSegment, PageTab } from './types';
import { IconDashboard, IconMarketplace, IconPluginConfig, IconPlatform, IconAuthority, IconLogs } from './icons';
import { useWebSocket } from './useWebSocket';
import { DashboardPage } from './pages/DashboardPage';
import { PluginConfigPage } from './pages/PluginConfigPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { ChatPanel } from './pages/ChatPanel';
import { PlatformPage } from './pages/PlatformPage';
import { AuthorityPage } from './pages/AuthorityPage';
import { LogPage } from './pages/LogPage';
import { DynamicPage } from './components/DynamicPage';

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<PageTab>(() => {
    const hash = location.hash.replace('#', '');
    return hash || 'dashboard';
  });

  // 可用页面列表（由服务端 /api/pages 返回，null 表示尚未加载）
  const [availablePages, setAvailablePages] = useState<Set<string> | null>(null);
  // 服务端返回的完整页面定义列表（含声明式内容）
  const [pageDefs, setPageDefs] = useState<WebuiPageDef[]>([]);

  useEffect(() => {
    location.hash = activeTab;
  }, [activeTab]);

  // 当可用页面加载后，若当前 tab 不在列表中则回退到 dashboard
  useEffect(() => {
    if (availablePages && !availablePages.has(activeTab)) {
      setActiveTab('dashboard');
    }
  }, [availablePages, activeTab]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [servicesData, setServicesData] = useState<Record<string, ServiceInfo> | null>(null);
  const [chatWidth, setChatWidth] = useState(420);

  // 重启中状态
  const [restarting, setRestarting] = useState(false);

  const streamingRef = useRef(false);

  const handleIncoming = useCallback((content: string, reasoningContent?: string) => {
    // message:send 到达时，用完整内容更新最后一个文本段，保留所有 segments
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && streamingRef.current) {
        streamingRef.current = false;
        const segments = [...(last.segments ?? [])];
        // 更新最后一个 text segment 为最终完整内容
        const lastSeg = segments[segments.length - 1];
        if (lastSeg && lastSeg.type === 'text') {
          segments[segments.length - 1] = { type: 'text', content };
        } else {
          segments.push({ type: 'text', content });
        }
        // 保留流式阶段已构建好的 reasoningSegments（含 tool_call 结构），
        // 不用 message:send 的扁平合并文本覆盖
        const reasoningSegments = last.reasoningSegments;
        return [...prev.slice(0, -1), {
          ...last,
          content,
          reasoningContent: reasoningContent ?? last.reasoningContent,
          reasoningSegments: reasoningSegments ?? last.reasoningSegments,
          segments,
        }];
      }
      streamingRef.current = false;
      return [...prev, { role: 'assistant' as const, content, reasoningContent, segments: [{ type: 'text' as const, content }], timestamp: Date.now() }];
    });
    setLoading(false);
  }, []);

  const handleStream = useCallback((contentDelta?: string, reasoningDelta?: string, done?: boolean) => {
    if (done) {
      // 流结束标记 — 解除 loading（正常完成、中止、或消息被拦截均会到达此处）
      setLoading(false);
      return;
    }

    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && streamingRef.current) {
        const updated = { ...last };
        if (reasoningDelta) {
          updated.reasoningContent = (updated.reasoningContent ?? '') + reasoningDelta;
          // 追加到 reasoningSegments
          const rSegs = [...(updated.reasoningSegments ?? [])];
          const lastRS = rSegs[rSegs.length - 1];
          if (lastRS && lastRS.type === 'text') {
            rSegs[rSegs.length - 1] = { type: 'text', content: lastRS.content + reasoningDelta };
          } else {
            rSegs.push({ type: 'text', content: reasoningDelta });
          }
          updated.reasoningSegments = rSegs;
        }
        if (contentDelta) {
          updated.content += contentDelta;
          const segments = [...(updated.segments ?? [])];
          const lastSeg = segments[segments.length - 1];
          if (lastSeg && lastSeg.type === 'text') {
            segments[segments.length - 1] = { type: 'text', content: lastSeg.content + contentDelta };
          } else {
            // 工具调用后的新文本段
            segments.push({ type: 'text', content: contentDelta });
          }
          updated.segments = segments;
        }
        return [...prev.slice(0, -1), updated];
      }
      // 创建新的助手消息
      streamingRef.current = true;
      return [...prev, {
        role: 'assistant' as const,
        content: contentDelta ?? '',
        reasoningContent: reasoningDelta,
        reasoningSegments: reasoningDelta ? [{ type: 'text' as const, content: reasoningDelta }] : [],
        segments: contentDelta ? [{ type: 'text' as const, content: contentDelta }] : [],
        timestamp: Date.now(),
      }];
    });
    setLoading(false);
  }, []);

  const handleLog = useCallback((entry: LogEntry) => {
    setLogs(prev => {
      const next = [...prev, entry];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const handleToolCall = useCallback((toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (toolPhase === 'start') {
        if (last && last.role === 'assistant') {
          // 判断是否处于"思考"阶段：有 reasoning 但还没有内容文本
          const isThinking = !last.content && (last.reasoningContent || (!last.segments?.length));
          if (isThinking) {
            const rSegs = [...(last.reasoningSegments ?? [])];
            rSegs.push({ type: 'tool_call', name: toolName, args: toolArgs });
            return [...prev.slice(0, -1), { ...last, reasoningSegments: rSegs }];
          }
          const segments = [...(last.segments ?? [])];
          segments.push({ type: 'tool_call', name: toolName, args: toolArgs });
          return [...prev.slice(0, -1), { ...last, segments }];
        }
        streamingRef.current = true;
        return [...prev, {
          role: 'assistant' as const,
          content: '',
          reasoningSegments: [{ type: 'tool_call' as const, name: toolName, args: toolArgs }],
          timestamp: Date.now(),
        }];
      }
      // toolPhase === 'end'——填充结果，先查 reasoningSegments 再查 segments
      if (last && last.role === 'assistant') {
        if (last.reasoningSegments) {
          const rSegs = [...last.reasoningSegments];
          const idx = rSegs.findIndex(s => s.type === 'tool_call' && s.name === toolName && s.result == null);
          if (idx !== -1) {
            const seg = rSegs[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
            rSegs[idx] = { ...seg, result: toolResult };
            return [...prev.slice(0, -1), { ...last, reasoningSegments: rSegs }];
          }
        }
        if (last.segments) {
          const segments = [...last.segments];
          const idx = segments.findIndex(s => s.type === 'tool_call' && s.name === toolName && s.result == null);
          if (idx !== -1) {
            const seg = segments[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
            segments[idx] = { ...seg, result: toolResult };
            return [...prev.slice(0, -1), { ...last, segments }];
          }
        }
      }
      return prev;
    });
  }, []);

  const refreshPlugins = useCallback(() => {
    api<{ plugins: PluginInfo[] }>('/api/plugins')
      .then(d => setPlugins(d.plugins ?? []))
      .catch(() => {});
  }, []);

  const refreshConfig = useCallback(() => {
    api<Record<string, unknown>>('/api/config').then(setConfig).catch(() => {});
  }, []);

  const refreshServices = useCallback(() => {
    api<{ services: Record<string, ServiceInfo> }>('/api/services')
      .then(d => setServicesData(d.services ?? null))
      .catch(() => {});
  }, []);

  const refreshPages = useCallback(() => {
    api<WebuiPageDef[]>('/api/pages')
      .then(pages => {
        setPageDefs(pages);
        setAvailablePages(new Set(pages.map(p => p.key)));
      })
      .catch(() => {});
  }, []);

  const handleStateChanged = useCallback(() => {
    refreshPlugins();
    refreshServices();
    refreshPages();
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
  }, [refreshPlugins, refreshServices, refreshPages]);

  const handleRestarting = useCallback(() => {
    setRestarting(true);
  }, []);

  const { send, sendRaw, connected } = useWebSocket(handleIncoming, handleStream, handleLog, handleToolCall, handleStateChanged, handleRestarting);

  // 重启完成后自动刷新页面
  useEffect(() => {
    if (restarting && connected) {
      window.location.reload();
    }
  }, [restarting, connected]);

  useEffect(() => {
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
    refreshConfig();
    refreshPlugins();
    refreshServices();
    refreshPages();
    api<LogEntry[]>('/api/logs').then(setLogs).catch(() => {});
  }, [refreshPlugins, refreshConfig, refreshServices, refreshPages]);

  useEffect(() => {
    const timer = setInterval(() => {
      api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
      refreshPlugins();
      refreshServices();
      refreshPages();
    }, 10000);
    return () => clearInterval(timer);
  }, [refreshPlugins, refreshServices, refreshPages]);

  const handleAbort = useCallback(() => {
    sendRaw({ type: 'abort', sessionId: SESSION_ID });
    setLoading(false);
    streamingRef.current = false;
  }, [sendRaw]);

  const handleSend = () => {
    const trimmed = input.trim();

    // 生成中 — 先中止当前生成
    if (loading) {
      handleAbort();
    }

    if (!trimmed) return;

    setMessages(prev => [...prev, { role: 'user', content: trimmed, timestamp: Date.now() }]);
    send(trimmed);
    setInput('');
    setLoading(true);
  };

  // 内置页面（有专用 React 组件）及其图标映射
  const builtinIconMap: Record<string, React.ReactNode> = {
    dashboard: <IconDashboard />,
    marketplace: <IconMarketplace />,
    'plugin-config': <IconPluginConfig />,
    platforms: <IconPlatform />,
    authority: <IconAuthority />,
    logs: <IconLogs />,
  };
  const builtinKeys = new Set(Object.keys(builtinIconMap));

  // 默认图标（用于插件声明的动态页面）
  const defaultIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M3 9h18" />
    </svg>
  );

  // 组合内置 + 动态页面为统一的 tab 列表
  const tabs: { key: string; label: string; icon: React.ReactNode; order: number }[] = (() => {
    if (!availablePages) {
      // 未加载时显示全部内置（避免闪烁）
      return Object.entries(builtinIconMap).map(([key, icon], i) => ({
        key, label: key, icon, order: (i + 1) * 10,
      }));
    }
    return pageDefs
      .filter(p => availablePages.has(p.key))
      .map(p => ({
        key: p.key,
        label: p.label,
        icon: builtinIconMap[p.key] ?? defaultIcon,
        order: p.order ?? 99,
      }))
      .sort((a, b) => a.order - b.order);
  })();

  // 查找当前 tab 对应的动态页面定义（仅非内置页面）
  const activeDynamicPage = (!builtinKeys.has(activeTab))
    ? pageDefs.find(p => p.key === activeTab && p.content)
    : undefined;

  return (
    <div className="app-layout">
      {/* 左侧导航 */}
      <nav className="nav-rail">
        <div className="nav-rail-top">
          <div className="nav-logo">A</div>
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={`nav-item ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="nav-item-icon">{tab.icon}</span>
              <span className="nav-item-label">{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="nav-rail-bottom">
          <div className={`nav-status ${connected ? 'online' : 'offline'}`} title={connected ? '已连接' : '离线'} />
        </div>
      </nav>

      {/* 左侧内容区 */}
      <main className="content-area">
        <div className="content-header">
          <span className="content-title">
            {tabs.find(t => t.key === activeTab)?.label}
          </span>
        </div>

        <div className="content-body">
          {activeTab === 'dashboard' && (
            <DashboardPage
              status={status}
              connected={connected}
              plugins={plugins}
              servicesData={servicesData}
              onRefreshServices={refreshServices}
            />
          )}
          {activeTab === 'marketplace' && (
            <MarketplacePage plugins={plugins} onRefresh={refreshPlugins} />
          )}
          {activeTab === 'plugin-config' && (
            <PluginConfigPage
              plugins={plugins}
              config={config}
              onRefresh={refreshPlugins}
              onConfigSaved={refreshConfig}
              onRestart={() => setRestarting(true)}
            />
          )}
          {activeTab === 'platforms' && <PlatformPage />}
          {activeTab === 'authority' && <AuthorityPage />}
          {activeTab === 'logs' && <LogPage logs={logs} />}
          {activeDynamicPage && <DynamicPage page={activeDynamicPage} />}
        </div>
      </main>

      {/* 拖拽分隔条 */}
      <div
        className="resize-handle"
        onMouseDown={e => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = chatWidth;
          const onMove = (ev: MouseEvent) => {
            const appW = document.querySelector('.app-layout')!.clientWidth;
            const navW = document.querySelector('.nav-rail')!.clientWidth;
            const minContent = 360;
            const minChat = 280;
            const maxChat = appW - navW - minContent;
            const raw = startW - (ev.clientX - startX);
            setChatWidth(Math.max(minChat, Math.min(maxChat, raw)));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      />

      {/* 右侧固定聊天面板 */}
      <ChatPanel
        messages={messages}
        loading={loading}
        connected={connected}
        status={status}
        input={input}
        setInput={setInput}
        onSend={handleSend}
        onAbort={handleAbort}
        width={chatWidth}
      />

      {/* 重启中遮罩 */}
      {restarting && (
        <div className="restart-overlay">
          <div className="restart-dialog">
            <div className="restart-spinner" />
            <h3>正在重启…</h3>
            <p className="restart-desc">应用正在重新启动，请稍候</p>
          </div>
        </div>
      )}
    </div>
  );
}
