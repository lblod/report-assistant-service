import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/runner/spec.js';
import { checkSpec } from '../src/runner/check.js';
import { loadTestProfiles, mandatenSpec, PREFIXES } from './support/profiles.js';

const profiles = loadTestProfiles();
const check = (turtle) => checkSpec(parseSpec(turtle), profiles);
const NAME = '[ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ]';

test('checkSpec: a spec that follows the profile passes', () => {
  assert.equal(check(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path mandaat:start ; sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ] ;
    sh:property [ sh:path ( org:holds org:role ) ; sh:hasValue <http://example.org/burgemeester> ] ;
    rep:columns ( [ sh:path rep:self ; rdfs:label "mandataris" ] ${NAME} )`)), null);
});

test('checkSpec: an unknown profile names the profiles there are', () => {
  const turtle = `${PREFIXES}
    <http://example.org/s> a rep:ReportSpec ; dct:title "x" ;
      rep:profile <http://example.org/no-such-profile> ;
      sh:targetClass mandaat:Mandataris ; rep:columns ( ${NAME} ) .`;
  assert.match(check(turtle), /no profile <http:\/\/example.org\/no-such-profile>\. Available: Mandaten, Organisaties\./);
});

test('checkSpec: a class two entities share asks for rep:entity', () => {
  const columns = 'rep:columns ( [ sh:path rep:self ; rdfs:label "orgaan" ] )';
  assert.match(check(mandatenSpec(`sh:targetClass besluit:Bestuursorgaan ; ${columns}`)),
    /is the class of 2 entities.*Add rep:entity/);
  assert.equal(check(mandatenSpec(`sh:targetClass besluit:Bestuursorgaan ; rep:entity ent:BestuursorgaanInTijd ; ${columns}`)), null);
});

test('checkSpec: a step the entity does not have lists the fields it has', () => {
  const error = check(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    rep:columns ( [ sh:path ( mandaat:isBestuurlijkeAliasVan skos:prefLabel ) ; rdfs:label "naam" ] )`));
  assert.match(error, /at "persoon" there is no "http:\/\/www.w3.org\/2004\/02\/skos\/core#prefLabel"/);
  assert.match(error, /voornaam \(http:\/\/xmlns.com\/foaf\/0.1\/givenName\)/);
});

test('checkSpec: a column ends on a value, a filter needs a condition, a spec needs columns', () => {
  assert.match(check(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    rep:columns ( [ sh:path mandaat:isBestuurlijkeAliasVan ; rdfs:label "persoon" ] )`)), /ends on a link\. Add a hop/);
  assert.match(check(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path mandaat:start ] ; rep:columns ( ${NAME} )`)), /filter 1 .* has no condition/);
  assert.match(check(mandatenSpec('sh:targetClass mandaat:Mandataris')), /no columns/);
});
