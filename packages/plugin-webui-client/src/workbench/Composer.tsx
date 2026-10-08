import type { SessionMethodParams, SettingRow } from '@aalis/api-session-protocol';
import { ArrowUp, CircleStop, FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { useConnectionState, useFeatures, useSessionClient } from '../connection';
import { composing } from '../keys';
import { SESSION_PROTOCOL, useProvider } from '../plugins/list';
import {
  dependencyOf,
  effectiveOf,
  formatValue,
  hasChoices,
  type Option,
  optionLabel,
  valueKey,
  withCurrent,
} from '../settings/field';
import { useFieldOptions } from '../settings/options';
import { useDraft } from './drafts';
import './Composer.css';

// 输入框：Enter 发送、Shift+Enter 换行，输入法组字时的回车只上屏；触屏上回车换行，用按钮发送。附件一律接收，
// 只有附件也能发，读成 data URL 随消息发出；附件按钮、粘贴与把文件拖到这一栏里是同一条路。回合在跑、又没有要发的内容时，
// 发送键换成停止。没有对话服务时不能用。打的字按会话存成草稿，状态留在输入框里，打字不牵动会话的其余部分

export type OutgoingAttachment = NonNullable<SessionMethodParams<'turn/send'>['attachments']>[number];

/** 一条消息的附件合计上限：发出的帧要在连接的帧上限之内（data URL 比原文件大三分之一） */
const ATTACHMENTS_LIMIT_MB = 64;

interface PendingFile {
  id: number;
  name: string;
  size: number;
  /** 读完以后才有 */
  attachment?: OutgoingAttachment;
}

const kindOf = (type: string): OutgoingAttachment['kind'] =>
  type.startsWith('image/')
    ? 'image'
    : type.startsWith('audio/')
      ? 'audio'
      : type.startsWith('video/')
        ? 'video'
        : 'file';

function read(file: File): Promise<OutgoingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        kind: kindOf(file.type),
        data: String(reader.result),
        name: file.name,
        byteSize: file.size,
        ...(file.type ? { mimeType: file.type } : {}),
      });
    reader.onerror = () => reject(reader.error ?? new Error(`读不出 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** 连对话一起回滚之后，把那一轮的提问放回输入框，放在已打的字前面 */
export interface ComposerHandle {
  restore(prompt: string): void;
}

interface ComposerProps {
  /** 草稿按它存，首页的新会话是 NEW_SESSION */
  sessionId: string;
  /** 发出一条消息；成功后清空输入，失败时原因写在输入框下面 */
  send(content: string, attachments: OutgoingAttachment[]): Promise<void>;
  /** 回合在跑：停止这一轮 */
  onStop?: () => void;
  /** 输入框左下的快捷切换 */
  switches?: ReactNode;
  ref?: Ref<ComposerHandle>;
}

let nextFileId = 0;

export function Composer({ sessionId, send, onStop, switches, ref }: ComposerProps) {
  const [text, setText] = useDraft(sessionId);
  useImperativeHandle(
    ref,
    () => ({ restore: prompt => setText(current => (current.trim() ? `${prompt}\n\n${current}` : prompt)) }),
    [setText],
  );
  const features = useFeatures();
  const open = useConnectionState(useSessionClient()).status === 'open';
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dropping, setDropping] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // 连接断开时由连接横条或会话区写明原因，这里只写没有对话服务
  const disabled = !open || !features.send;
  const empty = !text.trim() && files.length === 0;
  const ready = files.every(file => file.attachment !== undefined);

  const add = (list: Iterable<File>) => {
    const added = [...list];
    const total = [...files, ...added].reduce((sum, file) => sum + file.size, 0);
    if (total > ATTACHMENTS_LIMIT_MB * 1024 * 1024) {
      setError(`一条消息的附件合计不能超过 ${ATTACHMENTS_LIMIT_MB} MB，这次选的没有加上`);
      return;
    }
    setError(undefined);
    for (const file of added) {
      const id = ++nextFileId;
      setFiles(current => [...current, { id, name: file.name, size: file.size }]);
      read(file).then(
        attachment => setFiles(current => current.map(item => (item.id === id ? { ...item, attachment } : item))),
        (err: Error) => {
          setFiles(current => current.filter(item => item.id !== id));
          setError(err.message);
        },
      );
    }
  };

  const submit = () => {
    if (disabled || busy || empty || !ready) return;
    const sentIds = new Set(files.map(file => file.id));
    setBusy(true);
    setError(undefined);
    send(
      text.trim(),
      files.map(file => file.attachment as OutgoingAttachment),
    )
      .then(() => {
        // 只清掉发出去的：在途时接着打的字、新加的附件留着
        setText(current => (current === text ? '' : current));
        setFiles(current => current.filter(file => !sentIds.has(file.id)));
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      composing(event.nativeEvent) ||
      matchMedia('(pointer: coarse)').matches
    )
      return;
    event.preventDefault();
    submit();
  };

  const onPaste = (event: ClipboardEvent) => {
    if (event.clipboardData.files.length === 0) return;
    event.preventDefault();
    add(event.clipboardData.files);
  };

  // 文件拖到输入框所在的这一栏（会话的时间线与输入框）里就成为附件。不能用时也拦下默认处理，免得浏览器离开页面去打开文件
  const addDropped = useRef(add);
  const usable = useRef(!disabled);
  useEffect(() => {
    addDropped.current = add;
    usable.current = !disabled;
  });
  useEffect(() => {
    const column = form.current?.closest<HTMLElement>('.panel');
    if (!column) return;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (usable.current) setDropping(true);
    };
    const leave = (event: DragEvent) => {
      if (!column.contains(event.relatedTarget as Node | null)) setDropping(false);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDropping(false);
      if (usable.current) addDropped.current(event.dataTransfer?.files ?? []);
    };
    column.addEventListener('dragover', over);
    column.addEventListener('dragleave', leave);
    column.addEventListener('drop', drop);
    return () => {
      column.removeEventListener('dragover', over);
      column.removeEventListener('dragleave', leave);
      column.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <form
      ref={form}
      className="composer"
      aria-label="发消息"
      data-dropping={(dropping && !disabled) || undefined}
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      {files.length > 0 && (
        <ul className="composer-files" aria-label="附件">
          {files.map(file => (
            <li key={file.id}>
              {file.attachment ? <FileText aria-hidden /> : <LoaderCircle aria-hidden className="spin" />}
              <span className="composer-file-name">{file.name}</span>
              <IconButton
                icon={X}
                label={`移除 ${file.name}`}
                onClick={() => setFiles(current => current.filter(item => item.id !== file.id))}
              />
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="消息"
        placeholder={disabled ? undefined : '发消息'}
        rows={2}
        value={text}
        disabled={disabled}
        onChange={event => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="composer-bar">
        <IconButton icon={Paperclip} label="添加附件" disabled={disabled} onClick={() => picker.current?.click()} />
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={event => {
            if (event.target.files) add(event.target.files);
            event.target.value = '';
          }}
        />
        {switches}
        <span className="composer-spacer" />
        {onStop && empty ? (
          <Button icon={CircleStop} onClick={onStop}>
            停止
          </Button>
        ) : (
          <Button variant="primary" type="submit" icon={ArrowUp} busy={busy} disabled={disabled || empty || !ready}>
            发送
          </Button>
        )}
      </div>
      {open && !features.send && <p className="composer-note">没有对话服务，暂时不能发消息</p>}
      {error && (
        <p className="composer-note" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

interface ComposerSettingsProps {
  rows: readonly SettingRow[];
  update(key: string, value: unknown): Promise<void>;
  /** 不能在这里选的设置项点了去会话的「设置」标签：链接写它的地址，点按交给 openSettings（标签关着时先打开） */
  settingsPath: string;
  openSettings(): void;
}

/** 输入框旁的快捷切换：composer 档的设置项只写值，名字在读屏标签与悬停提示里；能从选项里选的就地选，改了即存 */
export function ComposerSettings({ rows, update, settingsPath, openSettings }: ComposerSettingsProps) {
  return rows
    .filter(row => row.prominence === 'composer')
    .map(row =>
      hasChoices(row.field) ? (
        <SettingSelect key={row.key} row={row} dependency={dependencyOf(rows, row)?.value} update={update} />
      ) : (
        <SettingLink
          key={row.key}
          row={row}
          dependency={dependencyOf(rows, row)?.value}
          settingsPath={settingsPath}
          openSettings={openSettings}
        />
      ),
    );
}

/**
 * 不能就地选的项写生效值（按可选项的标签），没有值时写登记方给的「没设时」，都没有才写名字；点了去会话的「设置」标签。
 * 样子与就地选的选择器一样，只是不带箭头
 */
function SettingLink({
  row,
  dependency,
  settingsPath,
  openSettings,
}: { row: SettingRow; dependency: unknown } & Pick<ComposerSettingsProps, 'settingsPath' | 'openSettings'>) {
  const { options, names } = useFieldOptions(row.field, 0, dependency);
  const effective = effectiveOf(row);
  const shown = effective === undefined ? row.unset : formatValue(row.field, effective, [...options, ...names]);
  const name = shown === undefined ? row.field.label : `${row.field.label}：${shown}`;
  return (
    <Link
      className="select"
      data-variant="bare"
      to={settingsPath}
      aria-label={name}
      title={name}
      onClick={event => {
        // 不是左键、按着修饰键的交给浏览器（新标签页、新窗口打开），与链接自己的判定一致
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openSettings();
      }}
    >
      <span className="select-value">{shown ?? row.field.label}</span>
    </Link>
  );
}

/** 可选项没取到时列在选项末尾、不能选的一项 */
const FAILED = '\u0000failed';

function SettingSelect({
  row,
  dependency,
  update,
}: {
  row: SettingRow;
  dependency: unknown;
  update: ComposerSettingsProps['update'];
}) {
  const { field } = row;
  const toast = useToast();
  const sessions = useProvider(SESSION_PROTOCOL);
  const { options, names, error } = useFieldOptions(field, 0, dependency);
  const current = effectiveOf(row);
  const choices = withCurrent(field, options, current, names);
  const fallback = options.find(option => option.isDefault);
  const failed = error && `可选项没取到：${error.message}`;
  return (
    <Select
      variant="bare"
      aria-label={field.label}
      title={failed || field.label}
      value={current === undefined ? '' : valueKey(field, current)}
      placeholder={fallback ? optionLabel(fallback) : (row.unset ?? field.label)}
      options={[
        ...choices.map(option => ({ value: option.key, label: optionLabel(option) })),
        ...(failed ? [{ value: FAILED, label: failed, disabled: true }] : []),
      ]}
      onChange={key => {
        const chosen = choices.find(option => option.key === key) as Option;
        update(row.key, chosen.value).catch((err: Error) =>
          toast({ kind: 'danger', text: `${field.label}没改成：${err.message}`, source: sessions }),
        );
      }}
    />
  );
}
