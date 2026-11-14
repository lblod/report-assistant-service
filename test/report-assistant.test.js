import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareExecution } from '../src/report-assistant.js';
import { writeShareFile, SPEC_MEDIA_TYPE } from '../src/chat.js';
import { database } from './support/mu.mjs';
import { loadTestProfiles, mandatenSpec } from './support/profiles.js';

const profiles = loadTestProfiles();
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
