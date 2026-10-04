import type { SessionItem } from '@aalis/api-session-protocol';
import { FileText } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Picture } from '../components/Picture';
import { Markdown } from '../markdown/Markdown';
import { isWebUrl, mediaUrl } from '../media';
import { isRecord } from '../rest';
import './Attachments.css';

// 条目里的附件（提问、回复与通知带的成品同一种画法）：图片、音频、视频按媒体地址取，外站图片经图片代理；
// 其余是一行图标、名字与类型，有句柄的点开：文本类的在对话框里预览（Markdown 照常渲染、别的原样），其余直接下载；
// 没有句柄的只写名字

type Attachment = Extract<SessionItem, { kind: 'user-message' }>['attachments'][number];

/** 能在对话框里预览的文本类扩展名；Markdown 渲染出来，其余原样显示 */
const TEXT_TYPES = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'sql',
  'diff',
  'patch',
]);
const MARKDOWN_TYPES = new Set(['md', 'markdown']);
/** 预览最多读这么大，再大的只给下载 */
const PREVIEW_LIMIT_KB = 512;

const extensionOf = (name: string) => {
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at + 1).toLowerCase() : '';
};

export function Attachments({ attachments, sessionId }: { attachments: readonly Attachment[]; sessionId: string }) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((attachment, index) => (
        // 附件随条目整份替换，不会重排
        <AttachmentView key={index} attachment={attachment} sessionId={sessionId} />
      ))}
    </div>
  );
}

function AttachmentView({ attachment, sessionId }: { attachment: Attachment; sessionId: string }) {
  const { kind, src, name } = attachment;
  const media = src === undefined ? undefined : mediaUrl(src);
  if (kind === 'image' && src !== undefined && (media || isWebUrl(src))) {
    const url = media ?? `/api/proxy/image?${new URLSearchParams({ url: src })}`;
    return <Picture className="attachment-image" src={url} alt={name ?? '图片'} />;
  }
  // biome-ignore lint/a11y/useMediaCaption: 会话里收发的音视频没有字幕文件可配
  if (kind === 'audio' && media) return <audio className="attachment-media" controls src={media} />;
  // biome-ignore lint/a11y/useMediaCaption: 同上
  if (kind === 'video' && media) return <video className="attachment-media" controls src={media} />;
  if (kind === 'file' && src !== undefined) {
    return (
      <FileAttachment
        name={name ?? '文件'}
        href={`/api/session-file?${new URLSearchParams({ sessionId, handle: src })}`}
      />
    );
  }
  if (src !== undefined && isWebUrl(src)) {
    return (
      <a className="attachment-file" href={src} target="_blank" rel="noopener noreferrer">
        <FileLine name={name ?? src} />
      </a>
    );
  }
  return (
    <span className="attachment-file">
      <FileLine name={name ?? src ?? '附件'} />
    </span>
  );
}

/** 一行：图标、名字与类型（扩展名，没有时写「文件」） */
function FileLine({ name }: { name: string }) {
  const extension = extensionOf(name);
  return (
    <>
      <FileText aria-hidden />
      <span className="attachment-name">{name}</span>
      <span className="attachment-type">{extension ? extension.toUpperCase() : '文件'}</span>
    </>
  );
}

function FileAttachment({ name, href }: { name: string; href: string }) {
  const [previewing, setPreviewing] = useState(false);
  if (!TEXT_TYPES.has(extensionOf(name))) {
    return (
      <a className="attachment-file" href={href} download={name}>
        <FileLine name={name} />
      </a>
    );
  }
  return (
    <>
      <button type="button" className="attachment-file" onClick={() => setPreviewing(true)}>
        <FileLine name={name} />
      </button>
      {previewing && <FilePreview name={name} href={href} onClose={() => setPreviewing(false)} />}
    </>
  );
}

/** 读出文本：取不到的写服务端给的原因；超过上限或不是文本的不读完 */
async function readText(href: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(href, { signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `取不到（${response.status}）`);
  }
  if (!(Number(response.headers.get('Content-Length')) <= PREVIEW_LIMIT_KB * 1024)) {
    await response.body?.cancel();
    throw new Error(`文件超过 ${PREVIEW_LIMIT_KB} KB，下载后查看`);
  }
  const text = await response.text();
  if (text.includes('\u0000')) throw new Error('不是文本文件，下载后查看');
  return text;
}

function FilePreview({ name, href, onClose }: { name: string; href: string; onClose(): void }) {
  const [shown, setShown] = useState<{ text: string } | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    readText(href, controller.signal).then(
      text => setShown({ text }),
      (err: Error) => {
        if (!controller.signal.aborted) setShown({ error: err.message });
      },
    );
    return () => controller.abort();
  }, [href]);
  let body: ReactNode = <p>正在读取…</p>;
  if (shown && 'error' in shown) body = <p role="alert">{shown.error}</p>;
  else if (shown && MARKDOWN_TYPES.has(extensionOf(name))) body = <Markdown text={shown.text} />;
  else if (shown) body = <pre className="attachment-preview">{shown.text}</pre>;
  return (
    <Dialog
      open
      title={name}
      size="form"
      onClose={onClose}
      footer={
        <>
          <a className="button" href={href} download={name}>
            下载
          </a>
          <Button data-autofocus onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
