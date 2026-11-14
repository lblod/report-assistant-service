// Stand-in for the "mu" module of mu-javascript-template, for the tests.
//
// query and update reach no database. They record the SPARQL and its options
// in database.calls and return what database.answer gives, so a test can
// read what the service sent and script what comes back. The sparqlEscape
// functions are the ones of the template (v1.9.1, helpers/mu/sparql.js), so
// the SPARQL text is what the service sends in a stack.
import { randomUUID } from 'node:crypto';

const EMPTY = (queryString) => (/^\s*ASK/i.test(queryString) ? { boolean: false } : { results: { bindings: [] } });

export const database = {
  // { kind: 'query' | 'update', query, options } of every call, in order
  calls: [],
  // (queryString, options, kind) => a SPARQL JSON result; undefined gives an
  // empty result
  answer: () => undefined,
  reset() {
    this.calls = [];
    this.answer = () => undefined;
  },
};

async function run(kind, queryString, options = {}) {
  database.calls.push({ kind, query: queryString, options });
  return (await database.answer(queryString, options, kind)) ?? EMPTY(queryString);
}

export const query = (queryString, options) => run('query', queryString, options);
export const update = (queryString, options) => run('update', queryString, options);
export const uuid = () => randomUUID();

export function sparqlEscapeString(value) {
  return '"""' + value.replace(/[\\"]/g, match => '\\' + match) + '"""';
}
export function sparqlEscapeUri(value) {
  return '<' + value.replace(/[\\"<>]/g, match => '\\' + match) + '>';
}
export function sparqlEscapeInt(value) {
  return '"' + Number.parseInt(value) + '"^^xsd:integer';
}
export function sparqlEscapeDate(value) {
  return '"' + new Date(value).toISOString().substring(0, 10) + '"^^xsd:date';
}
export function sparqlEscapeDateTime(value) {
  return '"' + new Date(value).toISOString() + '"^^xsd:dateTime';
}

// SPARQL JSON terms and results, for the answers a test scripts.
export const uri = (value) => ({ type: 'uri', value });
export const literal = (value, datatype) => (datatype ? { type: 'typed-literal', value, datatype } : { type: 'literal', value });
export const rows = (...bindings) => ({ results: { bindings } });
