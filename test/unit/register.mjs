// Registers the unit-test module loader (see loader.mjs). Loaded via
// `node --test --import ./test/unit/register.mjs ...`.
// All code, comments, log messages and docs in this project are English only.

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
