import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLlm } from '../src/llm/loop.js';
import { wantsExecution } from '../src/llm/mode.js';
import { refineSpec } from '../src/report-assistant.js';
import { scriptLlm, completion, chunks } from './support/llm.mjs';
import { loadTestProfiles } from './support/profiles.js';

const profiles = loadTestProfiles();
const QUESTION = [{ role: 'user', content: 'Geef alle mandatarissen.' }];

test('callLlm: sends the model and the messages, returns the message', async () => {
  const requests = scriptLlm([completion('Hallo')]);

  const message = await callLlm([{ role: 'user', content: 'Hoi', attachments: [{ name: 'x.ttl' }] }]);

  assert.equal(message.content, 'Hallo');
  assert.equal(requests[0].url, 'http://llm.test/v1/chat/completions');
  assert.deepEqual(requests[0].body, { model: 'test-model', messages: [{ role: 'user', content: 'Hoi' }] });
});

test('callLlm: a content that comes as a list of parts is read as its text parts', async () => {
  scriptLlm([completion(chunks('The user wants a list. true or false?', 'Dit is het antwoord.'))]);
  assert.equal((await callLlm(QUESTION)).content, 'Dit is het antwoord.');

  scriptLlm([completion([{ type: 'text', text: 'een ' }, { type: 'text', text: 'twee' }])]);
  assert.equal((await callLlm(QUESTION)).content, 'een twee');
});

test('callLlm: an answer without a message fails with a sentence that says so', async () => {
  scriptLlm([{ choices: [] }]);
  await assert.rejects(callLlm(QUESTION), /the LLM answered without a message/);
});

test('callLlm: a 429 is tried again and waits as long as Retry-After asks', async () => {
  const requests = scriptLlm([{ status: 429, body: { message: 'rate limit' }, headers: { 'retry-after': '0.05' } }, completion('ok')]);
  const started = Date.now();

  assert.equal((await callLlm(QUESTION)).content, 'ok');

  assert.equal(requests.length, 2);
  assert.ok(Date.now() - started >= 45, 'waited for the Retry-After of the 429');
});

test('callLlm: gives up after LLM_RETRIES retries; a 400 is not tried again', async () => {
  const always429 = scriptLlm(Array(4).fill({ status: 429, body: { message: 'rate limit' } }));
  await assert.rejects(callLlm(QUESTION), /LLM 429: .*rate limit/);
  assert.equal(always429.length, 4, 'the first call and three retries');

  const badRequest = scriptLlm([{ status: 400, body: { message: 'unknown model' } }]);
  await assert.rejects(callLlm(QUESTION), /LLM 400: .*unknown model/);
  assert.equal(badRequest.length, 1);
});

test('callLlm: a provider that does not answer within LLM_TIMEOUT is cut off and tried again', async () => {
  // never answers: ends only when the service aborts the call. The interval
  // stands for the open connection, which keeps Node alive meanwhile.
  const silent = (url, init) => new Promise((resolve, reject) => {
    const connection = setInterval(() => {}, 10);
    init.signal.addEventListener('abort', () => {
      clearInterval(connection);
      reject(init.signal.reason);
    });
  });

  const requests = scriptLlm([silent, completion('toch nog')]);
  assert.equal((await callLlm(QUESTION)).content, 'toch nog');
  assert.equal(requests.length, 2);

  const never = scriptLlm([silent, silent, silent, silent]);
  await assert.rejects(callLlm(QUESTION), { name: 'TimeoutError' });
  assert.equal(never.length, 4);
});

test('wantsExecution: reads "true" from a list of parts, never from the thinking', async () => {
  const turns = [...QUESTION, { role: 'assistant', content: 'Voorstel ...' }, { role: 'user', content: 'voer uit' }];

  scriptLlm([completion(chunks('The user confirms.', 'true'))]);
  assert.equal(await wantsExecution(turns), true);

  scriptLlm([completion(chunks('true, the user confirms.', 'false'))]);
  assert.equal(await wantsExecution(turns), false);

  scriptLlm([completion([{ type: 'thinking', thinking: [{ type: 'text', text: 'true' }] }])]);
  assert.equal(await wantsExecution(turns), false, 'no text part: refine');
});

test('refineSpec: an answer that comes as a list of parts is the answer text', async () => {
  scriptLlm([completion(chunks('Which profile?', ' Welke gegevens wil je zien? '))]);
  assert.deepEqual(await refineSpec(QUESTION, profiles), { text: 'Welke gegevens wil je zien?', attachments: [] });

  scriptLlm([completion([{ type: 'thinking', thinking: [] }])]);
  assert.deepEqual(await refineSpec(QUESTION, profiles), { text: 'Er kwam geen antwoord. Probeer het opnieuw.' });
});
