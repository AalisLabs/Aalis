import { useReducer, useState } from 'react';
import { Block } from '../components/Block';
import { Button } from '../components/Button';
import { FetchError } from '../components/FetchError';
import { useToast } from '../components/Toast';
import { tr } from '../language';
import { useHost } from '../plugins/list';
import { deleteJson, isRecord, postJson, putJson, useJson } from '../rest';
import type { Field } from './field';
import { SettingRow } from './SettingRow';
import { useServices } from './services';

// 设置的「系统」：宿主配置的核心键（来源是配置文件或默认，要重启的键写明，改了之后出「重启以生效」与重启按钮）、
// 服务偏好（全局偏好：有几个提供者的服务选用哪一个，界面前端与模型服务也在其中）与数据目录

interface HostConfigView {
  /** 配置文件里写了的核心键 */
  config: Record<string, unknown>;
  schema: Record<string, Field>;
  restartKeys: string[];
  dataDir?: string;
}

function parseHostConfig(body: unknown): HostConfigView {
  if (!isRecord(body) || !isRecord(body.config) || !isRecord(body.schema) || !Array.isArray(body.restartKeys)) {
    throw new Error(tr('hostConfigMalformed'));
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
    dataDir: typeof body.dataDir === 'string' ? body.dataDir : undefined,
  };
}

export function SystemSection() {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { value, error } = useJson('/api/config', parseHostConfig, version);
  const host = useHost();
  return (
    <div className="page-screen settings-screen">
      {error && (
        <FetchError
          what={tr('hostConfiguration')}
          error={error}
          retry={refetch}
          stale={value !== undefined}
          source={host}
        />
      )}
      {value && <HostConfig view={value} saved={refetch} />}
      <ServicePreferences />
      {value?.dataDir && (
        <Block title={tr('dataDirectory')}>
          <p className="settings-path">{value.dataDir}</p>
          <p className="settings-note">{tr('dataDirectoryNote')}</p>
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
    <Block title={tr('hostConfiguration')}>
      {restartNeeded && (
        <div className="settings-restart" role="status">
          <span>{tr('restartToApply')}</span>
          <Button variant="primary" busy={restarting} onClick={restart}>
            {tr('restartApp')}
          </Button>
        </div>
      )}
      <div className="settings-rows">
        {Object.entries(view.schema).map(([key, field]) => (
          <SettingRow
            key={key}
            field={field}
            value={written(key) ? view.config[key] : field.default}
            source={written(key) ? tr('configFile') : tr('sourceDefault')}
            timing={view.restartKeys.includes(key) ? tr('appliesAfterRestart') : undefined}
            reset={written(key) ? tr('resetDefault') : undefined}
            save={save(key)}
          />
        ))}
      </div>
    </Block>
  );
}

/** 有几个提供者（或写过偏好）的服务：选用哪一个，改了立即生效并写进配置文件。插件启停、管理连接重连后重取 */
function ServicePreferences() {
  const host = useHost();
  const { services: value, error, refetch } = useServices();
  const services = (value ?? []).filter(service => service.providers.length > 1 || service.preferred !== null);
  if (!error && services.length === 0) return null;
  const base = (name: string) => `/api/services/${encodeURIComponent(name)}/prefer`;
  const save = (name: string) => async (contextId: unknown) => {
    await (contextId === null ? deleteJson(base(name)) : postJson(base(name), { contextId }));
    refetch();
  };
  return (
    <Block title={tr('servicePreferences')}>
      <p className="settings-note">{tr('servicePreferencesHostNote')}</p>
      {error && (
        <FetchError
          what={tr('serviceList')}
          error={error}
          retry={refetch}
          stale={value !== undefined}
          inline
          source={host}
        />
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
              source={preferred ? tr('servicePreferences') : tr('sourceDefault')}
              reset={service.preferred === null ? undefined : tr('resetDefault')}
              save={save(service.name)}
            />
          );
        })}
      </div>
    </Block>
  );
}
