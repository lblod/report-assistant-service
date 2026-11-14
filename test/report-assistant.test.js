import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepareExecution, executeSpec } from '../src/report-assistant.js';
import { writeShareFile, SPEC_MEDIA_TYPE } from '../src/chat.js';
import { database, uri, literal, rows } from './support/mu.mjs';
import { loadTestProfiles, mandatenSpec } from './support/profiles.js';

const profiles = loadTestProfiles();
const SERVICE_SCOPE = 'http://services.semantic.works/report-assistant';
const COLUMNS = 'rep:columns ( [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ] )';

// A conversation whose last proposal carries this spec as its bijlage.
function historyWithSpec(turtle) {
  const name = `specificatie-${randomUUID()}.ttl`;
  writeShareFile(name, turtle);
  return [
    { role: 'user', content: 'Geef alle mandatarissen.', attachments: [] },
    { role: 'assistant', content: 'Voorstel ...', attachments: [{ uri: `http://example.org/files/${name}`, name, mediaType: SPEC_MEDIA_TYPE }] },
  ];
}

beforeEach(() => database.reset());

test('prepareExecution: the last spec bijlage of the conversation is the agreed spec', () => {
  const history = historyWithSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ; ${COLUMNS}`, { title: 'Mandatarissen' }));

  const prepared = prepareExecution(history, profiles);

  assert.equal(prepared.spec.title, 'Mandatarissen');
  assert.equal(prepared.attachment, history[1].attachments[0]);
  assert.deepEqual(prepareExecution(history.slice(0, 1), profiles),
    { text: 'Er is nog geen voorstel om uit te voeren. Beschrijf eerst welk rapport je wilt.' });
});

test('prepareExecution: an agreed spec without a title does not start a run', () => {
  const history = historyWithSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ; ${COLUMNS}`, { title: null }));

  assert.deepEqual(prepareExecution(history, profiles), { text: 'Het voorstel is niet meer geldig. Vraag een nieuw voorstel.' });
  assert.equal(database.calls.length, 0);
});

test('executeSpec: runs the agreed spec and records it with a description written from the spec, without the LLM', async () => {
  globalThis.fetch = () => { throw new Error('execution called the LLM'); };
  const effectief = 'http://example.org/status/effectief';
  const history = historyWithSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path mandaat:status ; sh:hasValue <${effectief}> ] ; ${COLUMNS}`, { title: 'Effectieve mandatarissen' }));
  const mandataris = uri('http://example.org/mandataris/1');
  database.answer = (query) => {
    if (query.includes('VALUES ?uri')) return rows({ uri: uri(effectief), label: literal('Effectief') });
    if (query.startsWith('SELECT DISTINCT ?s WHERE')) return rows({ s: mandataris });
    if (query.includes('VALUES ?s')) return rows({ s: mandataris, x_1: uri('http://example.org/persoon/1'), v: literal('Peeters') });
    return undefined;
  };

  const prepared = prepareExecution(history, profiles);
  const answer = await executeSpec(prepared, { uri: 'http://example.org/conversation/1' }, profiles);

  assert.equal(answer.text, 'Het rapport is uitgevoerd. De bijlagen staan erbij.');
  assert.equal(answer.attachments[1], history[1].attachments[0].uri, 'the agreed spec goes on the answer');

  const names = database.calls.find(c => c.query.includes('VALUES ?uri'));
  assert.equal(names.options.scope, SERVICE_SCOPE, 'the names of the filter values are read under the service scope');

  const updates = database.calls.filter(c => c.kind === 'update').map(c => c.query);
  const description = 'dct:description """Eén rij per mandataris. Filters: status is Effectief. Kolommen: achternaam."""';
  const [file, reportSpec, report] = updates;
  assert.match(reportSpec, /reporting\/ReportSpec> ;/);
  assert.ok(reportSpec.includes(description));
  assert.match(report, /reporting\/Report> ;/);
  assert.ok(report.includes(description));

  assert.ok(file.includes('nfo:fileName """effectieve-mandatarissen.csv"""'));
  const shareName = file.match(/<share:\/\/([^>]+\.csv)>/)[1];
  assert.equal(readFileSync(join(process.env.SHARE_DIR, shareName), 'utf8'), 'achternaam\nPeeters');
});
