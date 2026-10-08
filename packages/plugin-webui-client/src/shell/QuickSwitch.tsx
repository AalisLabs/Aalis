import type { RoomGroup, SessionSummary } from '@aalis/api-session-protocol';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useSessionClient, useSessionless } from '../connection';
import { composing } from '../keys';
import { pageAddress, pageName, usePages, withInstance } from '../pages/registry';
import { labelOf, usePluginNames, usePlugins } from '../plugins/list';
import { statusOf } from '../plugins/status';
import { addressOf, inGroup, paths } from '../routes';
import './QuickSwitch.css';

// 快速切换：会话由会话服务按名称、id 与「平台:群号」搜（根会话，不含已归档的）；输入了字时另按名字找有自己地址的页面
// （位置为插件详情或设置的）与插件（显示名、包名、实例 id），不分大小写。三组依次列出，方向键跨组选、回车打开；
// 会话服务不在时只找页面与插件

const RESULT_LIMIT = 20;

interface Found {
  sessions: SessionSummary[];
  groups: RoomGroup[];
}

/** 一项结果：名字、后面那句出处与去处 */
interface Option {
  key: string;
  title: string;
  where?: string;
  to: string;
}

function where(session: SessionSummary, groups: RoomGroup[]): string {
  if (session.kind === 'owner') return '我的';
  const group = groups.find(g => inGroup(session, addressOf(g)));
  return group?.label ?? session.platform ?? '';
}

export function QuickSwitch({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} title="搜索" onClose={onClose}>
      {open && <Search onClose={onClose} />}
    </Dialog>
  );
}

function Search({ onClose }: { onClose(): void }) {
  const client = useSessionClient();
  const sessionless = useSessionless();
  const { pages, pagesError } = usePages();
  const { plugins, error: pluginsError } = usePlugins();
  const { instances } = usePluginNames();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found>();
  const [error, setError] = useState<Error>();
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stale = false;
    client.request('sessions/list', { query: query.trim() || undefined, limit: RESULT_LIMIT }).then(
      next => {
        if (stale) return;
        setFound(next);
        setError(undefined);
        setActive(0);
      },
      (err: Error) => {
        if (!stale) setError(err);
      },
    );
    return () => {
      stale = true;
    };
  }, [client, query]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = (...texts: string[]) => texts.some(text => text.toLocaleLowerCase().includes(needle));
  const sections = [
    {
      label: '会话',
      options: (found?.sessions ?? []).map(
        (session): Option => ({
          key: session.id,
          title: session.title,
          where: where(session, found?.groups ?? []),
          to: paths.session(session.id),
        }),
      ),
    },
    {
      label: '页面',
      options: needle
        ? (pages ?? [])
            .flatMap((page): Option[] => {
              const to = pageAddress(page);
              const title = pageName(page);
              return to && matches(title) ? [{ key: to, title, where: instances.get(page.instance)?.label, to }] : [];
            })
            .slice(0, RESULT_LIMIT)
        : [],
    },
    {
      label: '插件',
      options: needle
        ? (plugins ?? [])
            .filter(row => matches(labelOf(row), row.name, row.instanceId))
            .slice(0, RESULT_LIMIT)
            .map((row): Option => {
              const status = statusOf(row);
              return {
                key: row.instanceId,
                title: withInstance(labelOf(row), row.instanceId),
                where: status.state && status.short,
                to: paths.plugin(row.instanceId),
              };
            })
        : [],
    },
  ].filter(section => section.options.length > 0);
  const options = sections.flatMap(section => section.options);
  const current = Math.min(active, options.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  const notes = [
    error && `会话没取到：${error.message}`,
    needle && !pages && pagesError && `页面表没取到：${pagesError.message}`,
    needle && !plugins && pluginsError && `插件列表没取到：${pluginsError.message}`,
  ].filter((note): note is string => Boolean(note));
  // 会话服务不在时会话的搜索等它回来，页面与插件照样有结果
  const settled = sessionless || found !== undefined || error !== undefined;

  const choose = (option: Option) => {
    onClose();
    navigate(option.to);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (options.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter' && !composing(event.nativeEvent)) {
      event.preventDefault();
      choose(options[current]);
    }
  };

  return (
    <div className="quick-switch">
      <input
        type="search"
        role="combobox"
        aria-label="搜索会话、页面与插件"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-activedescendant={options.length > 0 ? optionId(current) : undefined}
        placeholder="会话、页面或插件"
        value={query}
        data-autofocus
        onChange={event => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {notes.map(note => (
        <p key={note} className="quick-switch-note" role="alert">
          {note}
        </p>
      ))}
      {settled && options.length === 0 && notes.length === 0 && <p className="quick-switch-note">没有找到</p>}
      <div id={listId} role="listbox" aria-label="搜索结果" className="quick-switch-results">
        {sections.map(section => (
          // biome-ignore lint/a11y/useSemanticElements: 列表框里的一组选项只能用 role="group"，fieldset 是表单控件的分组
          <div key={section.label} role="group" aria-label={section.label} className="quick-switch-group">
            <div className="section-heading quick-switch-heading" aria-hidden>
              {section.label}
            </div>
            {section.options.map(option => {
              const index = options.indexOf(option);
              return (
                <button
                  key={option.key}
                  type="button"
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === current}
                  tabIndex={-1}
                  className="quick-switch-option"
                  onClick={() => choose(option)}
                  onMouseMove={() => setActive(index)}
                >
                  <span className="quick-switch-title">{option.title}</span>
                  {option.where && <span className="quick-switch-where">{option.where}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
