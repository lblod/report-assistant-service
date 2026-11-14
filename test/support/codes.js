// What the service scope reads of the test profiles: the code lists, and of
// the bestuurseenheden just one, like the public graph of the portal.
import { createCodes } from '../../src/plan/codes.js';
import { uri, literal, rows } from './mu.mjs';

const CODE = 'http://lblod.data.gift/vocabularies/organisatie/';
export const BESTUURSEENHEID = 'http://data.vlaanderen.be/ns/besluit#Bestuurseenheid';

// class -> names; a name's URI is "http://example.org/<list>/<name in lower case with dashes>"
const LISTS = {
  [`${CODE}BestuurseenheidClassificatieCode`]: ['soort-bestuur', ['Gemeente', 'OCMW', 'Provincie']],
  [`${CODE}BestuursorgaanClassificatieCode`]: ['soort-orgaan', ['Gemeenteraad', 'College van burgemeester en schepenen']],
  [`${CODE}BestuursfunctieCode`]: ['bestuursfunctie', ['Burgemeester', 'Schepen', 'Voorzitter van de gemeenteraad']],
  [`${CODE}MandatarisStatusCode`]: ['status', ['Effectief', 'Verhinderd', 'Waarnemend']],
  [`${CODE}OrganisatieStatusCode`]: ['organisatiestatus', ['Actief', 'Niet actief']],
  [`${CODE}TypeVestiging`]: ['type-vestiging', ['Gemeentehuis', 'Maatschappelijke zetel']],
  [`${CODE}Rechtsvorm`]: ['rechtsvorm', ['VZW', 'Stichting']],
  [BESTUURSEENHEID]: ['eenheid', ['Agentschap Binnenlands Bestuur']],
};

// The URI of a code of the test lists, e.g. codeUri('status', 'Verhinderd').
export function codeUri(list, name) {
  return `http://example.org/${list}/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function buildTestLists() {
  return new Map(Object.entries(LISTS).map(([classUri, [list, names]]) => [
    classUri,
    { values: names.map(name => ({ uri: codeUri(list, name), label: name })), more: false },
  ]));
}

export const codes = createCodes(buildTestLists());

// The answer of the database to the query that reads the names of one
// class (plan/read-codes.js), from the test lists; undefined for any other
// query. Only for the service scope, like the public graph in a stack.
export function answerNames(query, options, lists = buildTestLists()) {
  const asked = query.match(/\?uri a <([^>]+)> ;\s+<[^>]+> \?label \.\s+\} LIMIT \d+$/);
  if (!asked) return undefined;
  if (options.scope !== 'http://services.semantic.works/report-assistant') return rows();
  return rows(...(lists.get(asked[1])?.values || []).map(v => ({ uri: uri(v.uri), label: literal(v.label) })));
}
