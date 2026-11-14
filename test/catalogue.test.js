import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogue, renderCatalogue, findNameField, isCodeList } from '../src/plan/catalogue.js';
import { createCodes, NO_CODES } from '../src/plan/codes.js';
import { loadTestProfiles } from './support/profiles.js';
import { codes, buildTestLists, BESTUURSEENHEID } from './support/codes.js';

const profiles = loadTestProfiles();
const catalogue = buildCatalogue(profiles);
const entity = (profile, id) => catalogue.find(p => p.title === profile).entities.find(e => e.id === id);

test('buildCatalogue: entities by the last part of their URI, fields as value, code or link', () => {
  const mandataris = entity('Mandaten', 'Mandataris');
  assert.equal(mandataris.label, 'mandataris');
  assert.deepEqual(mandataris.fields.map(f => [f.name, f.targets]), [
    ['start', []], ['einde', []], ['status', ['MandatarisStatus']], ['persoon', ['Persoon']], ['bekleedt mandaat', ['Mandaat']],
  ]);
  assert.equal(entity('Mandaten', 'BestuursorgaanInTijd').shared, true, 'its class holds another entity too');
  assert.equal(mandataris.shared, false);

  const rechtsvorm = entity('Organisaties', 'Organisatie').fields.find(f => f.name === 'rechtsvorm');
  assert.equal(rechtsvorm.codeClass, 'http://lblod.data.gift/vocabularies/organisatie/Rechtsvorm');
  assert.deepEqual(rechtsvorm.targets, []);

  assert.equal(findNameField(entity('Mandaten', 'Bestuurseenheid')).name, 'naam');
  assert.equal(findNameField(entity('Organisaties', 'Adres')), null);
});

test('buildCatalogue: two entities or two fields with one name stop the profile', () => {
  const shape = (uri, fields = []) => ({ uri, label: 'x', targetClass: 'http://example.org/C', fields, discriminators: [] });
  const field = (name, path) => ({ name, path, inverse: false, datatype: 'http://www.w3.org/2001/XMLSchema#string', class: null, nodes: [] });
  const profile = (shapes) => new Map([['http://example.org/p', { uri: 'http://example.org/p', title: 'Dubbel', shapes }]]);

  assert.throws(() => buildCatalogue(profile([shape('http://example.org/a/Eenheid'), shape('http://example.org/b#eenheid')])),
    /profile "Dubbel": two entities are called "eenheid"/);
  assert.throws(() => buildCatalogue(profile([shape('http://example.org/a/Eenheid', [field('naam', 'http://example.org/p1'), field('Naam', 'http://example.org/p2')])])),
    /entity "Eenheid" has two fields called "naam"/);
});

test('isCodeList: a named entity without links whose names were read in full, nothing else', () => {
  assert.equal(isCodeList(entity('Mandaten', 'MandatarisStatus'), codes), true);
  assert.equal(isCodeList(entity('Mandaten', 'BestuursfunctieCode'), codes), false, 'it carries a link');
  assert.equal(isCodeList(entity('Mandaten', 'Bestuurseenheid'), codes), false, 'one is readable, the others are not');
  assert.equal(isCodeList(entity('Mandaten', 'MandatarisStatus'), NO_CODES), false, 'nothing was read');

  const lists = buildTestLists();
  lists.get('http://lblod.data.gift/vocabularies/organisatie/MandatarisStatusCode').more = true;
  assert.equal(isCodeList(entity('Mandaten', 'MandatarisStatus'), createCodes(lists)), false, 'the class holds more than was read');
});

test('renderCatalogue: names only, with types, hints and the short code lists', () => {
  const text = renderCatalogue(catalogue, codes);
  const lines = text.split('\n');
  const after = (start) => lines.slice(lines.indexOf(start), lines.indexOf(start) + 3);

  assert.deepEqual(after('Mandataris'), [
    'Mandataris',
    '  waarden: start (datum) [Start van de aanstelling], einde (datum)',
    '  links: status > MandatarisStatus [Status van de mandataris, bv. effectief, verhinderd], persoon > Persoon, bekleedt mandaat > Mandaat',
  ]);
  assert.ok(lines.includes('MandatarisStatus (status) — codes: Effectief; Verhinderd; Waarnemend'));
  assert.ok(lines.includes('BestuurseenheidClassificatie (soort bestuur) — codes: Gemeente; OCMW; Provincie'));
  assert.ok(lines.includes('BestuursfunctieCode (bestuursfunctie)'), 'a code list with a link shows no codes');
  assert.ok(lines.includes('Bestuurseenheid — wijs één bestuurseenheid aan met soort bestuur + naam'),
    'the one readable bestuurseenheid is not shown as a code');
  assert.ok(lines.includes('BestuursorgaanInTijd (bestuursorgaan in tijd)'));
  assert.ok(lines.includes('  waarden: naam, opgericht op (datum), actief (ja/nee), rechtsvorm (code: Stichting; VZW)'));
  assert.ok(lines.includes('PROFILE "Mandaten"') && lines.includes('PROFILE "Organisaties"'));
  assert.ok(!text.includes('http'), 'the model reads no URI');
  assert.ok(!text.includes(BESTUURSEENHEID));
});

test('renderCatalogue: a long code list is not shown, a long hint is cut', () => {
  const lists = buildTestLists();
  const status = 'http://lblod.data.gift/vocabularies/organisatie/MandatarisStatusCode';
  lists.set(status, { values: Array.from({ length: 61 }, (_, i) => ({ uri: `http://example.org/s/${i}`, label: `Status ${i}` })), more: false });
  assert.ok(renderCatalogue(catalogue, createCodes(lists)).split('\n').includes('MandatarisStatus (status)'));

  const long = structuredClone(catalogue);
  long[0].entities.find(e => e.id === 'Mandataris').fields[0].description = 'x'.repeat(200);
  const hint = renderCatalogue(long, codes).match(/start \(datum\) \[(x+…)\]/)[1];
  assert.equal(hint.length, 90);
});
