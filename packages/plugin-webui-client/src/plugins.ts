import { useEffect, useState } from 'react';
import { useConnection } from './connection';
import { getJson, isRecord } from './rest';

// 插件实例的显示名：会话设置「高级」里的分组名、用量里按插件合并的行名都取它。取自插件列表，插件登记表变了
// （plugins.changed）或管理连接重连后重取

export interface PluginInstance {
  /** 插件包名：同一插件的几个实例合在一起时按它认 */
  name: string;
  /** 显示名，没有时是包名 */
  label: string;
}

export interface PluginNames {
  instances: ReadonlyMap<string, PluginInstance>;
  error?: Error;
}

function parse(body: unknown): Map<string, PluginInstance> {
  const plugins = isRecord(body) ? body.plugins : undefined;
  if (!Array.isArray(plugins)) throw new Error('插件列表的回应不是预期的形状');
  const instances = new Map<string, PluginInstance>();
  for (const plugin of plugins) {
    if (!isRecord(plugin) || typeof plugin.instanceId !== 'string' || typeof plugin.name !== 'string') continue;
    const label = typeof plugin.displayName === 'string' && plugin.displayName ? plugin.displayName : plugin.name;
    instances.set(plugin.instanceId, { name: plugin.name, label });
  }
  return instances;
}

export function usePluginNames(): PluginNames {
  const { admin } = useConnection();
  const [names, setNames] = useState<PluginNames>({ instances: new Map() });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const refetch = () => setGeneration(n => n + 1);
    const offs = [admin.on('plugins.changed', refetch), admin.onReconnect(refetch)];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);

  useEffect(() => {
    const controller = new AbortController();
    getJson('/api/plugins', controller.signal)
      .then(parse)
      .then(
        instances => setNames({ instances }),
        (error: Error) => {
          if (!controller.signal.aborted) setNames(current => ({ ...current, error }));
        },
      );
    return () => controller.abort();
  }, [generation]);

  return names;
}
