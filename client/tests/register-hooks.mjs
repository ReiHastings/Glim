// title: register-hooks.mjs
// project: Glim
// author: Reina Hastings
//
// purpose:
//   Registers the extensionless-import resolve hook for the standalone tests.
//   Use via: node --import ./tests/register-hooks.mjs tests/<name>.test.mjs

import { register } from 'node:module';
register('./resolve-extensionless.mjs', import.meta.url);
