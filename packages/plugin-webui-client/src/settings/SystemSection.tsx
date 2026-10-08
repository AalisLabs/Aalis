import { useEffect, useReducer, useState } from 'react';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { FetchError } from '../components/FetchError';
import { useToast } from '../components/Toast';
import { useConnection } from '../connection';
import { useHost } from '../plugins/list';
import { deleteJson, isRecord, postJson, putJson, useJson } from '../rest';
import type { Field } from './field';
import { SettingRow } from './SettingRow';

// 设置的「系统」：宿主配置的核心键（来源是配置文件或默认，要重启的键写明，改了之后出「重启以生效」与重启按钮）、
// 服务偏好（有几个提供者的服务选用哪一个，界面前端也在其中）与家目录

const PREFERENCES_NOTE =
  '同一个服务有几个提供者时选用哪一个，改了立即生效。界面前端（webui-client）也在其中，换了以后页面会重新加载；' +
  '新的前端用不了时，打开 /__clients 切回来。';

interface HostConfigView {
  /** 配置文件里写了的核心键 */
  config: Record<string, unknown>;
  schema: Record<string, Field>;
  restartKeys: string[];
  home?: string;
}

function parseHostConfig(body: unknown): HostConfigView {
  if (!isRecord(body) || !isRecord(body.config) || !isRecord(body.schema) || !Array.isArray(body.restartKeys)) {
    throw new Error('宿主配置的回应不是预期的形状');
  }
  return {
    config: body.config,
    schema: Object.fromEntries(
      Object.entries(body.schema).filter(
        (entry): entry is [string, Field] =>
          isRecord(entry[1]) && typeof entry[1].type === 'string' && typeof entry[1].label === 'string',
      ),
    ),
    restartKeys: body.restartKeys.filter(key => typeof key === 'string'),
    home: typeof body.home === 'string' ? body.home : undefined,
  };
}

interface ServiceView {
  name: string;
  /** 按解析的先后：第一个就是正在用的 */
  providers: Array<{ contextId: string; label: string }>;
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

export function SystemSection() {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { value, error } = useJson('/api/config', parseHostConfig, version);
  const host = useHost();
  return (
    <div className="page-screen settings-screen">
      {error && <FetchError what="宿主配置" error={error} retry={refetch} stale={value !== undefined} source={host} />}
      {value && <HostConfig view={value} saved={refetch} />}
      <ServicePreferences />
      {value?.home && (
        <Block title="家目录">
          <p className="settings-path">{value.home}</p>
          <p className="settings-note">配置文件、密钥、插件的数据与日志都在这里。</p>
        </Block>
      )}
    </div>
  );
}

function HostConfig({ view, saved }: { view: HostConfigView; saved(): void }) {
  const toast = useToast();
  const host = useHost();
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const written = (key: string) => Object.hasOwn(view.config, key);
  const save = (key: string) => async (value: unknown) => {
    const reply = await putJson('/api/config', { [key]: value });
    saved();
    if (isRecord(reply) && reply.restartNeeded === true) setRestartNeeded(true);
  };
  const restart = () => {
    setRestarting(true);
    postJson('/api/restart', {}).catch((err: Error) => {
      setRestarting(false);
      toast({ kind: 'danger', text: err.message, source: host });
    });
  };
  return (
    <Block title="宿主配置">
      {restartNeeded && (
        <div className="settings-restart" role="status">
          <span>改动重启以生效</span>
          <Button variant="primary" busy={restarting} onClick={restart}>
            重启
          </Button>
        </div>
      )}
      <div className="settings-rows">
        {Object.entries(view.schema).map(([key, field]) => (
          <SettingRow
            key={key}
            field={field}
            value={written(key) ? view.config[key] : field.default}
            source={written(key) ? '配置文件' : '默认'}
            timing={view.restartKeys.includes(key) ? '重启后生效' : undefined}
            reset={written(key) ? '恢复默认' : undefined}
            save={save(key)}
          />
        ))}
      </div>
    </Block>
  );
}

/** 有几个提供者（或写过偏好）的服务：选用哪一个，改了立即生效并写进配置文件。插件启停、管理连接重连后重取 */
function ServicePreferences() {
  const { admin } = useConnection();
  const host = useHost();
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { value, error } = useJson('/api/services', parseServices, version);
  useEffect(() => {
    const offs = [admin.on('plugins.changed', refetch), admin.onReconnect(refetch)];
    return () => {
      for (const off of offs) off();
    };
  }, [admin]);
  const services = (value ?? []).filter(service => service.providers.length > 1 || service.preferred !== null);
  if (!error && services.length === 0) return null;
  const base = (name: string) => `/api/services/${encodeURIComponent(name)}/prefer`;
  const save = (name: string) => async (contextId: unknown) => {
    await (contextId === null ? deleteJson(base(name)) : postJson(base(name), { contextId }));
    refetch();
  };
  return (
    <Block title="服务偏好">
      <p className="settings-note">{PREFERENCES_NOTE}</p>
      {error && (
        <FetchError what="服务列表" error={error} retry={refetch} stale={value !== undefined} inline source={host} />
      )}
      <div className="settings-rows">
        {services.map(service => {
          const preferred = service.providers.some(provider => provider.contextId === service.preferred);
          return (
            <SettingRow
              key={service.name}
              field={{
                type: 'select',
                label: service.name,
                options: service.providers.map(provider => ({ label: provider.label, value: provider.contextId })),
              }}
              value={service.providers[0]?.contextId}
              source={preferred ? '服务偏好' : '默认'}
              reset={service.preferred === null ? undefined : '恢复默认'}
              save={save(service.name)}
            />
          );
        })}
      </div>
    </Block>
  );
}
