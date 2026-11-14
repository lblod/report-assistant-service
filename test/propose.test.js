// The refine turn of the default protocol: the model fills a plan, the
// service compiles it and writes the proposal.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineSpec } from '../src/report-assistant.js';
import { propose, readPlan } from '../src/plan/propose.js';
import { forgetCodes } from '../src/plan/read-codes.js';
import { parseSpec } from '../src/runner/spec.js';
import { checkSpec } from '../src/runner/check.js';
import { SPEC_MEDIA_TYPE } from '../src/chat.js';
import { database } from './support/mu.mjs';
import { scriptLlm, completion, chunks } from './support/llm.mjs';
import { loadTestProfiles } from './support/profiles.js';
import { answerNames, buildTestLists } from './support/codes.js';

const profiles = loadTestProfiles();
const SERVICE_SCOPE = 'http://services.semantic.works/report-assistant';
const TO_EENHEID = ['bekleedt mandaat', 'zit in bestuursorgaan', 'is tijdspecialisatie van', 'bestuurt'];
const QUESTION = [{ role: 'user', content: 'Geef de achternaam van alle verhinderde mandatarissen van de gemeente Dilbeek.', attachments: [] }];
const PLAN = {
  profile: 'Mandaten', entity: 'Mandataris', title: 'Verhinderde mandatarissen van Dilbeek',
  filters: [
    { path: ['status'], is: 'Verhinderd' },
    { path: TO_EENHEID, is: { 'soort bestuur': 'Gemeente', naam: 'Dilbeek' } },
  ],
  columns: [{ label: 'achternaam', path: ['persoon', 'achternaam'] }],
};
const CONFIRM = 'De volledige specificatie staat in de bijlage. Zeg "voer uit" om dit rapport te maken, of zeg wat er anders moet.';
const reply = (plan) => completion(JSON.stringify(plan));
const namesRead = () => database.calls.filter(c => c.query.includes('?uri a <'));

beforeEach(() => {
  database.reset();
  database.answer = (query, options) => answerNames(query, options);
  forgetCodes();
});

test('propose: one call gives the plan; the proposal is written from the compiled spec', async () => {
  const requests = scriptLlm([reply(PLAN)]);

  const { text, spec } = await propose(QUESTION, profiles);

  assert.equal(text, [
    'Rapport "Verhinderde mandatarissen van Dilbeek": één rij per mandataris (profiel Mandaten).',
    '',
    'Filters:',
    '- status is Verhinderd',
    '- bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › soort bestuur is Gemeente (zelfde bestuurseenheid: naam is "Dilbeek")',
    '',
    'Kolommen:',
    '- achternaam: persoon › achternaam',
    '',
    CONFIRM,
  ].join('\n'));
  assert.equal(checkSpec(parseSpec(spec), profiles), null);
  assert.equal(spec.split('\n')[0], `# plan: ${JSON.stringify(PLAN)}`, 'the plan travels with the spec, for the next turn');

  assert.equal(requests.length, 1);
  const { body } = requests[0];
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 0);
  assert.equal(body.tools, undefined);
  const [system, user] = body.messages;
  assert.match(system.content, /^You turn a Dutch question about a report into a JSON report plan\./);
  assert.ok(system.content.includes(`Today is ${new Date().toISOString().slice(0, 10)}.`));
  assert.ok(system.content.includes('CATALOGUE\nPROFILE "Mandaten"'));
  assert.ok(system.content.includes('MandatarisStatus (status) — codes: Effectief; Verhinderd; Waarnemend'));
  assert.ok(!system.content.includes('http://'), 'no URI goes to the model');
  assert.deepEqual(user, { role: 'user', content: QUESTION[0].content });
});

test('propose: the names are read under the service scope, once', async () => {
  scriptLlm([reply(PLAN), reply(PLAN)]);

  await propose(QUESTION, profiles);
  const first = namesRead();
  assert.ok(first.length > 5);
  assert.ok(first.every(c => c.kind === 'query' && c.options.scope === SERVICE_SCOPE));
  assert.ok(first.every(c => /LIMIT 1001$/.test(c.query)));
  assert.ok(!first.some(c => c.query.includes('ns/besluit#Bestuursorgaan>')), 'not of an entity that shares its class');

  await propose(QUESTION, profiles);
  assert.equal(namesRead().length, first.length, 'the second turn reads nothing');
});

test('propose: a read that failed is not kept, and the turn goes on with names as text', async () => {
  database.answer = () => { throw new Error('the database is away'); };
  scriptLlm([reply({ ...PLAN, filters: [{ path: ['status'], is: 'Verhinderd' }] })]);
  const error = console.error;
  console.error = () => {};
  const { text } = await propose(QUESTION, profiles).finally(() => { console.error = error; });
  assert.ok(text.includes('- status › naam is "Verhinderd"'));
  assert.ok(text.includes('Let op: De assistent kan niet nagaan of er een status "Verhinderd" bestaat'));

  database.reset();
  database.answer = (query, options) => answerNames(query, options);
  scriptLlm([reply({ ...PLAN, filters: [{ path: ['status'], is: 'Verhinderd' }] })]);
  assert.ok((await propose(QUESTION, profiles)).text.includes('- status is Verhinderd'));
  assert.ok(namesRead().length > 5, 'the names were read again');
});

test('propose: a plan with mistakes goes back with every mistake, at most twice', async () => {
  const wrong = { ...PLAN, filters: [{ path: ['status'], is: 'Afwezig' }], columns: [{ label: 'naam', path: ['persoon', 'naam'] }] };
  const requests = scriptLlm([reply(wrong), reply(PLAN)]);

  const { text, spec } = await propose(QUESTION, profiles);

  assert.ok(text.startsWith('Rapport "Verhinderde mandatarissen van Dilbeek"'));
  assert.ok(spec);
  assert.equal(requests.length, 2);
  const [assistant, user] = requests[1].body.messages.slice(-2);
  assert.deepEqual(assistant, { role: 'assistant', content: JSON.stringify(wrong) });
  assert.equal(user.content, [
    'That plan cannot be used:',
    '- filters[0]: "Afwezig" (the codes are: Effectief; Verhinderd; Waarnemend) is not a code of MandatarisStatus. Use the exact name of a code, or "contains" for a text match.',
    '- columns[0]: step 2 "naam" is not a field of Persoon. Fields there: voornaam, achternaam, mandatarissen. Did you mean "voornaam"?',
    'Reply with the full corrected JSON plan and nothing else.',
  ].join('\n'));

  const never = scriptLlm([reply(wrong), reply(wrong), reply(wrong)]);
  assert.deepEqual(await propose(QUESTION, profiles),
    { text: 'Het lukte niet om een geldig rapportvoorstel te maken. Formuleer de vraag anders of preciezer.', spec: null });
  assert.equal(never.length, 3);
});

test('propose: what the model cannot do comes back as its sentence, without a spec', async () => {
  scriptLlm([reply({ cannot: 'Tellen is niet mogelijk: een rapport toont rijen, geen aantallen.' })]);
  assert.deepEqual(await propose([{ role: 'user', content: 'Hoeveel mandatarissen zijn er?' }], profiles),
    { text: 'Tellen is niet mogelijk: een rapport toont rijen, geen aantallen.', spec: null });
});

test('propose: the plan is read from a code fence, from a list of parts, and a cut-off reply says so', async () => {
  scriptLlm([completion(`Hier is het plan:\n\`\`\`json\n${JSON.stringify(PLAN, null, 2)}\n\`\`\``)]);
  assert.ok((await propose(QUESTION, profiles)).spec);

  scriptLlm([completion(chunks('The user wants {"profile": ...', JSON.stringify(PLAN)))]);
  assert.ok((await propose(QUESTION, profiles)).spec);

  const requests = scriptLlm([completion(JSON.stringify(PLAN).slice(0, 80), {}, 'length'), completion('Ik weet het niet.'), reply(PLAN)]);
  assert.ok((await propose(QUESTION, profiles)).spec);
  assert.match(requests[1].body.messages.at(-1).content, /- the reply was cut off before the JSON object was complete\./);
  assert.match(requests[2].body.messages.at(-1).content, /- the reply is not one JSON object\./);

  assert.deepEqual(readPlan('{"a": 1} en {"b": 2}'), null);
  assert.deepEqual(readPlan('[1, 2]'), null);
});

test('refineSpec: the spec becomes a bijlage, and the next turn hands the model its own plan back', async () => {
  scriptLlm([reply(PLAN)]);
  const first = await refineSpec(QUESTION, profiles);

  assert.ok(first.text.endsWith(CONFIRM));
  assert.equal(first.attachments.length, 1);
  const stored = database.calls.find(c => c.kind === 'update').query;
  const name = stored.match(/<share:\/\/(specificatie-[0-9a-f-]{36}\.ttl)>/)[1];
  const file = readFileSync(join(process.env.SHARE_DIR, name), 'utf8');
  assert.equal(parseSpec(file).title, 'Verhinderde mandatarissen van Dilbeek', 'the plan line is a comment to Turtle');

  const turns = [
    ...QUESTION,
    { role: 'assistant', content: first.text, attachments: [{ uri: first.attachments[0], name, mediaType: SPEC_MEDIA_TYPE }] },
    { role: 'user', content: 'Voeg ook de voornaam toe.', attachments: [] },
  ];
  const withFirstName = { ...PLAN, columns: [...PLAN.columns, { label: 'voornaam', path: ['persoon', 'voornaam'] }] };
  const requests = scriptLlm([reply(withFirstName)]);

  const second = await refineSpec(turns, profiles);

  assert.ok(second.text.includes('- voornaam: persoon › voornaam'));
  const messages = requests[0].body.messages;
  assert.deepEqual(messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages[2].content, first.text);
  assert.equal(messages[3].content, `Voeg ook de voornaam toe.\n\nThe current plan:\n${JSON.stringify(PLAN)}`);
});

test('propose: a long code list is not shown to the model, a wrong name of it still comes back', async () => {
  const lists = buildTestLists();
  const status = 'http://lblod.data.gift/vocabularies/organisatie/MandatarisStatusCode';
  lists.set(status, { values: Array.from({ length: 80 }, (_, i) => ({ uri: `http://example.org/status/${i}`, label: `Status ${i}` })), more: false });
  database.answer = (query, options) => answerNames(query, options, lists);
  const requests = scriptLlm([reply({ ...PLAN, filters: [{ path: ['status'], is: 'Status 100' }] }), reply({ ...PLAN, filters: [{ path: ['status'], is: 'status 7' }] })]);

  const { text } = await propose(QUESTION, profiles);

  assert.ok(text.includes('- status is Status 7'));
  assert.ok(!requests[0].body.messages[0].content.includes('Status 7;'));
  assert.match(requests[1].body.messages.at(-1).content, /- filters\[0\]: "Status 100" is not a code of MandatarisStatus\./);
});
