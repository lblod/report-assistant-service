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
