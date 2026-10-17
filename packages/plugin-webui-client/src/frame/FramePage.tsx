import {
  type ActionInputFields,
  FRAME_PROTOCOL_VERSION,
  FRAME_SANDBOX,
  type FramePageView,
  type FrameTexts,
} from '@aalis/api-webui';
import { truncateChars } from '@aalis/util-text-normalize';
import { LoaderCircle } from 'lucide-react';
import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { FetchError } from '../components/FetchError';
import { useToast } from '../components/Toast';
import { useConnection } from '../connection';
import { text, tr } from '../language';
import { packedTexts } from '../language-provider';
import { usePluginNames } from '../plugins/list';
import { isRecord, useJson } from '../rest';
import { paths } from '../routes';
import { formatValue } from '../settings/field';
import { t } from '../texts';
import { type FrameQuestion, type FrameStop, mountFrame } from './channel';
import './FramePage.css';
import type { Localized, TextRef } from '@aalis/schema-i18n';

// 插件前端：上面一行写明出处，下面是宿主画的隔离框架，框架里画出的东西总在这一行下面。这一页所属插件的字典取到之后才挂
// 框架（随 init 交给它），没取到时原地写明，重试就是重新加载；握手完成前框架不可见；停止显示时换成占位。「重新加载」、手动
// 刷新与页面换了地址都是重新挂载，每次挂载都重取字典、用这一次取到的。外链与 destructive 动作的宿主对话框在这里画：
// 确认不默认聚焦，打开后一小段时间内不接受确认，免得用户在框架里的连点落到确认上

/** 宿主对话框打开后多久内不接受确认 */
const FRAME_DIALOG_ARM_MS = 500;
/** 确认框里一个输入值最多显示几个字 */
const VALUE_MAX_CHARS = 200;

const STOPPED: Record<Exclude<FrameStop['reason'], 'version'>, TextRef> = {
  timeout: t('frameTimeout'),
  left: t('frameLeft'),
  flood: t('frameFlood'),
  refused: t('frameRefused'),
};

interface FramePageProps {
  page: Localized<FramePageView>;
  /** 会话面板的会话 */
  sessionId?: string;
  /** 手动刷新的次数：变了就重新挂载 */
  reloads: number;
  reload(): void;
}

/** 插件前端的字典：字典本身由框架里的助手核（schema-i18n 的 registerCatalogEntry），这里核外层与语言包的补充 */
function parseTexts(body: unknown): FrameTexts {
  if (!isRecord(body) || !(body.texts === null || isRecord(body.texts)) || !isRecord(body.packs)) {
    throw new Error(tr('frameTextsMalformed'));
  }
  return {
    texts: body.texts as FrameTexts['texts'],
    packs: Object.fromEntries(Object.entries(body.packs).map(([key, candidates]) => [key, packedTexts(candidates)])),
  };
}

export function FramePage({ page, sessionId, reloads, reload }: FramePageProps) {
  const names = usePluginNames();
  // IPv6 字面地址写不进框架响应头里的来源：不挂框架，也不取字典
  const ipv6 = location.hostname.startsWith('[');
  const path = `/api/pages/${encodeURIComponent(page.instance)}/${encodeURIComponent(page.key)}/texts`;
  /** 这一次挂载：框架地址与刷新次数，变了就重取字典、重新挂载 */
  const mount = `${page.frame.src}:${reloads}`;
  // 重取时 useJson 还给着上一次的值：字典记下它是哪一次挂载取的，不是这一次的不用
  const parse = useCallback((body: unknown) => ({ mount, texts: parseTexts(body) }), [mount]);
  const fetched = useJson(ipv6 ? undefined : path, parse, mount);
  let body: ReactNode;
  if (ipv6) body = <EmptyState title={tr('frameNeedsHostName')} />;
  else if (fetched.error) body = <FetchError what={tr('frameTexts')} error={fetched.error} retry={reload} />;
  else if (fetched.value?.mount !== mount) body = <FrameArea loading />;
  else body = <Frame key={mount} page={page} sessionId={sessionId} texts={fetched.value.texts} reload={reload} />;
  return (
    <div className="frame-page">
      <p className="frame-source">
        {tr('frameSource', { plugin: names.instances.get(page.instance)?.label ?? page.instance })}
      </p>
      {body}
    </div>
  );
}

/** 框架所在的区域：加载中时上面盖着宿主的加载态 */
function FrameArea({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return (
    <div className="frame-area">
      {children}
      {loading && (
        <span className="frame-loading" role="status" aria-label={tr('loading')}>
          <LoaderCircle aria-hidden className="spin" />
        </span>
      )}
    </div>
  );
}

const randomNonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** 等用户拍板的宿主对话框：问的什么，用户的回答交给谁 */
interface Asking {
  question: FrameQuestion;
  answer(confirmed: boolean): void;
}

/** 一次挂载：按框架地址与刷新次数挂上（外面的 key），挂着时页面表重取回来的是同一次登记 */
function Frame({ page, sessionId, texts, reload }: Omit<FramePageProps, 'reloads'> & { texts: FrameTexts }) {
  const { session, admin } = useConnection();
  const navigate = useNavigate();
  const toast = useToast();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [nonce] = useState(randomNonce);
  const [state, setState] = useState<'loading' | 'ready' | FrameStop>('loading');
  const [asking, setAsking] = useState<Asking>();

  // 在 iframe 插进文档的同一拍挂上监听，赶在它的 load 之前
  useLayoutEffect(
    () =>
      mountFrame(iframe.current as HTMLIFrameElement, nonce, {
        page,
        sessionId,
        texts,
        session,
        admin,
        ready: () => setState('ready'),
        stop(why) {
          if (why.reason === 'left' || why.reason === 'flood' || why.reason === 'refused') {
            console.warn(`插件前端「${page.title}」（${page.instance}）：${STOPPED[why.reason].source}`);
          }
          setState(why);
        },
        ask: question => new Promise(answer => setAsking({ question, answer })),
        openSession: id => navigate(paths.session(id)),
        report: (kind, text) => toast({ kind, text, source: page.instance }),
      }),
    [],
  );

  if (typeof state === 'object') {
    return state.reason === 'version' ? (
      <EmptyState
        tone="danger"
        title={tr('frameProtocolMismatch', { page: state.protocol, host: FRAME_PROTOCOL_VERSION })}
      />
    ) : (
      <EmptyState
        tone="danger"
        title={text(STOPPED[state.reason])}
        action={<Button onClick={reload}>{tr('reloadPage')}</Button>}
      />
    );
  }
  const answer = (confirmed: boolean) => {
    setAsking(undefined);
    asking?.answer(confirmed);
  };
  return (
    <>
      <FrameArea loading={state === 'loading'}>
        <iframe
          ref={iframe}
          className="frame"
          title={page.title}
          src={`${page.frame.src}#${nonce}`}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          data-ready={state === 'ready' || undefined}
        />
      </FrameArea>
      <FrameDialog asking={asking} answer={answer} />
    </>
  );
}

function FrameDialog({ asking, answer }: { asking?: Asking; answer(confirmed: boolean): void }) {
  const question = asking?.question;
  // 对话框真正打开后才起算（里面 Dialog 的 showModal 先于这里执行）；按点按发生的时刻判断，主线程忙时排队晚到的也算在内
  const openedAt = useRef(0);
  useEffect(() => {
    if (asking) openedAt.current = performance.now();
  }, [asking]);
  const armed = (event: SyntheticEvent) => event.timeStamp - openedAt.current >= FRAME_DIALOG_ARM_MS;
  let title = '';
  let body: ReactNode = null;
  let confirm: ReactNode = null;
  if (question?.kind === 'open') {
    title = tr('openExternalLink');
    body = <p>{question.url}</p>;
    confirm = (
      <a
        className="button"
        data-variant="primary"
        href={question.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={event => {
          if (armed(event)) answer(true);
          else event.preventDefault();
        }}
      >
        <span className="button-label">{tr('open')}</span>
      </a>
    );
  } else if (question) {
    const { action, input } = question;
    title = tr('confirmAction', { action: action.label });
    body = (
      <>
        <p>{action.confirm ?? tr('defaultConfirm')}</p>
        {input && <InputValues fields={action.input ?? {}} input={input} />}
      </>
    );
    confirm = (
      <Button variant="primary" danger onClick={event => armed(event) && answer(true)}>
        {action.label}
      </Button>
    );
  }
  return (
    <Dialog
      open={question !== undefined}
      title={title}
      onClose={() => answer(false)}
      footer={
        question && (
          <>
            <Button data-autofocus onClick={() => answer(false)}>
              {tr('cancel')}
            </Button>
            {confirm}
          </>
        )
      }
    >
      {body}
    </Dialog>
  );
}

/** 这次的输入值按纯文本列出：声明了的字段写字段名与按字段写成的值，没声明的写键名与原样的值 */
function InputValues({ fields, input }: { fields: Localized<ActionInputFields>; input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <dl className="frame-values">
      {entries.map(([key, value]) => {
        const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
        const text = field ? formatValue(field, value) : typeof value === 'string' ? value : JSON.stringify(value);
        return (
          <div key={key}>
            <dt>{field?.label ?? key}</dt>
            <dd>{truncateChars(text, VALUE_MAX_CHARS, '…')}</dd>
          </div>
        );
      })}
    </dl>
  );
}
