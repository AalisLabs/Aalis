import { type ActionInputFields, FRAME_PROTOCOL_VERSION, FRAME_SANDBOX, type FramePageView } from '@aalis/api-webui';
import { truncateChars } from '@aalis/util-text-normalize';
import { LoaderCircle } from 'lucide-react';
import { type ReactNode, type SyntheticEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { useToast } from '../components/Toast';
import { useConnection } from '../connection';
import { DEFAULT_CONFIRM } from '../pages/scope';
import { usePluginNames } from '../plugins';
import { paths } from '../routes';
import { formatValue } from '../settings/field';
import { type FrameQuestion, type FrameStop, mountFrame } from './channel';
import './FramePage.css';

// 插件前端：上面一行写明出处，下面是宿主画的隔离框架，框架里画出的东西总在这一行下面。握手完成前框架不可见；
// 停止显示时换成占位，「重新加载」与手动刷新都是重新挂载。外链与 destructive 动作的宿主对话框在这里画：
// 确认不默认聚焦，打开后一小段时间内不接受确认，免得用户在框架里的连点落到确认上

/** 宿主对话框打开后多久内不接受确认 */
const FRAME_DIALOG_ARM_MS = 500;
/** 确认框里一个输入值最多显示几个字 */
const VALUE_MAX_CHARS = 200;

const STOPPED: Record<Exclude<FrameStop['reason'], 'version'>, string> = {
  timeout: '页面没有响应',
  left: '这个页面离开了宿主给它的地址，已停止显示',
  flood: '这个页面发了太多消息，已停止显示',
  refused: '这个页面反复弹出确认，已停止',
};

interface FramePageProps {
  page: FramePageView;
  /** 会话面板的会话 */
  sessionId?: string;
  /** 手动刷新的次数：变了就重新挂载 */
  reloads: number;
  reload(): void;
}

export function FramePage({ page, sessionId, reloads, reload }: FramePageProps) {
  const names = usePluginNames();
  return (
    <div className="frame-page">
      <p className="frame-source">{`来自 ${names.instances.get(page.instance)?.label ?? page.instance}`}</p>
      {/* IPv6 字面地址写不进框架响应头里的来源 */}
      {location.hostname.startsWith('[') ? (
        <EmptyState title="用主机名或 IPv4 地址访问才能显示插件前端" />
      ) : (
        <Frame key={`${page.frame.src}:${reloads}`} page={page} sessionId={sessionId} reload={reload} />
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
function Frame({ page, sessionId, reload }: Omit<FramePageProps, 'reloads'>) {
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
        session,
        admin,
        ready: () => setState('ready'),
        stop(why) {
          if (why.reason === 'left' || why.reason === 'flood' || why.reason === 'refused') {
            console.warn(`插件前端「${page.title}」（${page.instance}）：${STOPPED[why.reason]}`);
          }
          setState(why);
        },
        ask: question => new Promise(answer => setAsking({ question, answer })),
        openSession: id => navigate(paths.session(id)),
        report: (kind, text) => toast({ kind, text }),
      }),
    [],
  );

  if (typeof state === 'object') {
    return state.reason === 'version' ? (
      <EmptyState
        tone="danger"
        title={`这个页面用的前端协议是 ${state.protocol}，界面支持的是 ${FRAME_PROTOCOL_VERSION}`}
      />
    ) : (
      <EmptyState tone="danger" title={STOPPED[state.reason]} action={<Button onClick={reload}>重新加载</Button>} />
    );
  }
  const answer = (confirmed: boolean) => {
    setAsking(undefined);
    asking?.answer(confirmed);
  };
  return (
    <>
      <div className="frame-area">
        <iframe
          ref={iframe}
          className="frame"
          title={page.title}
          src={`${page.frame.src}#${nonce}`}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          data-ready={state === 'ready' || undefined}
        />
        {state === 'loading' && (
          <span className="frame-loading" role="status" aria-label="正在加载">
            <LoaderCircle aria-hidden className="spin" />
          </span>
        )}
      </div>
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
    title = '打开外部链接？';
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
        <span className="button-label">打开</span>
      </a>
    );
  } else if (question) {
    const { action, input } = question;
    title = `${action.label}？`;
    body = (
      <>
        <p>{action.confirm ?? DEFAULT_CONFIRM}</p>
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
              取消
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
function InputValues({ fields, input }: { fields: ActionInputFields; input: Record<string, unknown> }) {
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
