import { Navigate, Outlet, Route, Routes } from 'react-router';
import { AppearanceProvider } from './appearance';
import { HistoryTrail } from './back';
import { BackgroundProvider } from './background/tasks';
import { ToastProvider } from './components/Toast';
import { ConnectionProvider } from './connection';
import { AttentionProvider } from './health/attention';
import { HealthPage } from './health/HealthPage';
import { PluginPage } from './pages/PluginPage';
import { PagesProvider } from './pages/registry';
import { PluginsProvider } from './plugins/list';
import { Market } from './plugins/Market';
import { PluginDetail, PluginsHome } from './plugins/PluginDetail';
import { PluginTree } from './plugins/PluginTree';
import type { AdminClient } from './protocol/admin-client';
import type { SessionClient } from './protocol/session-client';
import { paths, routes } from './routes';
import { SessionActionsProvider } from './sessions/actions';
import { MineProvider } from './sessions/mine';
import { RoomsPage } from './sessions/RoomsPage';
import { SessionList } from './sessions/SessionList';
import { SettingsDirectory, SettingsHome, SettingsSection } from './settings/SettingsArea';
import { Shell, usePhone } from './shell/Shell';
import { NewSession, SessionRoute } from './workbench/Workbench';

export function App({ session, admin }: { session: SessionClient; admin: AdminClient }) {
  return (
    <ConnectionProvider session={session} admin={admin}>
      <PluginsProvider>
        <ToastProvider>
          <SessionActionsProvider>
            <PagesProvider>
              <AttentionProvider>
                <MineProvider>
                  <BackgroundProvider>
                    <AppearanceProvider>
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
                              <Route path={routes.sessionPanel} element={<SessionRoute />} />
                              <Route path={routes.rooms} element={<RoomsPage />} />
                            </Route>
                            <Route path={routes.page} element={<PluginPage />} />
                            <Route path={routes.health} element={<HealthPage />} />
                            <Route path={routes.healthLogs} element={<HealthPage />} />
                            <Route
                              element={
                                <>
                                  <PluginTree />
                                  <Outlet />
                                </>
                              }
                            >
                              <Route path={routes.plugins} element={<PluginsHome />} />
                              <Route path={routes.market} element={<Market />} />
                              <Route path={routes.plugin} element={<PluginDetail />} />
                            </Route>
                            <Route
                              element={
                                <>
                                  <SettingsDirectory />
                                  <Outlet />
                                </>
                              }
                            >
                              <Route path={routes.settings} element={<SettingsHome />} />
                              <Route path={routes.settingsSection} element={<SettingsSection />} />
                              <Route path={routes.settingsPage} element={<SettingsSection />} />
                            </Route>
                            <Route path="*" element={<Navigate to={paths.home} replace />} />
                          </Route>
                        </Routes>
                      </HistoryTrail>
                    </AppearanceProvider>
                  </BackgroundProvider>
                </MineProvider>
              </AttentionProvider>
            </PagesProvider>
          </SessionActionsProvider>
        </ToastProvider>
      </PluginsProvider>
    </ConnectionProvider>
  );
}

/** 手机上新会话是第一层之后的第二层；桌面上首页就是新会话 */
function NewSessionOnPhone() {
  return usePhone() ? <NewSession /> : <Navigate to={paths.home} replace />;
}
