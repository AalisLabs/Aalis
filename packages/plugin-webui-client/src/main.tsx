import './styles/tokens.css';
import './styles/base.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { createAdminClient } from './protocol/admin-client';
import { createSessionClient } from './protocol/session-client';

createRoot(document.getElementById('root') as HTMLElement).render(
  <BrowserRouter>
    <App session={createSessionClient()} admin={createAdminClient()} />
  </BrowserRouter>,
);
