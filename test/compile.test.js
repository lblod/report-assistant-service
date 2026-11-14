import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../src/plan/compile.js';
import { NO_CODES } from '../src/plan/codes.js';
import { parseSpec } from '../src/runner/spec.js';
import { checkSpec } from '../src/runner/check.js';
import { describeSpec } from '../src/runner/render.js';
import { loadTestProfiles, MANDATEN, ORGANISATIES, ENT } from './support/profiles.js';
import { codes, codeUri } from './support/codes.js';

const profiles = loadTestProfiles();
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const TO_EENHEID = ['bekleedt mandaat', 'zit in bestuursorgaan', 'is tijdspecialisatie van', 'bestuurt'];
const ACHTERNAAM = { label: 'achternaam', path: ['persoon', 'achternaam'] };
const NAAM = { label: 'naam', path: ['naam'] };

const mandatarissen = (parts) => ({ profile: 'Mandaten', entity: 'Mandataris', title: 'Test', filters: [], columns: [ACHTERNAAM], ...parts });
const organisaties = (parts) => ({ profile: 'Organisaties', entity: 'Organisatie', title: 'Test', filters: [], columns: [NAAM], ...parts });

// The spec of a plan that must compile, parsed.
function compile(plan, withCodes = codes) {
  const { errors, notes, turtle } = compilePlan(plan, profiles, withCodes);
  assert.deepEqual(errors, []);
  const spec = parseSpec(turtle);
  assert.equal(checkSpec(spec, profiles), null);
  return { spec, notes, turtle };
}
// The spec of a plan in words (the description the service writes of it).
function describe(plan) {
  const { spec } = compile(plan);
  return describeSpec(spec, profiles.get(spec.profileUri), codes.labelOf);
}
// The words of the one filter of a plan.
const filter = (plan) => describe(plan).match(/Filters: (.*)\. Kolommen:/)[1];
// The errors of a plan that must not compile.
function errorsOf(plan, withCodes = codes) {
  const { errors, turtle } = compilePlan(plan, profiles, withCodes);
  assert.equal(turtle, undefined);
  return errors;
}

test('compilePlan: names become predicates and URIs, the spec passes the validator', () => {
  const { spec, notes } = compile(mandatarissen({
    title: 'Schepenen van Aalst gestart in 2024',
    filters: [
      { path: ['bekleedt mandaat', 'bestuursfunctie'], is: 'Schepen' },
      { path: ['start'], from: '2024-01-01', to: '2024-12-31' },
      { path: TO_EENHEID, is: { 'soort bestuur': 'Gemeente', naam: 'Aalst' } },
    ],
    columns: [ACHTERNAAM, { label: 'startdatum', path: ['start'] }],
  }));

  assert.equal(spec.title, 'Schepenen van Aalst gestart in 2024');
  assert.equal(spec.profileUri, MANDATEN);
  assert.equal(spec.targetClass, 'http://data.vlaanderen.be/ns/mandaat#Mandataris');
  assert.equal(spec.entity, `${ENT}Mandataris`);
  assert.deepEqual(notes, []);

  const [functie, start, eenheid] = spec.filters;
  assert.deepEqual(functie.constraints, { hasValue: { type: 'uri', value: codeUri('bestuursfunctie', 'Schepen') } });
  assert.equal(start.constraints.minInclusive.value, '2024-01-01T00:00:00Z');
  assert.equal(start.constraints.maxInclusive.value, '2024-12-31T23:59:59Z');
  assert.equal(start.constraints.minInclusive.datatype, `${XSD}dateTime`);
  // the soort is the filter, the name hangs on the same bestuurseenheid
  assert.equal(eenheid.path.length, 5);
  assert.deepEqual(eenheid.constraints, { hasValue: { type: 'uri', value: codeUri('soort-bestuur', 'Gemeente') } });
  assert.deepEqual(eenheid.where[0].constraints, { pattern: '^(Aalst)$', flags: 'i' });
  assert.equal(eenheid.where[0].path.at(-1).predicate, 'http://www.w3.org/2004/02/skos/core#prefLabel');
  assert.deepEqual(spec.columns.map(c => c.label), ['achternaam', 'startdatum']);

  assert.ok(describeSpec(spec, profiles.get(MANDATEN), codes.labelOf).startsWith(
    'Eén rij per mandataris. Filters: bekleedt mandaat › bestuursfunctie is Schepen; start vanaf 2024-01-01 tot en met 2024-12-31; '
    + 'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › soort bestuur is Gemeente '
    + '(zelfde bestuurseenheid: naam is "Aalst"). Kolommen: achternaam'));
});

test('compilePlan: a name the service cannot read is matched as the whole name, with a note for the user', () => {
  // the public graph holds one bestuurseenheid, and it is not Dilbeek
  const { spec, notes } = compile(mandatarissen({ filters: [{ path: TO_EENHEID, is: 'Dilbeek' }] }));
  assert.deepEqual(spec.filters[0].constraints, { pattern: '^(Dilbeek)$', flags: 'i' });
  assert.equal(spec.filters[0].path.at(-1).predicate, 'http://www.w3.org/2004/02/skos/core#prefLabel');
  assert.deepEqual(notes, ['De assistent kan niet nagaan of er een bestuurseenheid "Dilbeek" bestaat: het rapport zoekt op exact die naam.']);

  // the one it does read becomes its URI
  const abb = compile(mandatarissen({ filters: [{ path: TO_EENHEID, is: 'agentschap binnenlands bestuur' }] }));
  assert.deepEqual(abb.spec.filters[0].constraints, { hasValue: { type: 'uri', value: codeUri('eenheid', 'Agentschap Binnenlands Bestuur') } });
  assert.deepEqual(abb.notes, []);

  // several names, one of them unread: all are matched as names
  assert.equal(filter(mandatarissen({ filters: [{ path: TO_EENHEID, is_one_of: ['Aalst', 'Agentschap Binnenlands Bestuur'] }] })),
    'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › naam is een van "Aalst", "Agentschap Binnenlands Bestuur"');

  // a code list with a link (bestuursfunctie) is no closed list either
  const unknown = compile(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'bestuursfunctie'], is: 'Wethouder' }] }));
  assert.deepEqual(unknown.spec.filters[0].constraints, { pattern: '^(Wethouder)$', flags: 'i' });
  assert.match(unknown.notes[0], /een bestuursfunctie "Wethouder"/);

  // without anything read, every name is matched as a name
  assert.deepEqual(compile(mandatarissen({ filters: [{ path: ['status'], is: 'Verhinderd' }] }), NO_CODES).spec.filters[0].constraints,
    { pattern: '^(Verhinderd)$', flags: 'i' });
});

test('compilePlan: a wrong name of a code list is an error that shows the codes', () => {
  assert.equal(filter(mandatarissen({ filters: [{ path: ['status'], is: 'verhinderd' }] })), 'status is Verhinderd');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['status'], is_one_of: ['Effectief', 'Waarnemend'] }] })),
    'status is een van Effectief, Waarnemend');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['status'], is: { naam: 'Effectief' } }] })), 'status is Effectief');

  assert.deepEqual(errorsOf(mandatarissen({ filters: [{ path: ['status'], is: 'Afwezig' }] })),
    ['filters[0]: "Afwezig" (the codes are: Effectief; Verhinderd; Waarnemend) is not a code of MandatarisStatus. Use the exact name of a code, or "contains" for a text match.']);
  assert.deepEqual(errorsOf(mandatarissen({ filters: [{ path: ['status'], is: 'hinder' }] })),
    ['filters[0]: "hinder" (codes that contain it: Verhinderd) is not a code of MandatarisStatus. Use the exact name of a code, or "contains" for a text match.']);
});

test('compilePlan: filters on different fields of the same linked thing test that one thing', () => {
  const { spec } = compile(mandatarissen({ filters: [
    { path: ['persoon', 'voornaam'], is: 'Jan' },
    { path: ['persoon', 'achternaam'], contains: 'Peeters' },
    { path: ['start'], from: '2025-01-01' },
    { path: [...TO_EENHEID, 'soort bestuur'], is: 'Gemeente' },
    { path: [...TO_EENHEID, 'naam'], is: 'Aalst' },
  ] }));

  assert.equal(spec.filters.length, 3);
  assert.equal(describeSpec(spec, profiles.get(MANDATEN), codes.labelOf).match(/Filters: (.*)\. Kolommen/)[1],
    'persoon › voornaam is "Jan" (zelfde persoon: achternaam bevat "Peeters"); start vanaf 2025-01-01; '
    + 'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › soort bestuur is Gemeente (zelfde bestuurseenheid: naam is "Aalst")');

  // the same filter twice, the second time with a link left out, counts once
  assert.equal(compile(mandatarissen({ filters: [
    { path: TO_EENHEID, is: { 'soort bestuur': 'Gemeente', naam: 'Aalst' } },
    { path: ['bekleedt mandaat', 'zit in bestuursorgaan', 'bestuurt'], is: { 'soort bestuur': 'Gemeente', naam: 'Aalst' } },
  ] })).spec.filters.length, 1);

  // two tests on the same field, and tests on the row itself, stay apart
  assert.equal(compile(mandatarissen({ filters: [
    { path: ['persoon', 'achternaam'], contains: 'Pee' }, { path: ['persoon', 'achternaam'], contains: 'ters' },
    { path: ['start'], from: '2025-01-01' }, { path: ['einde'], exists: false },
  ] })).spec.filters.length, 4);
});

test('compilePlan: one link the model left out is filled in, a way round is not', () => {
  // "is tijdspecialisatie van" is missing between the orgaan in tijd and "bestuurt"
  const short = ['bekleedt mandaat', 'zit in bestuursorgaan', 'bestuurt'];
  assert.equal(filter(mandatarissen({ filters: [{ path: [...short, 'naam'], is: 'Aalst' }] })),
    'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › naam is "Aalst"');
  // the name of an entity instead of the link to it
  assert.equal(filter(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'BestuursorgaanInTijd', 'binding start'], from: '2025-01-01' }] })),
    'bekleedt mandaat › zit in bestuursorgaan › binding start vanaf 2025-01-01');
  // the name of the entity the path already stands on
  assert.equal(filter(mandatarissen({ filters: [{ path: ['Mandataris', 'persoon', 'Persoon', 'voornaam'], is: 'Jan' }] })), 'persoon › voornaam is "Jan"');
  // the type word of the catalogue copied into the name
  assert.equal(filter(mandatarissen({ filters: [{ path: ['start (datum)'], from: '2025-01-01' }] })), 'start vanaf 2025-01-01');

  // two links lead to an adres: the model has to choose
  assert.deepEqual(errorsOf(organisaties({ columns: [{ label: 'adres', path: ['adres', 'volledig adres'] }] })),
    ['columns[0]: step 1 "adres" is not a field of Organisatie, and it can be reached in 2 ways: hoofdvestiging › adres  |  vestiging › adres. Write the path out with the one you mean.']);
  // two links away is not filled in
  assert.match(errorsOf(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'bestuurt', 'naam'], is: 'Aalst' }] }))[0],
    /^filters\[0\]: step 2 "bestuurt" is not a field of Mandaat\. Fields there: aantal houders, bestuursfunctie, zit in bestuursorgaan, bekleders\.$/);
  // nor is a way back over the link just taken: the start of every bekleder of the mandaat is not the mandataris's own
  assert.match(errorsOf(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'start'], from: '2025-01-01' }] }))[0],
    /step 2 "start" is not a field of Mandaat/);
});

test('compilePlan: every kind of test', () => {
  assert.equal(filter(mandatarissen({ filters: [{ path: ['persoon', 'achternaam'], contains: 'Sint-Niklaas (stad)' }] })),
    'persoon › achternaam bevat "Sint-Niklaas (stad)"');
  assert.equal(filter(mandatarissen({ filters: [{ path: TO_EENHEID, contains: 'aalst' }] })),
    'bekleedt mandaat › zit in bestuursorgaan › is tijdspecialisatie van › bestuurt › naam bevat "aalst"');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['einde'], exists: false }] })), 'einde ontbreekt');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['bekleedt mandaat'], exists: true }] })), 'bekleedt mandaat is ingevuld');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['status'], none: { is: 'Verhinderd' } }] })), 'geen enkele status is Verhinderd');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'bestuursfunctie'], none: { contains: 'voorzitter' } }] })),
    'geen enkele bekleedt mandaat › bestuursfunctie › naam bevat "voorzitter"');
  assert.equal(filter(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'aantal houders'], from: 2, to: '10' }] })),
    'bekleedt mandaat › aantal houders vanaf 2 tot en met 10');
  assert.equal(filter(organisaties({ filters: [{ path: ['actief'], is: 'ja' }] })), 'actief is ja');
  assert.equal(filter(organisaties({ filters: [{ path: ['actief'], is: false }] })), 'actief is nee');
  assert.equal(filter(organisaties({ filters: [{ path: ['rechtsvorm'], is: 'vzw' }] })), 'rechtsvorm is VZW');

  // a date field takes a day, a dateTime field the whole day
  const dated = compile(organisaties({ filters: [{ path: ['opgericht op'], from: '2001-02-03', to: '2001-02-04T10:00:00' }] })).spec.filters[0].constraints;
  assert.deepEqual(dated.minInclusive, { type: 'literal', value: '2001-02-03', datatype: `${XSD}date`, language: null });
  assert.equal(dated.maxInclusive.value, '2001-02-04');
  // a number is written as the runner reads one
  const counted = compile(mandatarissen({ filters: [{ path: ['bekleedt mandaat', 'aantal houders'], from: 2 }] })).spec.filters[0].constraints;
  assert.deepEqual(counted.minInclusive, { type: 'literal', value: '2', datatype: `${XSD}integer`, language: null });
});

test('compilePlan: a test that does not fit its path says what to write instead', () => {
  const error = (cond) => errorsOf(mandatarissen({ filters: [cond] }))[0];
  assert.equal(error({ path: ['start'] }), 'filters[0]: no condition. Add one of: is, is_one_of, contains, from/to, exists, none.');
  assert.equal(error({ path: ['start'], is: '2025-01-01' }), 'filters[0]: use "from" and "to" on a date or number field.');
  assert.equal(error({ path: ['start'], from: '2025-02-30' }), 'filters[0]: "from" must be a date as YYYY-MM-DD.');
  assert.equal(error({ path: ['start'], from: 'vorig jaar' }), 'filters[0]: "from" must be a date as YYYY-MM-DD.');
  assert.equal(error({ path: ['bekleedt mandaat', 'aantal houders'], to: '2.5' }), 'filters[0]: "to" must be a whole number.');
  assert.equal(error({ path: ['persoon', 'achternaam'], from: '2025-01-01' }), 'filters[0]: from/to needs a path that ends on a date or number field.');
  assert.equal(error({ path: ['persoon', 'achternaam'], is: 'Jan', contains: 'a' }),
    'filters[0]: several conditions (is, contains). Give exactly one (from and to may go together).');
  assert.equal(error({ path: ['persoon', 'achternaam'], is: { naam: 'Jan' } }),
    'filters[0]: "is" with an object needs a path that ends on an entity (a link field). This path ends on a value: write "is": "<value>".');
  assert.equal(error({ path: [], is: 'x' }), 'filters[0]: "path" is empty. A filter needs at least one field.');
  assert.equal(error({ path: ['persoon'], is: 'Jan' }),
    'filters[0]: the path ends on Persoon, which has no name field. Add one of its fields to the path: voornaam, achternaam, mandatarissen.');
  assert.equal(error({ path: ['status'], none: { none: { is: 'Effectief' } } }), 'filters[0]: "none" inside "none" is not possible. Write the condition itself.');
  assert.equal(error({ path: ['persoon', 'achternaam'], contains: '' }), 'filters[0]: "contains" needs a text.');
  assert.equal(error({ path: TO_EENHEID, is: { soort: 'Gemeente' } }),
    'filters[0]: "soort" is not a field of Bestuurseenheid. Fields there: naam, soort bestuur, bestuursorganen. Did you mean "soort bestuur"?');

  const code = (cond) => errorsOf(organisaties({ filters: [{ path: ['rechtsvorm'], ...cond }] }))[0];
  assert.equal(code({ is: 'BV' }), 'filters[0]: "BV" (the codes are: Stichting; VZW) is not a code of "rechtsvorm". Use the exact name of a code.');
  assert.equal(code({ contains: 'vz' }), 'filters[0]: the path ends on a code, which has no text to search. Use "is" with the name of the code.');
  assert.deepEqual(errorsOf(organisaties({ filters: [{ path: ['rechtsvorm'], is: 'VZW' }] }), NO_CODES),
    ['filters[0]: the codes of "rechtsvorm" cannot be read, so none of them can be named. Use "exists", or leave the filter out.']);
});

test('compilePlan: columns', () => {
  const { spec } = compile(mandatarissen({ columns: [
    { label: 'uri', path: [] },
    { label: 'status', path: ['status'] },
    { label: 'functies', path: ['persoon', 'mandatarissen', 'bekleedt mandaat', 'bestuursfunctie', 'naam'], collect: 'join', separator: ' | ' },
    { label: 'eerste start', path: ['persoon', 'mandatarissen', 'start'], collect: 'min' },
    { label: 'gemeente', path: TO_EENHEID, only_where: { path: [...TO_EENHEID, 'soort bestuur'], is: 'Gemeente' } },
  ] }));
  const [uri, status, functies, eersteStart, gemeente] = spec.columns;

  assert.deepEqual(uri.path, [], 'an empty path is the row itself');
  assert.equal(status.path.at(-1).predicate, 'http://www.w3.org/2004/02/skos/core#prefLabel', 'a link shows the name of what it reaches');
  assert.equal(functies.collect, 'http://www.w3.org/ns/shacl#groupConcat');
  assert.equal(functies.separator, ' | ');
  assert.equal(eersteStart.collect, 'http://www.w3.org/ns/shacl#min');
  assert.equal(gemeente.path.length, 5);
  assert.deepEqual(gemeente.where[0].constraints, { hasValue: { type: 'uri', value: codeUri('soort-bestuur', 'Gemeente') } });

  const error = (column) => errorsOf(mandatarissen({ columns: [ACHTERNAAM, column] }))[0];
  assert.equal(error({ label: 'achternaam', path: ['persoon', 'voornaam'] }), 'columns[1]: the label "achternaam" is used twice. Labels must differ.');
  assert.equal(error({ path: ['start'] }), 'columns[1]: needs a "label".');
  assert.equal(error({ label: 'start' }), 'columns[1]: needs a "path". [] is the URI of the row itself.');
  assert.equal(error({ label: 'x', path: ['persoon', 'achternaam'], collect: 'max' }), 'columns[1]: "collect": "max" needs a path that ends on a date or number field.');
  assert.equal(error({ label: 'x', path: ['start'], collect: 'count' }), 'columns[1]: "collect" is "join", "min" or "max".');
  assert.equal(error({ label: 'x', path: ['start'], only_where: { path: ['status'], is: 'Effectief' } }),
    'columns[1].only_where: its path must begin with the same step as the path of the column.');
  assert.equal(error({ label: 'x', path: TO_EENHEID, only_where: { path: TO_EENHEID, is: { 'soort bestuur': 'Gemeente', naam: 'Aalst' } } }),
    'columns[1].only_where: "is" with several fields is not possible here. Test one field.');
  assert.deepEqual(errorsOf(organisaties({ columns: [{ label: 'adres', path: ['hoofdvestiging', 'adres'] }] })),
    ['columns[0]: the path ends on Adres, which has no name field. Add one of its fields to the path: volledig adres, postcode.']);
  assert.deepEqual(errorsOf(mandatarissen({ columns: [] })), ['"columns" needs at least one column.']);
});

test('compilePlan: the profile and the entity', () => {
  // the right entity under the wrong profile, or under none
  assert.equal(compile({ profile: 'Mandaten', entity: 'Organisatie', columns: [NAAM] }).spec.profileUri, ORGANISATIES);
  assert.equal(compile({ entity: 'organisatie', columns: [NAAM] }).spec.profileUri, ORGANISATIES);
  // by its label when one entity carries it; the title falls back on the entity
  const byLabel = compile({ profile: 'mandaten', entity: 'bestuursorgaan in tijd', columns: [{ label: 'start', path: ['binding start'] }] }).spec;
  assert.equal(byLabel.entity, `${ENT}BestuursorgaanInTijd`);
  assert.equal(byLabel.title, 'bestuursorgaan in tijd');

  assert.deepEqual(errorsOf({ profile: 'Mandaten', entity: 'Burgemeester', columns: [NAAM] }),
    ['"entity": no entity "Burgemeester" in profile "Mandaten". Entities: Bestuurseenheid, BestuurseenheidClassificatie, Bestuursorgaan, BestuursorgaanClassificatie, BestuursorgaanInTijd, Mandaat, BestuursfunctieCode, Mandataris, MandatarisStatus, Persoon.']);
  assert.deepEqual(errorsOf({ profile: 'Rapporten', entity: 'Rapport', columns: [NAAM] }),
    ['"profile": no profile "Rapporten". Profiles: Mandaten, Organisaties.']);
  // an entity that lives in both profiles needs its profile
  assert.deepEqual(errorsOf({ entity: 'Adres', columns: [NAAM] }).length, 1);
  assert.deepEqual(errorsOf('Mandataris'), ['the plan is not a JSON object.']);
  assert.deepEqual(errorsOf([mandatarissen({})]), ['the plan is not a JSON object.']);
});

test('compilePlan: every mistake of a plan comes back at once', () => {
  assert.deepEqual(errorsOf(mandatarissen({
    filters: [{ path: ['status'], is: 'Afwezig' }, { path: ['begin'], from: '2025-01-01' }],
    columns: [{ label: 'naam', path: ['persoon', 'naam'] }, { label: 'start', path: ['start'], collect: 'som' }],
  })), [
    'filters[0]: "Afwezig" (the codes are: Effectief; Verhinderd; Waarnemend) is not a code of MandatarisStatus. Use the exact name of a code, or "contains" for a text match.',
    'filters[1]: step 1 "begin" is not a field of Mandataris. Fields there: start, einde, status, persoon, bekleedt mandaat.',
    'columns[0]: step 2 "naam" is not a field of Persoon. Fields there: voornaam, achternaam, mandatarissen. Did you mean "voornaam"?',
    'columns[1]: "collect" is "join", "min" or "max".',
  ]);
});

test('compilePlan: text in a plan cannot break out of the spec', () => {
  const tricky = 'O\'Brien" ; sh:minCount 0 ] . <http://x> a rep:ReportSpec . # \\ \n {}';
  const { spec } = compile(mandatarissen({
    title: tricky,
    filters: [{ path: ['persoon', 'achternaam'], contains: tricky }],
    columns: [{ label: tricky, path: ['persoon', 'achternaam'], collect: 'join', separator: tricky }],
  }));
  assert.equal(spec.title, tricky.trim());
  assert.equal(spec.columns[0].label, tricky);
  assert.equal(spec.columns[0].separator, tricky);
  assert.ok(new RegExp(spec.filters[0].constraints.pattern, 'i').test(`x ${tricky} y`), 'the pattern matches the text itself');
  assert.equal(spec.filters.length, 1);
});
