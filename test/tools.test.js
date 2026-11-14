// The tool loop: the refine turn behind REFINE_PROTOCOL=tools. The service
// reads the setting when it loads, so it is set before the service is
// imported.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { database } from './support/mu.mjs';
import { scriptLlm, completion, chunks } from './support/llm.mjs';
import { loadTestProfiles, mandatenSpec } from './support/profiles.js';

process.env.REFINE_PROTOCOL = 'tools';
const { refineSpec } = await import('../src/report-assistant.js');

const profiles = loadTestProfiles();
const QUESTION = [{ role: 'user', content: 'Geef alle mandatarissen.' }];

beforeEach(() => database.reset());

test('tools: the model writes the spec, validate_spec accepts it and it goes on the answer as a bijlage', async () => {
  const turtle = mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    rep:columns ( [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ] )`, { title: 'Mandatarissen' });
  const call = { id: 'call-1', type: 'function', function: { name: 'validate_spec', arguments: JSON.stringify({ spec: turtle }) } };
  const requests = scriptLlm([completion(null, { tool_calls: [call] }), completion('Dit rapport toont alle mandatarissen. Zal ik het uitvoeren?')]);

  const answer = await refineSpec(QUESTION, profiles);

  assert.equal(answer.text, 'Dit rapport toont alle mandatarissen. Zal ik het uitvoeren?');
  assert.equal(answer.attachments.length, 1);
  assert.deepEqual(requests[0].body.tools.map(t => t.function.name), ['describe_profile', 'validate_spec', 'read_spec', 'lookup_values']);
  assert.equal(requests[0].body.response_format, undefined);
  assert.deepEqual(requests[1].body.messages.at(-1), { role: 'tool', content: 'ok', tool_call_id: 'call-1' });

  const stored = database.calls.find(c => c.kind === 'update').query;
  const shareName = stored.match(/<share:\/\/(specificatie-[0-9a-f-]{36}\.ttl)>/)[1];
  assert.equal(readFileSync(join(process.env.SHARE_DIR, shareName), 'utf8'), turtle);
});

test('tools: an answer that comes as a list of parts is the answer text', async () => {
  scriptLlm([completion(chunks('Which profile?', ' Welke gegevens wil je zien? '))]);
  assert.deepEqual(await refineSpec(QUESTION, profiles), { text: 'Welke gegevens wil je zien?', attachments: [] });

  scriptLlm([completion([{ type: 'thinking', thinking: [] }])]);
  assert.deepEqual(await refineSpec(QUESTION, profiles), { text: 'Er kwam geen antwoord. Probeer het opnieuw.' });
});
