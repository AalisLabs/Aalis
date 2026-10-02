import { Navigate, Outlet, Route, Routes } from 'react-router';
import { HistoryTrail } from './back';
import { ToastProvider } from './components/Toast';
import { ConnectionProvider } from './connection';
import type { AdminClient } from './protocol/admin-client';
import type { SessionClient } from './protocol/session-client';
import { paths, routes } from './routes';
import { SessionActionsProvider } from './sessions/actions';
import { RoomsPage } from './sessions/RoomsPage';
import { SessionList } from './sessions/SessionList';
import { Shell, usePhone } from './shell/Shell';
import { NewSession, SessionRoute } from './workbench/Workbench';

export function App({ session, admin }: { session: SessionClient; admin: AdminClient }) {
  return (
    <ConnectionProvider session={session} admin={admin}>
      <ToastProvider>
        <SessionActionsProvider>
          <HistoryTrail>
            <Routes>
              <Route element={<Shell />}>
                <Route
                  element={
                    <>
                      <SessionList />
                      <Outlet />
                    </>
                  }
                >
                  <Route path={routes.home} element={<NewSession />} />
                  <Route path={routes.newSession} element={<NewSessionOnPhone />} />
                  <Route path={routes.session} element={<SessionRoute />} />
                  <Route path={routes.sessionTab} element={<SessionRoute />} />
                  <Route path={routes.rooms} element={<RoomsPage />} />
                </Route>
                <Route path="*" element={<Navigate to={paths.home} replace />} />
              </Route>
            </Routes>
          </HistoryTrail>
        </SessionActionsProvider>
      </ToastProvider>
    </ConnectionProvider>
  );
}

/** 手机上新会话是第一层之后的第二层；桌面上首页就是新会话 */
function NewSessionOnPhone() {
  return usePhone() ? <NewSession /> : <Navigate to={paths.home} replace />;
}
