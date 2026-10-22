import { afterAll, afterEach } from 'vitest';
import { assertNoRefusedConnections, installConnectGuard } from '../helpers/network-policy.js';

installConnectGuard();
afterEach(assertNoRefusedConnections);
afterAll(assertNoRefusedConnections);
