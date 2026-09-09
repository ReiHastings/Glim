// Registers the sync-scenario resolve hook (firebase mocks + extensionless .js).
// Use via: node --import ./tests/register-sync-mocks.mjs tests/sync_scenarios.test.mjs
import { register } from 'node:module';
register('./resolve-sync-mocks.mjs', import.meta.url);
