import { createContext, type ReactNode, useContext } from 'react';
import { useSessionList } from './live-list';

// 「我的」区的会话列表：整页一份，左栏的列表与标签页标题里完成未读的数都读它

type Mine = ReturnType<typeof useSessionList>;

const Context = createContext<Mine | undefined>(undefined);

export function useMine(): Mine {
  const mine = useContext(Context);
  if (!mine) throw new Error('只能在 MineProvider 里取「我的」区的会话');
  return mine;
}

export function MineProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useSessionList({ section: 'owner' })}>{children}</Context.Provider>;
}
