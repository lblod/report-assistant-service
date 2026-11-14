// The test profiles (test/fixtures/profiles) and the Turtle around a test spec.
import { fileURLToPath } from 'node:url';
import { loadProfiles } from '../../src/runner/profile.js';

export const PROFILE_DIR = fileURLToPath(new URL('../fixtures/profiles', import.meta.url));
export const MANDATEN = 'http://data.lblod.info/id/report-profiles/mandaten';
export const ORGANISATIES = 'http://data.lblod.info/id/report-profiles/organisaties';
export const ENT = 'http://data.lblod.info/id/report-entities/';

// The profiles as the service loads them at boot, without its log lines.
export function loadTestProfiles() {
  const log = console.log;
  console.log = () => {};
  try {
    return loadProfiles(PROFILE_DIR);
  } finally {
    console.log = log;
  }
}

export const PREFIXES = `@prefix rep: <http://mu.semte.ch/vocabularies/reporting/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix org: <http://www.w3.org/ns/org#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix mandaat: <http://data.vlaanderen.be/ns/mandaat#> .
@prefix besluit: <http://data.vlaanderen.be/ns/besluit#> .
@prefix generiek: <https://data.vlaanderen.be/ns/generiek#> .
@prefix ent: <http://data.lblod.info/id/report-entities/> .
`;

// A spec on the Mandaten profile: the body is what follows the type, e.g.
// 'sh:targetClass mandaat:Mandataris ; rep:columns ( ... )'.
export function mandatenSpec(body, { title = 'Test' } = {}) {
  return `${PREFIXES}
<http://data.lblod.info/id/report-specs/test> a rep:ReportSpec , sh:NodeShape ;
  ${title === null ? '' : `dct:title "${title}" ;`}
  rep:profile <${MANDATEN}> ;
  ${body} .
`;
}
