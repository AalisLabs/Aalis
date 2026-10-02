import type { SessionMethodParams, SettingRow } from '@aalis/api-session-protocol';
import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { useToast } from '../components/Toast';
import { useConnectionState, useFeatures, useSessionClient } from '../connection';
import { composing } from '../keys';
import { effectiveOf, formatValue, hasChoices, valueKey, withCurrent } from '../settings/field';
import { useFieldOptions } from '../settings/options';
import './Composer.css';

// 输入框：Enter 发送、Shift+Enter 换行，输入法组字时的回车只上屏；触屏上回车换行，用按钮发送。附件一律接收，
// 只有附件也能发，读成 data URL 随消息发出。回合在跑、又没有要发的内容时，发送键换成停止。没有对话服务时不能用

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

interface ComposerProps {
  /** 发出一条消息；成功后清空输入，失败时原因写在输入框下面 */
  send(content: string, attachments: OutgoingAttachment[]): Promise<void>;
  /** 回合在跑：停止这一轮 */
  onStop?: () => void;
  /** 输入框左下的快捷切换 */
  switches?: ReactNode;
}

let nextFileId = 0;

export function Composer({ send, onStop, switches }: ComposerProps) {
  const features = useFeatures();
  const open = useConnectionState(useSessionClient()).status === 'open';
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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

  return (
    <form
      className="composer"
      aria-label="发消息"
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
          <Button icon={Square} onClick={onStop}>
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
  /** 不能在这里选的设置项点了去会话的「设置」标签 */
  settingsPath: string;
}

/** 输入框旁的快捷切换：composer 档的设置项，能从选项里选的就地选，改了即存 */
export function ComposerSettings({ rows, update, settingsPath }: ComposerSettingsProps) {
  return rows
    .filter(row => row.prominence === 'composer')
    .map(row => {
      if (hasChoices(row.field)) return <SettingSelect key={row.key} row={row} update={update} />;
      const effective = effectiveOf(row);
      return (
        <Link key={row.key} className="composer-setting" to={settingsPath}>
          {row.field.label}：{effective === undefined ? '未设置' : formatValue(row.field, effective)}
        </Link>
      );
    });
}

function SettingSelect({ row, update }: { row: SettingRow; update: ComposerSettingsProps['update'] }) {
  const { field } = row;
  const toast = useToast();
  const { options, error } = useFieldOptions(field);
  const current = effectiveOf(row);
  const choices = withCurrent(field, options, current);
  const failed = error && `可选项没取到：${error.message}`;
  return (
    <select
      className="composer-setting"
      aria-label={field.label}
      title={failed}
      value={current === undefined ? '' : valueKey(field, current)}
      onChange={event => {
        const chosen = choices.find(option => option.key === event.target.value);
        if (!chosen) return;
        update(row.key, chosen.value).catch((err: Error) =>
          toast({ kind: 'error', text: `${field.label}没改成：${err.message}` }),
        );
      }}
    >
      {current === undefined && (
        <option value="" disabled>
          {field.label}
        </option>
      )}
      {choices.map(option => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
      {failed && <option disabled>{failed}</option>}
    </select>
  );
}
