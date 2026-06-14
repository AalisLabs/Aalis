import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import 'highlight.js/styles/github-dark-dimmed.css';

import { api, getSessionId, pageAction } from './api';
import type { LogEntry, SystemStatus, PluginInfo, ServiceInfo, WebuiPageDef, ContentSegment, ChatMessage, PageTab, TodoItem } from './types';
import { IconDashboard, IconMarketplace, IconPluginConfig, IconPlatform, IconAuthority, IconLogs, IconFiles } from './icons';
import { useWebSocket } from './useWebSocket';
import type { TokenUsageData } from './useWebSocket';
import { useSessionManager } from './useSessionManager';
// Dashboard 与 ChatPanel 是首屏主路径，保持同步加载；其余页面路由级懒加载。
import { DashboardPage } from './pages/DashboardPage';
import { ChatPanel } from './pages/ChatPanel';

const PluginConfigPage = lazy(() => import('./pages/PluginConfigPage').then(m => ({ default: m.PluginConfigPage })));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage').then(m => ({ default: m.MarketplacePage })));
const PlatformPage = lazy(() => import('./pages/PlatformPage').then(m => ({ default: m.PlatformPage })));
const AuthorityPage = lazy(() => import('./pages/AuthorityPage').then(m => ({ default: m.AuthorityPage })));
const LogPage = lazy(() => import('./pages/LogPage').then(m => ({ default: m.LogPage })));
const SessionsPage = lazy(() => import('./pages/SessionsPage').then(m => ({ default: m.SessionsPage })));
const FilesPage = lazy(() => import('./pages/FilesPage').then(m => ({ default: m.FilesPage })));
const DynamicPage = lazy(() => import('./components/DynamicPage').then(m => ({ default: m.DynamicPage })));

export function App() {
  // input, pendingImages, pendingFiles, attachmentOrderRef 已下沉到 ChatPanel，不再在 App 层持有
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
  /** 当前登录身份（/api/auth/me）：账户登录显示用户名，单 token 模式为 console */
  const [me, setMe] = useState<{
    identity: { platform: string; userId: string };
    isOwner: boolean;
  } | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [servicesData, setServicesData] = useState<Record<string, ServiceInfo> | null>(null);

  // ---- 多会话管理（封装在 hook 中） ----
  const session = useSessionManager(pageDefs);
  const { messages, setMessages, loading, setLoading, streamingRef } = session;

  /**
   * 流式 delta 累积缓冲区。
   * pending 是一个**按到达顺序**记录的事件队列：每条只带一种 delta（content 或 reasoning），
   * 由 RAF 一次性批量 flush 进 message.segments。这样 RAF 在后台标签被 throttle 时，
   * 即使一帧内累积了多个 delta，flush 仍能保持原本的 content / reasoning 交错顺序。
   */
  const streamBufRef = useRef({
    pending: [] as Array<{ kind: 'content' | 'reasoning'; text: string }>,
    raf: 0 as number,
  });

  /** WS 推送 sessions_changed 时递增，通知 SessionsPage 刷新 */
  const [sessionsRefreshSignal, setSessionsRefreshSignal] = useState(0);

  /** 当前会话的 todo 列表 */
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);

  const [chatWidth, setChatWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 420;
    const stored = Number(window.localStorage.getItem('aalis:chatWidth'));
    return Number.isFinite(stored) && stored >= 280 ? stored : 420;
  });
  // 持久化 chatWidth
  useEffect(() => {
    try { window.localStorage.setItem('aalis:chatWidth', String(chatWidth)); } catch { /* quota */ }
  }, [chatWidth]);
  // 容器变窄时重新夹取 chatWidth：保证内容区始终 ≥ minContent，空间实在不够才把
  // 聊天降到地板宽。否则固定宽的聊天列会把 flex 内容区挤到 0、被左侧导航“吃掉”。
  // 监听 .app-layout 尺寸变化（VSCode webview / 浏览器窗口拉伸都会触发）。
  useEffect(() => {
    const layout = document.querySelector<HTMLElement>('.app-layout');
    if (!layout || typeof ResizeObserver === 'undefined') return;
    const MIN_CONTENT = 360;
    const MIN_CHAT = 240;
    const reclamp = () => {
      const appW = layout.clientWidth;
      const navW = document.querySelector<HTMLElement>('.nav-rail')?.getBoundingClientRect().width ?? 56;
      const max = Math.max(MIN_CHAT, appW - navW - MIN_CONTENT);
      setChatWidth(w => Math.min(Math.max(w, MIN_CHAT), max));
    };
    const ro = new ResizeObserver(reclamp);
    ro.observe(layout);
    return () => ro.disconnect();
  }, []);

  // 工具调用达到上限标记
  const [toolLimitReached, setToolLimitReached] = useState(false);

  // 工具调用生成进度（LLM 在 tool_call 阶段无文本输出）：按 index 维护多个并发工具
  const [toolCallsProgress, setToolCallsProgress] = useState<
    Map<number, { name: string; charsAccumulated: number; startedAt: number }>
  >(new Map());

  // 重启中状态
  const [restarting, setRestarting] = useState(false);
  // 重启过程中 WS 已断开过（用于区分：收到 restarting 后需要先断开再重连才刷新）
  const [wasDisconnected, setWasDisconnected] = useState(false);
  // 简单重载（webui-client 切换等，无需等待重连）
  const [reloading, setReloading] = useState(false);
  // 重启/刷新 overlay 的提示文字
  const [restartMessage, setRestartMessage] = useState('正在重启…');

  // 高危操作确认等待状态
  const [pendingConfirm, setPendingConfirm] = useState(false);

  // Token 使用量统计
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData | null>(null);

  // 压缩状态: null=空闲, 'start'=正在压缩, 'done'=完成, 'error'=失败
  const [compressingStatus, setCompressingStatus] = useState<'start' | 'done' | 'error' | null>(null);

  /**
   * 把单个 typed segment 追加到时间线尾部，并合并相邻同类 text/reasoning_text。
   * 不修改入参，返回新数组。
   */
  const appendSegmentToTimeline = (timeline: ContentSegment[] | undefined, seg: ContentSegment): ContentSegment[] => {
    const arr = timeline ? [...timeline] : [];
    const last = arr[arr.length - 1];
    if (seg.type === 'text' && last && last.type === 'text') {
      arr[arr.length - 1] = { type: 'text', content: last.content + seg.content };
    } else if (seg.type === 'reasoning_text' && last && last.type === 'reasoning_text') {
      arr[arr.length - 1] = { type: 'reasoning_text', content: last.content + seg.content };
    } else {
      arr.push(seg);
    }
    return arr;
  };

  /** 从 segments 派生扁平 content / reasoningContent（供 LLM API 镜像与老代码使用） */
  const deriveTextFromSegments = (segments: ContentSegment[] | undefined): { content: string; reasoning: string } => {
    let content = '';
    let reasoning = '';
    for (const s of segments ?? []) {
      if (s.type === 'text') content += s.content;
      else if (s.type === 'reasoning_text') reasoning += s.content;
    }
    return { content, reasoning };
  };

  const handleIncoming = useCallback((
    content: string,
    reasoningContent?: string,
    serverSegments?: ContentSegment[],
    attachments?: Array<{ kind: 'image' | 'audio' | 'video' | 'file'; data: string; mimeType?: string; name?: string }>,
    modelInfo?: { provider?: string; model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; elapsedMs?: number },
  ) => {
    // 取消 handleStream 尚未执行的 RAF，防止它在 streamingRef 已置 false 后
    // 创建重复的 assistant 消息（竞态：RAF 回调晚于 handleIncoming 执行）
    if (streamBufRef.current.raf) {
      cancelAnimationFrame(streamBufRef.current.raf);
      streamBufRef.current.raf = 0;
    }
    streamBufRef.current.pending = [];

    // outbound:message 到达：以服务端为准锁定最终内容。
    // 优先信任服务端 segments（含真实顺序）；缺省时回退用 content + reasoningContent 重建。
    setMessages(prev => {
      const last = prev[prev.length - 1];
      const finalSegments: ContentSegment[] = serverSegments && serverSegments.length > 0
        ? serverSegments
        : reasoningContent
          ? [{ type: 'reasoning_text', content: reasoningContent }, { type: 'text', content }]
          : [{ type: 'text', content }];

      if (last && last.role === 'assistant' && streamingRef.current) {
        streamingRef.current = false;
        return [...prev.slice(0, -1), {
          ...last,
          content,
          reasoningContent: reasoningContent ?? last.reasoningContent,
          segments: finalSegments,
          attachments: attachments ?? last.attachments,
          modelInfo: modelInfo ?? last.modelInfo,
        }];
      }
      streamingRef.current = false;
      return [...prev, {
        role: 'assistant' as const,
        content,
        reasoningContent,
        segments: finalSegments,
        attachments,
        modelInfo,
        timestamp: Date.now(),
      }];
    });
    setLoading(false);
  }, []);

  /**
   * 把 streamBufRef.pending 队列里所有事件**按顺序**刷入消息 segments。
   *  - 由 rAF 回调调用（正常批处理）
   *  - 由 handleToolCall / handleStream(done) 主动调用（确保顺序一致且不丢尾巴）
   */
  const flushStreamBuffer = useCallback(() => {
    const buf = streamBufRef.current;
    if (buf.raf) {
      cancelAnimationFrame(buf.raf);
      buf.raf = 0;
    }
    if (buf.pending.length === 0) return;
    const events = buf.pending;
    buf.pending = [];

    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && streamingRef.current) {
        let segments = last.segments ?? [];
        for (const ev of events) {
          segments = appendSegmentToTimeline(segments, { type: ev.kind === 'content' ? 'text' : 'reasoning_text', content: ev.text });
        }
        const { content, reasoning } = deriveTextFromSegments(segments);
        return [...prev.slice(0, -1), {
          ...last,
          content,
          reasoningContent: reasoning || undefined,
          segments,
        }];
      }
      // 创建新的助手消息
      streamingRef.current = true;
      let segments: ContentSegment[] = [];
      for (const ev of events) {
        segments = appendSegmentToTimeline(segments, { type: ev.kind === 'content' ? 'text' : 'reasoning_text', content: ev.text });
      }
      const { content, reasoning } = deriveTextFromSegments(segments);
      return [...prev, {
        role: 'assistant' as const,
        content,
        reasoningContent: reasoning || undefined,
        segments,
        timestamp: Date.now(),
      }];
    });
  }, [setMessages, streamingRef]);

  const handleStream = useCallback((contentDelta?: string, reasoningDelta?: string, done?: boolean, toolLimitReached?: boolean) => {
    if (done) {
      flushStreamBuffer();
      setLoading(false);
      setToolLimitReached(!!toolLimitReached);
      setToolCallsProgress(new Map());
      return;
    }

    // LLM 进入文本/推理生成阶段：清空全部工具调用进度提示
    if (contentDelta || reasoningDelta) {
      setToolCallsProgress(prev => (prev.size === 0 ? prev : new Map()));
    }

    // 单个 chunk 通常只带 content 或 reasoning 之一（OpenAI 兼容 SSE 行为）；
    // 若同时存在则按 reasoning → content 顺序追加（与 DeepSeek 字段顺序一致）。
    const buf = streamBufRef.current;
    if (reasoningDelta) buf.pending.push({ kind: 'reasoning', text: reasoningDelta });
    if (contentDelta) buf.pending.push({ kind: 'content', text: contentDelta });
    if (buf.raf) return;
    buf.raf = requestAnimationFrame(flushStreamBuffer);
  }, [flushStreamBuffer, setLoading]);

  const handleLog = useCallback((entry: LogEntry) => {
    setLogs(prev => {
      // 去重（极少情况下 WS 推送可能与首屏拉取重叠）：seq 作为 PK
      if (prev.length > 0 && prev[prev.length - 1].seq >= entry.seq) {
        if (prev.some(e => e.seq === entry.seq)) return prev;
      }
      // 不再做硬上限——上限管理交给 LogPage 的虚拟化 + 滚动加载
      return [...prev, entry];
    });
  }, []);

  const loadOlderLogs = useCallback(async (): Promise<number> => {
    const oldest = logs[0];
    if (!oldest) return 0;
    try {
      const older = await api<LogEntry[]>(`/api/logs/range?before=${oldest.seq}&limit=200`);
      if (!older || older.length === 0) return 0;
      setLogs(prev => {
        // 已存在的 seq 跳过
        const have = new Set(prev.map(e => e.seq));
        const fresh = older.filter(e => !have.has(e.seq));
        return [...fresh, ...prev];
      });
      return older.length;
    } catch {
      return 0;
    }
  }, [logs]);

  const handleToolCall = useCallback((toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => {
    // 先把挂起的文本 delta 刷入，确保 tool_call 按真实到达顺序插入
    flushStreamBuffer();
    // 进入工具执行阶段：清空「生成中」提示（占位卡 → ToolCallBlock）
    if (toolPhase === 'start') {
      setToolCallsProgress(prev => (prev.size === 0 ? prev : new Map()));
    }
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (toolPhase === 'start') {
        const now = Date.now();
        if (last && last.role === 'assistant') {
          const segments = appendSegmentToTimeline(last.segments, { type: 'tool_call', name: toolName, args: toolArgs, startTime: now });
          return [...prev.slice(0, -1), { ...last, segments }];
        }
        streamingRef.current = true;
        return [...prev, {
          role: 'assistant' as const,
          content: '',
          segments: [{ type: 'tool_call' as const, name: toolName, args: toolArgs, startTime: now }],
          timestamp: Date.now(),
        }];
      }
      // toolPhase === 'end'——按时间线倒序找首个未填结果的同名 tool_call
      if (last && last.role === 'assistant' && last.segments) {
        const endNow = Date.now();
        const segments = [...last.segments];
        for (let i = segments.length - 1; i >= 0; i--) {
          const s = segments[i];
          if (s.type === 'tool_call' && s.name === toolName && s.result == null) {
            segments[i] = { ...s, result: toolResult, endTime: endNow };
            return [...prev.slice(0, -1), { ...last, segments }];
          }
        }
      }
      return prev;
    });
  }, [flushStreamBuffer]);

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
    session.refresh();
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
  }, [refreshPlugins, refreshServices, refreshPages, session.refresh]);

  const handleRestarting = useCallback(() => {
    setRestarting(true);
    setWasDisconnected(false);
    setRestartMessage('正在重启…');
  }, []);

  const handleReload = useCallback(() => {
    setReloading(true);
    setRestartMessage('正在切换前端，即将刷新…');
  }, []);

  /** 会话列表变更（WS 实时推送）：刷新会话相关数据并通知 SessionsPage */
  const handleSessionsChanged = useCallback(() => {
    session.refresh();
    setSessionsRefreshSignal(n => n + 1);
  }, [session.refresh]);

  /** Todo 列表变更（WS 实时推送） */
  const handleTodoUpdated = useCallback((items: unknown[]) => {
    setTodoItems(items as TodoItem[]);
  }, []);

  /** 刷新后恢复正在生成的流式内容（统一时间线，服务端为权威） */
  const handleStreamResume = useCallback((
    content: string,
    reasoningContent: string,
    serverSegments: ContentSegment[],
    done: boolean,
    resumeProgress?: Array<{ index: number; name: string; charsAccumulated: number; startedAt: number }>,
  ) => {
    setMessages(prev => {
      // 服务端 segments 已是按到达顺序的统一时间线（含 text / reasoning_text / tool_call）；
      // 直接采用，无需再按 reasoning 是否存在做分桶。
      let segments: ContentSegment[] = serverSegments && serverSegments.length > 0
        ? serverSegments
        : [];
      if (segments.length === 0) {
        // 兼容：服务端未提供 segments（理论上不会发生），用扁平串重建两段式
        if (reasoningContent) segments.push({ type: 'reasoning_text', content: reasoningContent });
        if (content) segments.push({ type: 'text', content });
      }

      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        return [...prev.slice(0, -1), {
          ...last,
          content,
          reasoningContent: reasoningContent || last.reasoningContent,
          segments,
        }];
      }
      return [...prev, {
        role: 'assistant' as const,
        content,
        reasoningContent: reasoningContent || undefined,
        segments,
        timestamp: Date.now(),
      }];
    });
    if (!done) {
      streamingRef.current = true;
      setLoading(true);
    }
    // 恢复多个并发工具调用进度（重连/刷新后立即重现）
    if (resumeProgress && resumeProgress.length > 0) {
      setToolCallsProgress(new Map(resumeProgress.map(p => [
        p.index,
        { name: p.name, charsAccumulated: p.charsAccumulated, startedAt: p.startedAt },
      ])));
    } else {
      setToolCallsProgress(prev => (prev.size === 0 ? prev : new Map()));
    }
  }, []);

  /** 单个工具调用进度增量更新 */
  const handleToolCallProgress = useCallback(
    (progress: { index: number; name: string; charsAccumulated: number }) => {
      setToolCallsProgress(prev => {
        const next = new Map(prev);
        const existing = next.get(progress.index);
        next.set(progress.index, {
          name: progress.name,
          charsAccumulated: progress.charsAccumulated,
          // 同 index 持续累积时保留 startedAt；新 index 则重置
          startedAt: existing?.startedAt ?? Date.now(),
        });
        return next;
      });
    },
    [],
  );

  /** 清空所有工具调用进度（stream done 等各类重置场景） */
  const handleToolCallProgressClear = useCallback(() => {
    setToolCallsProgress(prev => (prev.size === 0 ? prev : new Map()));
  }, []);

  /** 高危操作确认提示：插入消息但不影响 loading/streaming 状态 */
  const handleConfirm = useCallback((content: string) => {
    setPendingConfirm(true);
    setMessages(prev => [
      ...prev,
      { role: 'assistant' as const, content, segments: [{ type: 'text' as const, content }], timestamp: Date.now() },
    ]);
  }, []);

  /** Token 使用量更新 */
  const handleTokenUsage = useCallback((usage: TokenUsageData) => {
    setTokenUsage(usage);
  }, []);

  /** 压缩状态更新 */
  const handleCompressing = useCallback((sessionId: string, status: string) => {
    if (sessionId === getSessionId()) {
      setCompressingStatus(status as 'start' | 'done' | 'error');
      if (status === 'done') {
        // 插入永久的系统消息，与从数据库加载的 event-marker 一致
        setMessages(prev => [...prev, {
          role: 'system' as const,
          content: '对话已压缩',
          timestamp: Date.now(),
        }]);
        // 短暂延迟后清除临时计时器状态
        setTimeout(() => setCompressingStatus(null), 1500);
      } else if (status === 'error') {
        setTimeout(() => setCompressingStatus(null), 3000);
      }
    }
  }, []);

  const { send, sendRaw, connected } = useWebSocket({
    onMessage: handleIncoming,
    onStream: handleStream,
    onLog: handleLog,
    onToolCall: handleToolCall,
    onStateChanged: handleStateChanged,
    onRestarting: handleRestarting,
    onReload: handleReload,
    onSessionsChanged: handleSessionsChanged,
    onTodoUpdated: handleTodoUpdated,
    onStreamResume: handleStreamResume,
    onConfirm: handleConfirm,
    onTokenUsage: handleTokenUsage,
    onCompressing: handleCompressing,
    onHistoryChanged: session.handleHistoryChanged,
    onToolCallProgress: handleToolCallProgress,
    onToolCallProgressClear: handleToolCallProgressClear,
  });

  /** 手动触发压缩 */
  const handleCompress = useCallback(() => {
    sendRaw({ type: 'compress', sessionId: getSessionId() });
  }, [sendRaw]);

  // 重启流程：等待 WS 断开后重连，再刷新
  useEffect(() => {
    if (restarting && !connected) {
      setWasDisconnected(true);
      setRestartMessage('等待服务器重启…');
    }
  }, [restarting, connected]);

  useEffect(() => {
    if (restarting && wasDisconnected && connected) {
      setRestartMessage('服务器已就绪，即将刷新…');
      const timer = setTimeout(() => window.location.reload(), 800);
      return () => clearTimeout(timer);
    }
  }, [restarting, wasDisconnected, connected]);

  // 简单重载流程（webui-client 切换）：短暂延迟后直接刷新
  useEffect(() => {
    if (reloading) {
      const timer = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(timer);
    }
  }, [reloading]);

  useEffect(() => {
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
    api<typeof me>('/api/auth/me').then(setMe).catch(() => {});
    refreshConfig();
    refreshPlugins();
    refreshServices();
    refreshPages();
    session.refresh();
    api<LogEntry[]>('/api/logs/tail?limit=200').then(setLogs).catch(() => {});
  }, [refreshPlugins, refreshConfig, refreshServices, refreshPages, session.refresh]);

  // 会话切换时加载 todo 列表
  useEffect(() => {
    const sid = session.activeSessionId;
    if (!sid || sid === '__new_chat__') {
      setTodoItems([]);
      return;
    }
    pageAction<TodoItem[]>('@aalis/plugin-todo-list', 'getTodos', { sessionId: sid })
      .then(items => setTodoItems(items ?? []))
      .catch(() => setTodoItems([]));
  }, [session.activeSessionId]);

  useEffect(() => {
    const timer = setInterval(() => {
      api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
      refreshPlugins();
      refreshServices();
      refreshPages();
      session.refresh();
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshPlugins, refreshServices, refreshPages, session.refresh]);

  const handleAbort = useCallback(() => {
    sendRaw({ type: 'abort', sessionId: getSessionId() });
    setLoading(false);
    setToolLimitReached(false);
    streamingRef.current = false;
  }, [sendRaw]);

  const handleContinueTools = useCallback(() => {
    // 用户确认继续工具调用：发送一条提示消息让模型继续
    setMessages(prev => [...prev, {
      role: 'user' as const,
      content: '[请继续执行未完成的工具调用]',
      timestamp: Date.now(),
    }]);
    send('[请继续执行未完成的工具调用]');
    setToolLimitReached(false);
    setLoading(true);
  }, [send]);

  const handleClearTodos = useCallback(() => {
    const sid = session.activeSessionId;
    if (!sid || sid === '__new_chat__') return;
    pageAction('@aalis/plugin-todo-list', 'clearTodos', { sessionId: sid }).catch(() => {});
    setTodoItems([]);
  }, [session.activeSessionId]);

  const handleSend = useCallback(async (
    content: string,
    pendingFilesArg: Array<{ name: string; data: string; mimeType?: string }>,
    pendingImagesArg: string[],
    attachmentOrder: Array<'image' | 'file'>,
  ): Promise<void> => {
    const trimmed = content.trim();

    // 高危操作确认中 — 仅发送确认回复，不中止也不新建 loading
    if (pendingConfirm) {
      if (!trimmed) return;
      setPendingConfirm(false);
      setMessages(prev => [...prev, {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      }]);
      send(trimmed);
      return;
    }

    // 生成中 — 先中止当前生成
    if (loading) {
      handleAbort();
    }

    if (!trimmed && pendingImagesArg.length === 0 && pendingFilesArg.length === 0) return;

    // 确保有活跃会话（无会话时自动新建）
    await session.ensureSession();

    const images = pendingImagesArg.length > 0 ? [...pendingImagesArg] : undefined;
    // 统一打包成 attachments[]：图片 + 全部 pendingFiles（文档/音视频）按用户上传顺序
    const attachments: Array<{ kind: 'image' | 'audio' | 'video' | 'file'; data: string; mimeType?: string; name?: string }> = [];
    let imgIdx = 0;
    let fileIdx = 0;
    if (attachmentOrder.length > 0) {
      for (const t of attachmentOrder) {
        if (t === 'image' && imgIdx < pendingImagesArg.length) {
          attachments.push({ kind: 'image', data: pendingImagesArg[imgIdx++] });
        } else if (t === 'file' && fileIdx < pendingFilesArg.length) {
          const f = pendingFilesArg[fileIdx++];
          const mime = f.mimeType ?? '';
          const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file';
          attachments.push({ kind, data: f.data, mimeType: mime, name: f.name });
        }
      }
    }
    while (imgIdx < pendingImagesArg.length) {
      attachments.push({ kind: 'image', data: pendingImagesArg[imgIdx++] });
    }
    while (fileIdx < pendingFilesArg.length) {
      const f = pendingFilesArg[fileIdx++];
      const mime = f.mimeType ?? '';
      const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file';
      attachments.push({ kind, data: f.data, mimeType: mime, name: f.name });
    }
    setMessages(prev => [...prev, {
      role: 'user',
      content: trimmed,
      images,
      fileNames: pendingFilesArg.map(f => f.name),
      timestamp: Date.now(),
    }]);
    setToolLimitReached(false);
    setLoading(true);
    send(trimmed, attachments.length > 0 ? attachments : undefined);
  }, [pendingConfirm, loading, send, handleAbort, session]);

  // 内置页面（webui-server 核心页面）的图标映射
  const builtinIconMap: Record<string, React.ReactNode> = {
    dashboard: <IconDashboard />,
    marketplace: <IconMarketplace />,
    'plugin-config': <IconPluginConfig />,
    platforms: <IconPlatform />,
    authority: <IconAuthority />,
    files: <IconFiles />,
    logs: <IconLogs />,
  };

  // 默认图标（用于未声明 SVG 也不在内置映射中的页面）
  const defaultIcon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M3 9h18" />
    </svg>
  );

  /** 解析图标：内置名称 → 插件声明的 SVG → 默认图标 */
  const resolveIcon = (key: string, iconStr?: string): React.ReactNode => {
    if (builtinIconMap[key]) return builtinIconMap[key];
    if (iconStr && iconStr.trimStart().startsWith('<svg')) {
      return <span className="nav-item-svg" dangerouslySetInnerHTML={{ __html: iconStr }} />;
    }
    return defaultIcon;
  };

  // 组合内置 + 动态页面为统一的 tab 列表
  const tabs = useMemo(() => {
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
        pluginDisplayName: p.pluginDisplayName,
        icon: resolveIcon(p.key, p.icon),
        order: p.order ?? 99,
      }))
      .sort((a, b) => a.order - b.order);
  }, [availablePages, pageDefs]);

  // 自定义渲染器 — 返回稳定的 JSX 元素，避免每次 render 创建新的组件类型
  const renderCustomPage = (renderer: string, pluginName: string): React.ReactNode => {
    switch (renderer) {
      case 'dashboard': return <DashboardPage status={status} connected={connected} plugins={plugins} servicesData={servicesData} onRefreshServices={refreshServices} />;
      case 'marketplace': return <MarketplacePage plugins={plugins} onRefresh={refreshPlugins} />;
      case 'plugin-config': return <PluginConfigPage plugins={plugins} config={config} onRefresh={refreshPlugins} onConfigSaved={refreshConfig} onRestart={() => { setRestarting(true); setWasDisconnected(false); setRestartMessage('正在重启…'); }} />;
      case 'platforms': return <PlatformPage />;
      case 'authority': return <AuthorityPage />;
      case 'logs': return <LogPage logs={logs} onLoadOlder={loadOlderLogs} />;
      case 'files': return <FilesPage />;
      case 'sessions': return <SessionsPage pluginName={pluginName} activeSessionId={session.activeSessionId} onSwitchSession={(id) => { session.switchSession(id); }} onStartNewChat={() => session.startNewChat()} refreshSignal={sessionsRefreshSignal} />;
      default: return null;
    }
  };

  // 查找当前 tab 对应的页面定义
  const activePageDef = pageDefs.find(p => p.key === activeTab);
  const activeDynamicPage = activePageDef?.content ? activePageDef : undefined;

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
          {me && (
            <span className="content-user" title={`${me.identity.platform}:${me.identity.userId}`}>
              {me.identity.userId}
              {me.isOwner && <span className="content-user-level">owner</span>}
              <button
                className="btn-sm"
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST' });
                  window.location.reload();
                }}
              >登出</button>
            </span>
          )}
        </div>

        <div className="content-body">
          <Suspense fallback={<div className="empty-hint" style={{ padding: 24 }}>加载中…</div>}>
            {activeDynamicPage && <DynamicPage page={activeDynamicPage} />}
            {!activeDynamicPage && activePageDef?.renderer && (
              renderCustomPage(activePageDef.renderer, activePageDef.plugin) ||
              <div className="empty-hint" style={{ padding: 24 }}>此客户端不支持渲染器「{activePageDef.renderer}」</div>
            )}
          </Suspense>
        </div>
      </main>

      {/* 拖拽分隔条 */}
      <div
        className="resize-handle"
        onMouseDown={e => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = chatWidth;
          // 在 mousedown 时快照边界：避免 nav-rail:hover 展开或窗口 resize 中途变动
          const appW = document.querySelector('.app-layout')?.clientWidth ?? window.innerWidth;
          const navEl = document.querySelector<HTMLElement>('.nav-rail');
          const navW = navEl?.getBoundingClientRect().width ?? 56;
          const minContent = 360;
          const minChat = 280;
          const maxChat = Math.max(minChat, appW - navW - minContent);
          // 拖拽期间给 body 加上 class，用 CSS 抑制 nav-rail hover 展开
          document.body.classList.add('is-dragging-chat');
          const onMove = (ev: MouseEvent) => {
            const raw = startW - (ev.clientX - startX);
            setChatWidth(Math.max(minChat, Math.min(maxChat, raw)));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.body.classList.remove('is-dragging-chat');
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      />

      {/* 右侧固定聊天面板 */}
      <div className="chat-column" style={{ width: chatWidth }}>
        <ChatPanel
          messages={messages}
          loading={loading}
          connected={connected}
          status={status}
          onSend={handleSend}
          onAbort={handleAbort}
          width={chatWidth}
          sessionTitle={session.isNewChat ? '新对话' : session.activeSessionTitle}
          onNewSession={session.pluginName ? () => session.startNewChat() : undefined}
          todoItems={todoItems}
          onClearTodos={handleClearTodos}
          toolLimitReached={toolLimitReached}
          onContinueTools={handleContinueTools}
          toolCallsProgress={toolCallsProgress}
          tokenUsage={tokenUsage}
          compressingStatus={compressingStatus}
          onCompress={handleCompress}
        />
      </div>

      {/* 重启/刷新中遮罩 */}
      {(restarting || reloading) && (
        <div className="restart-overlay">
          <div className="restart-dialog">
            <div className="restart-spinner" />
            <h3>{reloading ? '切换前端' : '正在重启…'}</h3>
            <p className="restart-desc">{restartMessage}</p>
          </div>
        </div>
      )}
    </div>
  );
}
