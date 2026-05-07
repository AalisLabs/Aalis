import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { getSessionId, setSessionId, pageAction } from './api';
import type { WebuiPageDef, ChatMessage, ContentSegment } from './types';
import type { SessionItem } from './components/SessionSidebar';

/** 生成时间格式的会话名：会话 04-02 15:30 */
function makeSessionName(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `会话 ${mm}-${dd} ${hh}:${mi}`;
}

export interface RawMessage {
  role: string;
  content: string | null;
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  toolCallId?: string;
  name?: string;
  reasoningContent?: string;
  /** 持久化的有序时间线（新格式）：text / reasoning_text / tool_call 按真实到达顺序混排 */
  segments?: ContentSegment[];
  timestamp?: number;
}

/**
 * 将后端返回的结构化消息数组（含 assistant/tool/user/system）转换为前端 ChatMessage 数组。
 *
 * 新格式：assistant 消息已带 segments 字段，直接使用，保持模型给出的真实交错顺序。
 * 老格式（无 segments）：fallback 到把 reasoning_text 全部前置 + content/tool_calls 后置，
 * 老数据无从恢复真实顺序，只能尽量好看。
 */
export function buildChatMessages(raw: RawMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let i = 0;

  while (i < raw.length) {
    const msg = raw[i];

    if (msg.role === 'user') {
      result.push({
        role: 'user',
        content: msg.content ?? '',
        timestamp: msg.timestamp ?? 0,
      });
      i++;
      continue;
    }

    if (msg.role === 'system') {
      // 系统事件消息（如压缩记录）→ 渲染为分隔线
      if (msg.name === 'system-event') {
        result.push({
          role: 'system',
          content: msg.content ?? '',
          timestamp: msg.timestamp ?? 0,
        });
      }
      // 其他 system 消息跳过（不展示）
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      // 收集连续的 assistant + tool 消息组成一个 ChatMessage
      const segments: ContentSegment[] = [];
      const reasoningOnly: ContentSegment[] = []; // 老格式 fallback：先收集 reasoning，最后前置
      let lastTimestamp = msg.timestamp ?? 0;
      let finalContent = '';
      // 新格式：若任意一条 assistant 已带 segments，则采用该完整时间线（覆盖之前老路径累积）
      let anyTimelineSegments = false;

      while (i < raw.length && (raw[i].role === 'assistant' || raw[i].role === 'tool')) {
        const cur = raw[i];

        if (cur.role === 'assistant' && cur.segments && cur.segments.length > 0) {
          // 新格式：assistant 自带统一时间线 segments，是整轮（含所有中间工具迭代）的规范权威时间线。
          // agent-default 在工具循环中会先以"老格式"保存中间 assistant + tool 消息，
          // 最后再保存一条带 turnSegments 的最终 assistant —— 这里直接覆盖之前累积，避免重复。
          anyTimelineSegments = true;
          segments.length = 0;
          reasoningOnly.length = 0;
          for (const seg of cur.segments) segments.push(seg);
          lastTimestamp = cur.timestamp ?? lastTimestamp;
          i++;
          continue;
        }

        if (cur.role === 'assistant' && cur.toolCalls && cur.toolCalls.length > 0) {
          // 老格式：带工具调用的 assistant
          if (cur.reasoningContent) {
            reasoningOnly.push({ type: 'reasoning_text', content: cur.reasoningContent });
          }
          if (cur.content) {
            segments.push({ type: 'text', content: cur.content });
          }
          for (const tc of cur.toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
            segments.push({ type: 'tool_call', name: tc.function.name, args });
          }
          lastTimestamp = cur.timestamp ?? lastTimestamp;
          i++;
        } else if (cur.role === 'tool' && cur.toolCallId) {
          // tool 结果：填充 segments 中最后一个未填的 tool_call
          for (let j = segments.length - 1; j >= 0; j--) {
            const s = segments[j];
            if (s.type === 'tool_call' && s.result === undefined) {
              s.result = cur.content ?? '';
              break;
            }
          }
          i++;
        } else if (cur.role === 'assistant') {
          // 无 toolCalls 的 assistant
          if (i === raw.length - 1 || raw[i + 1]?.role === 'user' || raw[i + 1]?.role === 'system') {
            // 最终回复
            if (cur.reasoningContent) {
              reasoningOnly.push({ type: 'reasoning_text', content: cur.reasoningContent });
            }
            finalContent = cur.content ?? '';
            lastTimestamp = cur.timestamp ?? lastTimestamp;
            i++;
            break;
          }
          // 中间 assistant
          if (cur.reasoningContent) {
            reasoningOnly.push({ type: 'reasoning_text', content: cur.reasoningContent });
          }
          if (cur.content) {
            segments.push({ type: 'text', content: cur.content });
          }
          lastTimestamp = cur.timestamp ?? lastTimestamp;
          i++;
        } else {
          break;
        }
      }

      // 拼装最终时间线：
      // - 新格式：直接使用规范权威时间线；archiveContent 与 segments 末尾文本可能不一致
      //   （如 persona 对 JSON 做了修复），此处选择忠实模型原始输出。
      // - 老格式：reasoning 前置 + 已收集 segments + finalContent
      let timeline: ContentSegment[];
      if (anyTimelineSegments) {
        timeline = segments;
      } else {
        timeline = [...reasoningOnly, ...segments];
        if (finalContent) timeline.push({ type: 'text', content: finalContent });
      }

      // 派生扁平 reasoningContent / content 镜像
      let mirrorReasoning = '';
      let mirrorContent = '';
      for (const s of timeline) {
        if (s.type === 'reasoning_text') mirrorReasoning += s.content;
        else if (s.type === 'text') mirrorContent += s.content;
      }

      result.push({
        role: 'assistant',
        content: mirrorContent || finalContent || msg.content || '',
        segments: timeline.length > 0 ? timeline : undefined,
        reasoningContent: mirrorReasoning || undefined,
        timestamp: lastTimestamp,
      });
      continue;
    }

    // 其他角色（tool 等如果出现在 assistant 组之外），跳过
    i++;
  }

  return result;
}

export interface SessionManager {
  pluginName: string | null;
  sessionList: SessionItem[];
  activeSessionId: string;
  /** 当前活跃会话的显示标题（无会话时返回空串） */
  activeSessionTitle: string;
  /** 是否处于"新对话"状态（还没有实际 session） */
  isNewChat: boolean;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  refresh: () => void;
  /** 进入"新对话"状态（清空消息，不立即建 session） */
  startNewChat: () => void;
  /** 创建新会话（可指定父会话），返回新 ID。会乐观更新列表。 */
  createSession: (parentId?: string) => Promise<string | null>;
  /** 确保有活跃会话（无会话时自动新建），返回会话 ID */
  ensureSession: () => Promise<string>;
  switchSession: (newId: string) => void;
  handleSessionSwitched: (sessionId: string) => void;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  streamingRef: React.MutableRefObject<boolean>;
}

export function useSessionManager(pageDefs: WebuiPageDef[]): SessionManager {
  const [sessionList, setSessionList] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(getSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const streamingRef = useRef(false);

  /** 消息缓存：sessionId → messages */
  const messagesCache = useRef<Map<string, ChatMessage[]>>(new Map());

  const pluginName = useMemo(() => {
    const page = pageDefs.find(p => p.key === 'sessions');
    return page?.plugin ?? null;
  }, [pageDefs]);

  // refs
  const pluginRef = useRef(pluginName);
  pluginRef.current = pluginName;
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sessionListRef = useRef(sessionList);
  sessionListRef.current = sessionList;

  /** 是否在"新对话"模式：activeSessionId 不在 sessionList 中 */
  const isNewChat = useMemo(() => {
    if (!pluginName) return false;
    return sessionList.length === 0 || !sessionList.some(s => s.id === activeSessionId);
  }, [pluginName, sessionList, activeSessionId]);

  const activeSessionTitle = useMemo(() => {
    const s = sessionList.find(s => s.id === activeSessionId);
    return s?.title || s?.displayTitle || s?.name || '';
  }, [sessionList, activeSessionId]);

  const refresh = useCallback(() => {
    const plugin = pluginRef.current;
    if (!plugin) return;
    pageAction<SessionItem[]>(plugin, 'listSessions')
      .then(list => { if (Array.isArray(list)) setSessionList(list); })
      .catch(() => {});
  }, []);

  /** 进入"新对话"状态 — 缓存当前消息，清空，不创建 session */
  const startNewChat = useCallback(() => {
    // 缓存当前消息
    if (messagesRef.current.length > 0) {
      messagesCache.current.set(activeIdRef.current, messagesRef.current);
    }
    // 用一个临时 ID 标记"新对话"
    const tempId = '__new_chat__';
    setActiveSessionId(tempId);
    setSessionId(tempId);
    setMessages([]);
    setLoading(false);
    streamingRef.current = false;
  }, []);

  /** 创建新会话，乐观更新列表 */
  const createSession = useCallback(async (parentId?: string): Promise<string | null> => {
    const plugin = pluginRef.current;
    if (!plugin) return null;
    const name = makeSessionName();
    try {
      const result = await pageAction<SessionItem>(plugin, 'createSession', {
        name,
        ...(parentId ? { parentId } : {}),
      });
      if (!result?.id) return null;
      const newId = result.id;
      // 乐观：立即把新会话加入列表
      setSessionList(prev => {
        // 如果已存在就不重复
        if (prev.some(s => s.id === newId)) return prev;
        const newItem: SessionItem = {
          id: newId,
          name: result.name || name,
          title: result.title,
          displayTitle: result.title || result.name || name,
          status: 'active',
          children: [],
          childCount: 0,
          parentId,
          createdAt: Date.now(),
        };
        return [...prev, newItem];
      });
      // 如果有 parentId，更新父节点的 children
      if (parentId) {
        setSessionList(prev => prev.map(s =>
          s.id === parentId ? { ...s, children: [...s.children, newId], childCount: s.childCount + 1 } : s
        ));
      }
      // 缓存当前消息，切换到新会话
      if (messagesRef.current.length > 0) {
        messagesCache.current.set(activeIdRef.current, messagesRef.current);
      }
      setActiveSessionId(newId);
      setSessionId(newId);
      setMessages([]);
      setLoading(false);
      streamingRef.current = false;
      // 通知服务端切换
      pageAction(plugin, 'switchSession', { id: newId }).catch(() => {});
      // 后台刷新以同步服务端数据
      pageAction<SessionItem[]>(plugin, 'listSessions')
        .then(list => { if (Array.isArray(list)) setSessionList(list); })
        .catch(() => {});
      return newId;
    } catch {
      return null;
    }
  }, []);

  /** 确保有活跃会话，否则自动新建 */
  const ensureSession = useCallback(async (): Promise<string> => {
    const plugin = pluginRef.current;
    if (!plugin) return activeIdRef.current;
    // 如果当前 ID 在列表中存在，直接返回
    if (sessionListRef.current.some(s => s.id === activeIdRef.current)) {
      return activeIdRef.current;
    }
    // 新建
    const newId = await createSession();
    return newId || activeIdRef.current;
  }, [createSession]);

  /** 从服务端拉取会话历史消息并更新状态 */
  const fetchAndSetMessages = useCallback((sessionId: string, plugin: string) => {
    pageAction<{ session: unknown; messages: RawMessage[] }>(plugin, 'getSessionDetail', { id: sessionId })
      .then(d => {
        if (d?.messages && activeIdRef.current === sessionId) {
          const msgs = buildChatMessages(d.messages);
          // 若刷新时正处于流式生成（stream_resume 已到达），
          // 服务端可能已持久化了一份部分 assistant；去掉它避免与本地在途消息重复。
          // 同时保留本地 state 尾部的在途 assistant，交由 handleStreamResume 后续合并。
          if (streamingRef.current) {
            // 剩去 fetched 尾部连续的 assistant + tool 消息（属于未完成的本轮）
            while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
              msgs.pop();
            }
            const local = messagesRef.current;
            const lastLocal = local[local.length - 1];
            if (lastLocal && lastLocal.role === 'assistant') {
              msgs.push(lastLocal);
            }
          }
          setMessages(msgs);
          messagesCache.current.set(sessionId, msgs);
        }
      })
      .catch(() => {});
  }, []);

  const switchSession = useCallback((newId: string) => {
    const isSameSession = newId === activeIdRef.current;
    // 同会话但已有消息，无需重复加载
    if (isSameSession && messagesRef.current.length > 0) return;
    if (!isSameSession && messagesRef.current.length > 0) {
      messagesCache.current.set(activeIdRef.current, messagesRef.current);
    }
    setActiveSessionId(newId);
    setSessionId(newId);
    setLoading(false);
    streamingRef.current = false;
    const plugin = pluginRef.current;
    // 先使用缓存，再从服务端拉取历史
    const cached = messagesCache.current.get(newId);
    setMessages(cached ?? []);
    if (!cached && plugin) {
      fetchAndSetMessages(newId, plugin);
    }
    if (!isSameSession && plugin) pageAction(plugin, 'switchSession', { id: newId }).catch(() => {});
    // 刷新 sessionList，确保新切换的会话能被 isNewChat / activeSessionTitle 正确识别
    refresh();
  }, [fetchAndSetMessages, refresh]);

  const handleSessionSwitched = useCallback((sessionId: string) => {
    if (sessionId !== activeIdRef.current) {
      switchSession(sessionId);
    }
  }, [switchSession]);

  // 初始化：获取服务端当前活跃会话并加载历史消息，同时拉取会话列表
  useEffect(() => {
    if (!pluginName) return;
    // 并行拉取活跃会话和会话列表，确保标题立即可用
    pageAction<SessionItem[]>(pluginName, 'listSessions')
      .then(list => { if (Array.isArray(list)) setSessionList(list); })
      .catch(() => {});
    pageAction<{ sessionId: string }>(pluginName, 'getActiveSession')
      .then(d => {
        if (d?.sessionId && d.sessionId !== '__new_chat__') {
          setActiveSessionId(d.sessionId);
          setSessionId(d.sessionId);
          // 加载该会话的历史消息
          fetchAndSetMessages(d.sessionId, pluginName);
        }
      })
      .catch(() => {});
  }, [pluginName, fetchAndSetMessages]);

  return {
    pluginName,
    sessionList,
    activeSessionId,
    activeSessionTitle,
    isNewChat,
    messages,
    setMessages,
    refresh,
    startNewChat,
    createSession,
    ensureSession,
    switchSession,
    handleSessionSwitched,
    loading,
    setLoading,
    streamingRef,
  };
}
