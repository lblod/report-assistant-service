// Loaded before every test file (node --import). The service imports "mu",
// which only exists inside the mu-javascript-template image; here that
// import goes to the stand-in in mu.mjs, so the tests run under plain Node.
// The settings the service reads at import time are set here too.
import { register } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./resolve-mu.mjs', import.meta.url);

// spec files and CSVs of a test run go to a folder of their own
process.env.SHARE_DIR = mkdtempSync(join(tmpdir(), 'report-assistant-test-'));
// no test reaches a provider: each one replaces fetch
process.env.LLM_BASE_URL = 'http://llm.test/v1';
process.env.LLM_MODEL = 'test-model';
process.env.LLM_RETRY_DELAY = '1';
process.env.LLM_TIMEOUT = '50';
