import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';

// 回上一层：上一条历史就是上一层时退回去，系统返回与浏览器后退就不会再回到刚离开的这一层；否则换掉当前这条。
// 为此记下本页里走过的地址：前进追加，替换换掉最后一条，后退截到退回的那一条；退到本页没记过的地方（刷新之前的
// 历史，或后退之后再前进）不知道前后，从这一条重新记

interface Entry {
  key: string;
  path: string;
}

const PreviousPath = createContext<() => string | undefined>(() => undefined);

export function HistoryTrail({ children }: { children: ReactNode }) {
  const location = useLocation();
  const type = useNavigationType();
  const trail = useRef<Entry[]>([]);

  useEffect(() => {
    const entries = trail.current;
    const entry = { key: location.key, path: location.pathname + location.search };
    if (entries.at(-1)?.key === entry.key) return;
    if (type === 'POP') {
      const at = entries.findIndex(known => known.key === entry.key);
      if (at < 0) entries.splice(0, entries.length, entry);
      else entries.length = at + 1;
    } else if (type === 'REPLACE' && entries.length > 0) {
      entries[entries.length - 1] = entry;
    } else {
      entries.push(entry);
    }
  }, [location, type]);

  const previous = useCallback(() => trail.current.at(-2)?.path, []);
  return <PreviousPath.Provider value={previous}>{children}</PreviousPath.Provider>;
}

/** 回到上一层的地址 to */
export function useBack(): (to: string) => void {
  const previous = useContext(PreviousPath);
  const navigate = useNavigate();
  return useCallback(
    (to: string) => {
      if (previous() === to) navigate(-1);
      else navigate(to, { replace: true });
    },
    [previous, navigate],
  );
}
