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
  timestamp?: number;
}

/**
 * 将后端返回的结构化消息数组（含 assistant/tool/user/system）转换为前端 ChatMessage 数组。
 * 连续的 assistant + tool 消息组合为一个 ChatMessage，
 * 思考内容（reasoningContent）与工具调用交织构建为 reasoningSegments，
 * 最终回复文本放入 segments。
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
      const reasoningSegments: ContentSegment[] = [];
      // 跟踪已收集的中间 reasoning 文本，用于去重旧格式 combined reasoning
      const intermediateReasonings: string[] = [];
      let lastTimestamp = msg.timestamp ?? 0;
      let finalContent = '';

      while (i < raw.length && (raw[i].role === 'assistant' || raw[i].role === 'tool')) {
        const cur = raw[i];

        if (cur.role === 'assistant' && cur.toolCalls && cur.toolCalls.length > 0) {
          // 带工具调用的 assistant 消息
          // 有 reasoningContent → 归入 reasoningSegments（思考阶段）；否则归入 segments（普通内容）
          const target = cur.reasoningContent ? reasoningSegments : segments;
          if (cur.reasoningContent) {
            reasoningSegments.push({ type: 'text', content: cur.reasoningContent });
            intermediateReasonings.push(cur.reasoningContent);
          }
          if (cur.content) {
            target.push({ type: 'text', content: cur.content });
          }
          for (const tc of cur.toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* ignore */ }
            target.push({ type: 'tool_call', name: tc.function.name, args });
          }
          lastTimestamp = cur.timestamp ?? lastTimestamp;
          i++;
        } else if (cur.role === 'tool' && cur.toolCallId) {
          // tool 结果消息：优先在 reasoningSegments 中查找未填充的 tool_call，再查 segments
          const segR = reasoningSegments.findLast(
            s => s.type === 'tool_call' && s.result === undefined
          );
          if (segR && segR.type === 'tool_call') {
            segR.result = cur.content ?? '';
          } else {
            const segS = segments.findLast(
              s => s.type === 'tool_call' && s.result === undefined
            );
            if (segS && segS.type === 'tool_call') {
              segS.result = cur.content ?? '';
            }
          }
          i++;
        } else if (cur.role === 'assistant') {
          // 无 toolCalls 的 assistant 消息
          if (i === raw.length - 1 || raw[i + 1]?.role === 'user' || raw[i + 1]?.role === 'system') {
            // 最终回复：提取新增的 reasoning（兼容旧格式 combined reasoning）
            if (cur.reasoningContent) {
              if (intermediateReasonings.length > 0) {
                // 旧格式可能存的是 combined reasoning，需要去重
                const prefix = intermediateReasonings.join('\n\n---\n\n');
                if (cur.reasoningContent.startsWith(prefix)) {
                  let remainder = cur.reasoningContent.substring(prefix.length);
                  if (remainder.startsWith('\n\n---\n\n')) {
                    remainder = remainder.substring('\n\n---\n\n'.length);
                  }
                  if (remainder.trim()) {
                    reasoningSegments.push({ type: 'text', content: remainder });
                  }
                } else {
                  // 新格式：独立 reasoning，直接添加
                  reasoningSegments.push({ type: 'text', content: cur.reasoningContent });
                }
              } else {
                reasoningSegments.push({ type: 'text', content: cur.reasoningContent });
              }
            }
            finalContent = cur.content ?? '';
            lastTimestamp = cur.timestamp ?? lastTimestamp;
            i++;
            break;
          }
          // 中间 assistant 消息（无工具调用）
          if (cur.reasoningContent) {
            reasoningSegments.push({ type: 'text', content: cur.reasoningContent });
            intermediateReasonings.push(cur.reasoningContent);
            if (cur.content) {
              reasoningSegments.push({ type: 'text', content: cur.content });
            }
          } else if (cur.content) {
            segments.push({ type: 'text', content: cur.content });
          }
          lastTimestamp = cur.timestamp ?? lastTimestamp;
          i++;
        } else {
          break;
        }
      }

      // 如果 reasoningSegments 中没有任何 text 段（无 reasoning），
      // 将工具调用移回 segments（兼容非 reasoning 模型）
      const hasReasoningText = reasoningSegments.some(s => s.type === 'text');
      if (!hasReasoningText && reasoningSegments.length > 0) {
        segments.push(...reasoningSegments);
        reasoningSegments.length = 0;
      }

      // 构建合并 reasoningContent 字符串（用于无 segments 的兼容渲染）
      const allReasoningTexts = reasoningSegments
        .filter((s): s is Extract<ContentSegment, { type: 'text' }> => s.type === 'text')
        .map(s => s.content);
      const reasoningContent = allReasoningTexts.length > 0
        ? allReasoningTexts.join('\n\n---\n\n')
        : undefined;

      if (finalContent) {
        segments.push({ type: 'text', content: finalContent });
      }

      result.push({
        role: 'assistant',
        content: finalContent || msg.content || '',
        segments: segments.length > 0 ? segments : undefined,
        reasoningContent,
        reasoningSegments: reasoningSegments.length > 0 ? reasoningSegments : undefined,
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
