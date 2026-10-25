import { decodeUtf8Text } from '@aalis/util-file-signature';
import { FileText } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Picture } from '../components/Picture';
import { download } from '../download';
import { tr } from '../language';
import { Markdown } from '../markdown/Markdown';
import { isWebUrl, mediaUrl } from '../media';
import type { SessionItem } from '../protocol/session-client';
import { isRecord } from '../rest';
import './Attachments.css';

// 条目里的附件（提问、回复与通知带的成品同一种画法）：图片、音频、视频按媒体地址取，外站图片经图片代理；
// 其余是一行图标、名字与类型，有句柄的点开时弹框、取来按内容判：文本在对话框里预览，不是文本的与太大的关掉对话框、直接下载；
// 网址的链到网址，没有句柄的只写名字

type Attachment = Extract<SessionItem, { kind: 'user-message' }>['attachments'][number];

/** 内容判不出是不是 Markdown：名字只决定预览怎么渲染（这两种渲染出来、别的原样），不决定能不能预览 */
const MARKDOWN_TYPES = new Set(['md', 'markdown']);
/** 预览最多读这么大，再大的不读完、直接下载 */
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
    return <Picture className="attachment-image" src={url} alt={name ?? tr('image')} />;
  }
  // biome-ignore lint/a11y/useMediaCaption: 会话里收发的音视频没有字幕文件可配
  if (kind === 'audio' && media) return <audio className="attachment-media" controls src={media} />;
  // biome-ignore lint/a11y/useMediaCaption: 同上
  if (kind === 'video' && media) return <video className="attachment-media" controls src={media} />;
  if (kind === 'file' && src !== undefined && !isWebUrl(src)) {
    return (
      <FileAttachment
        name={name ?? tr('file')}
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
      <FileLine name={name ?? src ?? tr('attachment')} />
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
      <span className="attachment-type">{extension ? extension.toUpperCase() : tr('file')}</span>
    </>
  );
}

/** 点开时取到的：文本，或该直接下载的（不是文本的带着读到的字节，太大的没读完、按句柄下载） */
type Opened = { text: string } | { download: Blob | undefined };

/**
 * 取来按内容判：取不到的写服务端给的原因；超过上限的不读完；读到的字节按 UTF-8 解得开、不含 NUL 的是文本，与文件读取
 * 同一个判定
 */
async function openFile(href: string, signal: AbortSignal): Promise<Opened> {
  const response = await fetch(href, { signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new Error(
      isRecord(body) && typeof body.error === 'string' ? body.error : tr('fileStatus', { status: response.status }),
    );
  }
  if (!(Number(response.headers.get('Content-Length')) <= PREVIEW_LIMIT_KB * 1024)) {
    await response.body?.cancel();
    return { download: undefined };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = decodeUtf8Text(bytes);
  return text === null ? { download: new Blob([bytes]) } : { text };
}

function FileAttachment({ name, href }: { name: string; href: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" className="attachment-file" onClick={() => setOpen(true)}>
        <FileLine name={name} />
      </button>
      {open && <FilePreview name={name} href={href} onClose={close} />}
    </>
  );
}

/** 开着就在取：读到文本就显示，不是文本的与太大的关掉自己、直接下载，取不到写原因；关掉或卸下（如切走会话）时停下这次读取 */
function FilePreview({ name, href, onClose }: { name: string; href: string; onClose(): void }) {
  const [shown, setShown] = useState<{ text: string } | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    openFile(href, controller.signal).then(
      opened => {
        if (controller.signal.aborted) return;
        if ('text' in opened) {
          setShown(opened);
          return;
        }
        onClose();
        download(opened.download ?? href, name);
      },
      (err: Error) => {
        if (!controller.signal.aborted) setShown({ error: err.message });
      },
    );
    return () => controller.abort();
  }, [href, name, onClose]);
  let body: ReactNode = <p>{tr('reading')}</p>;
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
            {tr('download')}
          </a>
          <Button data-autofocus onClick={onClose}>
            {tr('close')}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
