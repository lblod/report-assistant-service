import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/runner/spec.js';
import { checkSpec } from '../src/runner/check.js';
import { describeSpec, listValueUris } from '../src/runner/render.js';
import { loadTestProfiles, mandatenSpec, MANDATEN, ORGANISATIES, PREFIXES } from './support/profiles.js';

const profiles = loadTestProfiles();
const CODE = 'http://example.org/code/';
const NAMES = new Map([['burgemeester', 'Burgemeester'], ['gemeente', 'Gemeente'], ['effectief', 'Effectief'], ['waarnemend', 'Waarnemend']]
  .map(([id, name]) => [CODE + id, name]));
const labelOf = (uri) => NAMES.get(uri);
const NAME = '[ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ]';
const TO_EENHEID = 'org:holds [ sh:inversePath org:hasPost ] generiek:isTijdspecialisatieVan besluit:bestuurt';

// The description of a spec on the Mandaten profile. The spec must pass the
// validator: only such a spec gets a description.
function describe(body, names = labelOf) {
  const spec = parseSpec(mandatenSpec(body));
  assert.equal(checkSpec(spec, profiles), null);
  return describeSpec(spec, profiles.get(MANDATEN), names);
}
// The text of one filter of a mandataris spec.
const filter = (turtle) => describe(`sh:targetClass mandaat:Mandataris ; sh:property [ ${turtle} ] ; rep:columns ( ${NAME} )`)
  .match(/^Eén rij per mandataris\. Filters: (.*)\. Kolommen: achternaam\.$/)[1];

test('describeSpec: what a row is, the filters and the columns, in the names of the profile', () => {
  const body = `sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path ( org:holds org:role ) ; sh:hasValue <${CODE}burgemeester> ] ;
    sh:property [ sh:path mandaat:start ; sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ;
                  sh:maxInclusive "2025-12-31T23:59:59"^^xsd:dateTime ] ;
    rep:columns ( [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:givenName ) ; rdfs:label "voornaam" ] ${NAME} )`;

  assert.equal(describe(body),
    'Eén rij per mandataris. Filters: bekleedt mandaat › bestuursfunctie is Burgemeester; '
    + 'start vanaf 2025-01-01 tot en met 2025-12-31. Kolommen: voornaam, achternaam.');
  assert.match(describe(body, () => null), /bestuursfunctie is <http:\/\/example.org\/code\/burgemeester>;/,
    'a URI without a known name shows as it is');
  assert.equal(describe(`sh:targetClass mandaat:Mandataris ; rep:columns ( ${NAME} )`),
    'Eén rij per mandataris. Geen filters. Kolommen: achternaam.');
});

test('describeSpec: a rep:where says which thing it shares with its filter', () => {
  assert.equal(filter(`sh:path ( ${TO_EENHEID} org:classification ) ; sh:hasValue <${CODE}gemeente> ;
      rep:where [ sh:path ( ${TO_EENHEID} skos:prefLabel ) ; sh:pattern "^(Dilbeek)$" ; sh:flags "i" ]`),
  'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › soort bestuur is Gemeente '
    + '(zelfde bestuurseenheid: naam is "Dilbeek")');
});

test('describeSpec: a rep:where on the very step it shares reads by the name of that step', () => {
  assert.equal(filter(`sh:path ( org:holds org:role skos:prefLabel ) ; sh:pattern "raad" ; sh:flags "i" ;
      rep:where [ sh:path ( org:holds org:role ) ; sh:hasValue <${CODE}burgemeester> ]`),
  'bekleedt mandaat › bestuursfunctie › naam bevat "raad" (bestuursfunctie is Burgemeester)');
  assert.equal(filter(`sh:path mandaat:einde ; sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ;
      rep:where [ sh:path mandaat:einde ; sh:maxInclusive "2025-12-31T23:59:59"^^xsd:dateTime ]`),
  'einde vanaf 2025-01-01 (einde tot en met 2025-12-31)');
});

test('describeSpec: every test a filter can hold', () => {
  assert.equal(filter(`sh:path mandaat:status ; sh:in ( <${CODE}effectief> <${CODE}waarnemend> )`), 'status is een van Effectief, Waarnemend');
  assert.equal(filter('sh:path mandaat:status ; sh:maxCount 0'), 'status ontbreekt');
  assert.equal(filter('sh:path mandaat:einde ; sh:minCount 1'), 'einde is ingevuld');
  assert.equal(filter('sh:path ( mandaat:isBestuurlijkeAliasVan [ sh:inversePath mandaat:isBestuurlijkeAliasVan ] ) ; sh:minCount 2'),
    'persoon › mandatarissen heeft minstens twee verschillende waarden');
  assert.equal(filter('sh:path ( org:holds org:role skos:prefLabel ) ; sh:pattern "penningmeester" ; sh:flags "i" ; sh:maxCount 0'),
    'geen enkele bekleedt mandaat › bestuursfunctie › naam bevat "penningmeester"');
  assert.equal(filter('sh:path ( org:holds org:role skos:prefLabel ) ; rep:anyOf ( "raad" "college" )'),
    'bekleedt mandaat › bestuursfunctie › naam bevat een van de woorden "raad", "college"');
  assert.equal(filter('sh:path mandaat:start ; sh:minExclusive "2025-01-01T12:00:00"^^xsd:dateTime ; sh:maxExclusive "2026-01-01T00:00:00"^^xsd:dateTime'),
    'start na 2025-01-01T12:00:00 voor 2026-01-01T00:00:00');
  assert.equal(filter('sh:path ( org:holds mandaat:aantalHouders ) ; sh:minInclusive 2.0'), 'bekleedt mandaat › aantal houders vanaf 2.0');
});

test('describeSpec: the patterns the service writes read as words, any other regex shows as it is', () => {
  const name = (pattern, flags = ' ; sh:flags "i"') => filter(`sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; sh:pattern "${pattern}"${flags}`)
    .replace('persoon › achternaam ', '');
  assert.equal(name('^(Peeters)$'), 'is "Peeters"');
  assert.equal(name('^(Peeters|De Smet)$'), 'is een van "Peeters", "De Smet"');
  assert.equal(name('Sint\\\\-Niklaas \\\\(stad\\\\)'), 'voldoet aan het patroon "Sint\\-Niklaas \\(stad\\)"', 'a hyphen is never escaped by the service');
  assert.equal(name('Sint-Niklaas \\\\(stad\\\\)'), 'bevat "Sint-Niklaas (stad)"');
  assert.equal(name('Peeters', ''), 'bevat "Peeters" (hoofdlettergevoelig)');
  assert.equal(name('^[A-C]'), 'voldoet aan het patroon "^[A-C]"');
  assert.equal(name('^(Pee|\\\\d+)$'), 'voldoet aan het patroon "^(Pee|\\d+)$"');
});

test('describeSpec: a boolean reads as ja or nee, a long text is cut at 300 characters', () => {
  const turtle = (filters) => `${PREFIXES}
    <http://example.org/s> a rep:ReportSpec ; dct:title "x" ; rep:profile <${ORGANISATIES}> ;
      sh:targetClass org:Organization ; ${filters}
      rep:columns ( [ sh:path skos:prefLabel ; rdfs:label "naam" ] ) .`;
  const describeOrganisaties = (filters) => {
    const spec = parseSpec(turtle(filters));
    assert.equal(checkSpec(spec, profiles), null);
    return describeSpec(spec, profiles.get(ORGANISATIES));
  };
  assert.equal(describeOrganisaties('sh:property [ sh:path <http://mu.semte.ch/vocabularies/ext/isActief> ; sh:hasValue true ] ;'),
    'Eén rij per organisatie. Filters: actief is ja. Kolommen: naam.');

  const many = Array.from({ length: 12 }, (_, i) => `sh:property [ sh:path skos:prefLabel ; sh:pattern "een lange naam nummer ${i}" ] ;`).join('\n');
  const long = describeOrganisaties(many);
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('\n'));
});

test('listValueUris: the URIs of filters and of rep:where on filters and columns, each once', () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path mandaat:status ; sh:in ( <${CODE}effectief> <${CODE}waarnemend> ) ] ;
    sh:property [ sh:path ( org:holds org:role ) ; sh:minCount 1 ;
                  rep:where [ sh:path ( org:holds org:role ) ; sh:hasValue <${CODE}burgemeester> ] ] ;
    sh:property [ sh:path mandaat:start ; sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ] ;
    rep:columns ( [ sh:path ( org:holds mandaat:aantalHouders ) ; rdfs:label "houders" ;
                    rep:where [ sh:path ( org:holds org:role ) ; sh:hasValue <${CODE}effectief> ] ] )`));
  assert.deepEqual(listValueUris(spec), [`${CODE}effectief`, `${CODE}waarnemend`, `${CODE}burgemeester`]);
});
