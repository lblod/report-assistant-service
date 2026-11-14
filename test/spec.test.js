import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/runner/spec.js';
import { MANDATEN, PREFIXES, mandatenSpec } from './support/profiles.js';

const MANDAAT = 'http://data.vlaanderen.be/ns/mandaat#';
const ORG = 'http://www.w3.org/ns/org#';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

test('parseSpec: title, profile, class, filters and columns as plain values', () => {
  const spec = parseSpec(mandatenSpec(`sh:targetClass mandaat:Mandataris ;
    sh:property [ sh:path mandaat:start ; sh:minInclusive "2025-01-01T00:00:00"^^xsd:dateTime ] ;
    sh:property [ sh:path ( org:holds [ sh:inversePath org:hasPost ] ) ; sh:minCount 1 ;
                  rep:where [ sh:path ( org:holds org:role ) ; sh:hasValue <http://example.org/burgemeester> ] ] ;
    rep:columns (
      [ sh:path rep:self ; rdfs:label "mandataris" ]
      [ sh:path ( mandaat:isBestuurlijkeAliasVan foaf:familyName ) ; rdfs:label "achternaam" ;
        rep:collect sh:groupConcat ; sh:separator " | " ]
    )`, { title: 'Burgemeesters' }));

  assert.equal(spec.title, 'Burgemeesters');
  assert.equal(spec.profileUri, MANDATEN);
  assert.equal(spec.targetClass, `${MANDAAT}Mandataris`);
  assert.equal(spec.entity, null);

  const [range, withWhere] = spec.filters;
  assert.deepEqual(range.path, [{ predicate: `${MANDAAT}start`, inverse: false }]);
  assert.deepEqual(range.constraints.minInclusive,
    { type: 'literal', value: '2025-01-01T00:00:00', datatype: `${XSD}dateTime`, language: null });
  assert.deepEqual(withWhere.path,
    [{ predicate: `${ORG}holds`, inverse: false }, { predicate: `${ORG}hasPost`, inverse: true }]);
  assert.equal(withWhere.constraints.minCount, 1);
  assert.deepEqual(withWhere.where[0].constraints.hasValue, { type: 'uri', value: 'http://example.org/burgemeester' });

  const [self, name] = spec.columns;
  assert.deepEqual(self.path, [], 'rep:self is the empty path');
  assert.equal(self.label, 'mandataris');
  assert.deepEqual(name.path,
    [{ predicate: `${MANDAAT}isBestuurlijkeAliasVan`, inverse: false }, { predicate: `${FOAF}familyName`, inverse: false }]);
  assert.equal(name.collect, `${SH}groupConcat`);
  assert.equal(name.separator, ' | ');
});

test('parseSpec: Turtle without a spec, or with two, is refused', () => {
  assert.throws(() => parseSpec(`${PREFIXES} <http://example.org/x> a sh:NodeShape .`), /no rep:ReportSpec/);
  const two = `${PREFIXES}
    <http://example.org/a> a rep:ReportSpec ; sh:targetClass mandaat:Mandataris .
    <http://example.org/b> a rep:ReportSpec ; sh:targetClass mandaat:Mandataris .`;
  assert.throws(() => parseSpec(two), /one spec per answer/);
  assert.throws(() => parseSpec('this is not Turtle'));
});
