import { resolve } from 'node:path';

import { createServer } from './server.js';

const port = Number(process.env.MARKETPLACE_PORT || 7820);
const host = process.env.MARKETPLACE_HOST || '127.0.0.1';
const storeDir = resolve(process.env.MARKETPLACE_STORE || './store');
const adminToken = process.env.MARKETPLACE_ADMIN_TOKEN;

createServer({ host, port, storeDir, adminToken }).catch(err => {
  console.error(err);
  process.exit(1);
});
