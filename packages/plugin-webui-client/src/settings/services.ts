import { useEffect, useReducer } from 'react';
import { useConnection } from '../connection';
import { isRecord, useJson } from '../rest';

// 服务列表（GET /api/services）：设置的「系统」与插件详情的服务偏好都读它。插件启停、管理连接重连后重取

interface ServiceView {
  name: string;
  /** 按全局的解析先后：第一个是全局选中的 */
  providers: Array<{ contextId: string; label: string }>;
  /** 全局偏好 */
  preferred: string | null;
}

function parseServices(body: unknown): ServiceView[] {
  if (!isRecord(body) || !isRecord(body.services)) throw new Error('服务列表的回应不是预期的形状');
  return Object.entries(body.services).flatMap(([name, detail]) => {
    if (!isRecord(detail) || !Array.isArray(detail.providers)) return [];
    const providers = detail.providers.filter(isRecord).flatMap(provider => {
      if (typeof provider.contextId !== 'string') return [];
      const label = [provider.displayName, provider.label].find(text => typeof text === 'string' && text !== '');
      return [{ contextId: provider.contextId, label: (label as string | undefined) ?? provider.contextId }];
    });
    return [{ name, providers, preferred: typeof detail.preferred === 'string' ? detail.preferred : null }];
  });
}

export function useServices() {
  const { admin } = useConnection();
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { value, error } = useJson('/api/services', parseServices, version);
  useEffect(() => {
    const offs = [admin.on('plugins.changed', refetch), admin.onReconnect(refetch)];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);
  return { services: value, error, refetch };
}
