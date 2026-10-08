import { paths } from '../routes';
import { Button } from './Button';
import { ButtonLink } from './ButtonLink';
import { EmptyState } from './EmptyState';
import './FetchError.css';

/** 链到按这个插件实例筛好的日志 */
export function LogsLink({ source }: { source: string }) {
  return (
    <ButtonLink to={paths.healthLogs({ plugin: source })} variant="text">
      查看日志
    </ButtonLink>
  );
}

interface FetchErrorProps {
  /** 没取到的是什么，如「插件列表」 */
  what: string;
  error: Error;
  retry(): void;
  /** 上一次取到的还显示着：写「没刷新成功」，写成一行 */
  stale?: boolean;
  /** 这一块里还显示着别的：写成一行，不占整块 */
  inline?: boolean;
  /** 出错的来源插件实例：给了才有「查看日志」 */
  source?: string;
}

/** 一块取数失败：原地写明哪里没取到与原因，可以重试，指得出来源时可以去看它的日志 */
export function FetchError({ what, error, retry, stale, inline, source }: FetchErrorProps) {
  const title = `${what}${stale ? '没刷新成功' : '没取到'}`;
  const oneLine = stale || inline;
  const actions = (
    <>
      <Button variant={oneLine ? 'text' : 'secondary'} onClick={retry}>
        重试
      </Button>
      {source && <LogsLink source={source} />}
    </>
  );
  if (oneLine) {
    return (
      <p className="fetch-error" role="alert">
        {`${title}：${error.message}`}
        {actions}
      </p>
    );
  }
  return (
    <EmptyState
      tone="danger"
      title={title}
      description={error.message}
      action={<div className="fetch-error-actions">{actions}</div>}
    />
  );
}
