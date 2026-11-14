// Reads the names the compiler resolves (codes.js) from the database, under
// the service scope: the same public data the tool loop looks up, the same
// for every caller. What was read is kept for a while.
import { sparqlEscapeUri } from 'mu';
import { queryPublic } from '../llm/explore.js';
import { findNameField } from './catalogue.js';
import { createCodes } from './codes.js';

const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';
// Names read of one class, at most. A class with more is not a list to pick
// from: its names are then matched as text.
const NAMES_MAX = 1000;
// How long the names are kept before they are read again, in ms. A code that
// a migration adds shows up after this, or after a restart.
const MAX_AGE = 10 * 60 * 1000;

// { at, codes }: when the names were read and the promise of them
let kept = null;

// The names of everything a plan can name. Read once and kept for MAX_AGE;
// turns that come in while a read is under way share it. A read in which a
// query failed serves the turns that wait for it and is then dropped, so the
// next turn reads again.
export function loadCodes(catalogue) {
  if (kept && Date.now() - kept.at <= MAX_AGE) return kept.codes;
  const entry = { at: Date.now(), codes: null };
  entry.codes = readCodes(catalogue, () => { if (kept === entry) kept = null; });
  kept = entry;
  return entry.codes;
}

// Drops what was read, so the next call reads again. For the tests.
export function forgetCodes() {
  kept = null;
}

// One query per class: per entity with a name its instances and their
// names, per code field (sh:class) the skos:prefLabels of its class. An
// entity that shares its class with another is left out: its instances
// cannot be told apart by class.
async function readCodes(catalogue, onFailure) {
  const predicates = new Map();
  for (const entity of catalogue.flatMap(profile => profile.entities)) {
    const name = findNameField(entity);
    if (name && !entity.shared && !predicates.has(entity.targetClass)) predicates.set(entity.targetClass, name.predicate);
    for (const field of entity.fields) {
      if (field.codeClass && !predicates.has(field.codeClass)) predicates.set(field.codeClass, SKOS_PREF_LABEL);
    }
  }
  const lists = new Map();
  for (const [classUri, predicate] of predicates) {
    lists.set(classUri, await readNames(classUri, predicate, onFailure));
  }
  return createCodes(lists);
}

// Up to NAMES_MAX names of a class as { values, more }: one row extra tells
// whether the class holds more. Nothing when the read fails: the names of
// that class are then matched as text.
async function readNames(classUri, predicate, onFailure) {
  try {
    const result = await queryPublic(`SELECT ?uri ?label WHERE {
    ?uri a ${sparqlEscapeUri(classUri)} ;
         ${sparqlEscapeUri(predicate)} ?label .
  } LIMIT ${NAMES_MAX + 1}`);
    const rows = result.results.bindings;
    return {
      values: rows.slice(0, NAMES_MAX).map(b => ({ uri: b.uri.value, label: b.label.value })),
      more: rows.length > NAMES_MAX,
    };
  } catch (e) {
    console.error(`[plan] could not read the names of <${classUri}>:`, e.message);
    onFailure();
    return { values: [], more: false };
  }
}
