import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/runner/spec.js';
import { runReport } from '../src/runner/run.js';
import { assemble } from '../src/runner/assemble.js';
import { database, uri, literal, rows } from './support/mu.mjs';
import { loadTestProfiles, mandatenSpec, MANDATEN } from './support/profiles.js';

const profiles = loadTestProfiles();
const profile = profiles.get(MANDATEN);
const M = (n) => `http://example.org/mandataris/${n}`;
const P = (n) => `http://example.org/persoon/${n}`;

beforeEach(() => database.reset());

test('runReport: one seed query, one query per column, the values paired into a CSV', async () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path ( org:holds org:role ) ; sh:hasValue <http://example.org/burgemeester> ] ;
    rep:columns (
      [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:givenName ) ; rdfs:label "voornaam" ]
      [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ]
      [ sh:path mandaat:start ; rdfs:label "start" ]
    )`));
  database.answer = (query) => {
    if (query.startsWith('SELECT DISTINCT ?s WHERE')) return rows({ s: uri(M(1)) }, { s: uri(M(2)) });
    if (query.includes('givenName')) {
      return rows({ s: uri(M(1)), x_1: uri(P(1)), v: literal('Jan') }, { s: uri(M(2)), x_1: uri(P(2)), v: literal('An') });
    }
    if (query.includes('familyName')) {
      return rows({ s: uri(M(1)), x_1: uri(P(1)), v: literal('Peeters') }, { s: uri(M(2)), x_1: uri(P(2)), v: literal('Jans; De Smet') });
    }
    return rows({ s: uri(M(1)), v: literal('2025-01-01T00:00:00Z') });
  };

  const csv = await runReport(spec, profile);

  assert.equal(csv, [
    'voornaam;achternaam;start',
    'Jan;Peeters;2025-01-01T00:00:00Z',
    'An;"Jans; De Smet";',
  ].join('\n'));

  const [seed, ...columns] = database.calls.map(c => c.query);
  assert.match(seed, /\?s a <http:\/\/data.vlaanderen.be\/ns\/mandaat#Mandataris> \./);
  assert.match(seed, /FILTER\(\?f0_v = <http:\/\/example.org\/burgemeester>\)/);
  assert.match(seed, /ORDER BY \?s\nLIMIT 5000 OFFSET 0$/);
  assert.equal(columns.length, 3);
  assert.ok(columns.every(q => q.includes(`VALUES ?s { <${M(1)}> <${M(2)}> }`)));
  assert.ok(database.calls.every(c => c.kind === 'query' && c.options.scope === undefined),
    'the run reads as the caller: no scope, no update');
});

test('runReport: the discriminators of the entity go into the seed query', async () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass besluit:Bestuursorgaan ; rep:entity ent:BestuursorgaanInTijd ;
    rep:columns ( [ sh:path rep:self ; rdfs:label "orgaan" ] )`));
  database.answer = () => rows({ s: uri('http://example.org/orgaan/1') });

  const csv = await runReport(spec, profile);

  assert.equal(csv, 'orgaan\nhttp://example.org/orgaan/1');
  assert.equal(database.calls.length, 1, 'a rep:self column needs no query');
  assert.match(database.calls[0].query, /\?s <https:\/\/data.vlaanderen.be\/ns\/generiek#isTijdspecialisatieVan> \?disc0_v \./);
});

test('assemble: columns through the same node stay on one row, sh:groupConcat folds a column', () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass besluit:Bestuurseenheid ;
    rep:columns (
      [ sh:path skos:prefLabel ; rdfs:label "eenheid" ]
      [ sh:path ( [ sh:inversePath besluit:bestuurt ] org:classification skos:prefLabel ) ; rdfs:label "organen" ;
        rep:collect sh:groupConcat ; sh:separator " | " ]
    )`));
  const eenheid = 'http://example.org/eenheid/1';
  const values = new Map([[eenheid, new Map([
    [0, [[literal('Aalst')]]],
    [1, [
      [uri('http://example.org/orgaan/1'), uri('http://example.org/code/raad'), literal('Gemeenteraad')],
      [uri('http://example.org/orgaan/2'), uri('http://example.org/code/college'), literal('College')],
    ]],
  ])]]);

  assert.deepEqual(assemble([eenheid, 'http://example.org/eenheid/2'], values, spec), [
    ['eenheid', 'organen'],
    ['Aalst', 'College | Gemeenteraad'],
    ['', ''],
  ]);
});

test('assemble: the order the database answers in does not change the report', () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass besluit:Bestuurseenheid ;
    rep:columns (
      [ sh:path ( [ sh:inversePath besluit:bestuurt ] org:classification skos:prefLabel ) ; rdfs:label "orgaan" ]
      [ sh:path ( [ sh:inversePath besluit:bestuurt ] [ sh:inversePath generiek:isTijdspecialisatieVan ] mandaat:bindingStart ) ;
        rdfs:label "periodes" ; rep:collect sh:groupConcat ]
    )`));
  const eenheid = 'http://example.org/eenheid/1';
  const orgaan = (n) => uri(`http://example.org/orgaan/${n}`);
  const names = [
    [orgaan(1), uri('http://example.org/code/raad'), literal('Gemeenteraad')],
    [orgaan(2), uri('http://example.org/code/college'), literal('College')],
    [orgaan(3), uri('http://example.org/code/burgemeester'), literal('Burgemeester')],
  ];
  const periods = [
    [orgaan(1), uri('http://example.org/tijd/1b'), literal('2025-01-01')],
    [orgaan(1), uri('http://example.org/tijd/1a'), literal('2019-01-01')],
    [orgaan(3), uri('http://example.org/tijd/3a'), literal('2019-01-01')],
  ];
  const report = (nameRows, periodRows) => assemble([eenheid], new Map([[eenheid, new Map([[0, nameRows], [1, periodRows]])]]), spec);

  const expected = [
    ['orgaan', 'periodes'],
    ['Gemeenteraad', '2019-01-01,2025-01-01'],
    ['College', ''],
    ['Burgemeester', '2019-01-01'],
  ];
  assert.deepEqual(report(names, periods), expected);
  assert.deepEqual(report([...names].reverse(), [...periods].reverse()), expected);
  assert.deepEqual(report([names[1], names[2], names[0]], [periods[2], periods[0], periods[1]]), expected);
});
