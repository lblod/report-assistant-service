// A spec in Dutch words, written by code from the spec and its profile. The
// text says what the spec does, in the names of the profile: no LLM writes
// it, so it cannot differ from what runs. Profile only, no database.
import { findStartShape, getFields } from './profile.js';
import { countSharedSteps } from './spec.js';

const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';
const MAX_LENGTH = 300;
// the characters with a meaning in a regex; the service escapes exactly these
const REGEX_SYNTAX = '.*+?^${}()|[]\\';

// A report's dct:description: one line of at most MAX_LENGTH characters that
// says what a row is, which filters apply and which columns show. labelOf
// gives the name of a URI a filter tests for, or nothing.
export function describeSpec(spec, profile, labelOf = () => null) {
  const start = findStartShape(profile, spec);
  const filters = spec.filters.map(f => renderFilter(f, profile, start.uri, labelOf));
  return shorten([
    `Eén rij per ${start.label || shortenUri(start.uri)}.`,
    filters.length ? `Filters: ${filters.join('; ')}.` : 'Geen filters.',
    `Kolommen: ${spec.columns.map(c => c.label).join(', ')}.`,
  ].join(' '));
}

// The URIs a spec tests for (sh:hasValue, sh:in), so the caller can look up
// their names for the text.
export function listValueUris(spec) {
  const conditions = [...spec.filters, ...spec.filters.flatMap(f => f.where), ...spec.columns.flatMap(c => c.where)];
  const terms = conditions.flatMap(c => [c.constraints.hasValue, ...(c.constraints.in || [])]);
  return [...new Set(terms.filter(t => t?.type === 'uri').map(t => t.value))];
}

// One filter: its path in field names, its test, and its rep:where
// conditions in brackets.
function renderFilter(filter, profile, startUri, labelOf) {
  const path = namePath(profile, startUri, filter.path).join(' › ');
  const where = filter.where.map(w => renderWhere(w, filter.path, profile, startUri, labelOf));
  return `${renderCondition(path, filter.constraints, labelOf)}${where.length ? ` (${where.join('; ')})` : ''}`;
}

// A rep:where: which node it shares with its filter, and what it tests from
// there. "zelfde" keeps the sentence right for de- and het-words alike.
function renderWhere(where, hostPath, profile, startUri, labelOf) {
  const shared = countSharedSteps(hostPath, where.path);
  const names = namePath(profile, startUri, where.path);
  // a condition on the shared step itself reads by the name of that step
  if (shared === names.length) return renderCondition(names.at(-1), where.constraints, labelOf);
  const node = nameNode(profile, startUri, where.path.slice(0, shared));
  return `zelfde ${node}: ${renderCondition(names.slice(shared).join(' › '), where.constraints, labelOf)}`;
}

// "<what> <test>". sh:maxCount 0 turns it around: no value passes the test,
// or with no test, there is no value at all.
function renderCondition(what, constraints, labelOf) {
  const tests = renderTests(constraints, labelOf);
  if (constraints.maxCount === 0) return tests.length ? `geen enkele ${what} ${tests.join(' en ')}` : `${what} ontbreekt`;
  return `${what} ${tests.length ? tests.join(' en ') : 'is ingevuld'}`;
}

// The tests of a condition as phrases, without the counts that only say
// "there is a value" or "there is none".
function renderTests(c, labelOf) {
  const value = (term) => renderValue(term, labelOf);
  const tests = [];
  if (c.hasValue) tests.push(`is ${value(c.hasValue)}`);
  if (c.in) tests.push(`is een van ${c.in.map(value).join(', ')}`);
  if (c.pattern) tests.push(renderPattern(c.pattern, c.flags));
  if (c.anyOf) tests.push(`bevat een van de woorden ${c.anyOf.map(t => `"${t.value}"`).join(', ')}`);
  const range = [
    c.minInclusive && `vanaf ${renderBound(c.minInclusive, 'T00:00:00')}`,
    c.minExclusive && `na ${renderBound(c.minExclusive)}`,
    c.maxInclusive && `tot en met ${renderBound(c.maxInclusive, 'T23:59:59')}`,
    c.maxExclusive && `voor ${renderBound(c.maxExclusive)}`,
  ].filter(Boolean);
  if (range.length) tests.push(range.join(' '));
  if (c.minCount === 2) tests.push('heeft minstens twee verschillende waarden');
  return tests;
}

// A value a filter tests for: the name of a URI when it is known, a boolean
// as ja or nee, any other value in quotes.
function renderValue(term, labelOf) {
  if (term.type === 'uri') return labelOf(term.value) || `<${term.value}>`;
  if (term.datatype === XSD_BOOLEAN) return term.value === 'true' ? 'ja' : 'nee';
  return `"${term.value}"`;
}

// The start or the end of a range. A dateTime at the edge of its day (the
// start of the first day, the end of the last) shows as the day alone.
function renderBound(term, dayEdge = null) {
  if (term.datatype === XSD_DATETIME && dayEdge && term.value.slice(10).startsWith(dayEdge)) return term.value.slice(0, 10);
  return term.value;
}

// sh:pattern. The two patterns the service writes itself read as words: a
// whole value, "^(Aalst)$", and a piece of text, "Aalst". Any other regex
// shows as it is.
function renderPattern(pattern, flags) {
  const strict = (flags || '').includes('i') ? '' : ' (hoofdlettergevoelig)';
  const whole = pattern.match(/^\^\(([\s\S]*)\)\$$/);
  const names = whole && readAlternatives(whole[1]);
  if (names) return `is ${names.length > 1 ? 'een van ' : ''}${names.map(n => `"${n}"`).join(', ')}${strict}`;
  const text = readPlainRegex(pattern);
  if (text !== null) return `bevat "${text}"${strict}`;
  return `voldoet aan het patroon "${pattern}"`;
}

// The text a regex matches letter for letter, or null when it holds regex
// syntax.
function readPlainRegex(source) {
  let text = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      // only an escaped syntax character is plain text: \d or \s is not
      if (i >= source.length || !REGEX_SYNTAX.includes(source[i])) return null;
    } else if (REGEX_SYNTAX.includes(source[i])) {
      return null;
    }
    text += source[i];
  }
  return text;
}

// The texts of "a|b|c" when each alternative is plain text, else null.
function readAlternatives(source) {
  const parts = [''];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\' && i + 1 < source.length) parts[parts.length - 1] += source[i] + source[++i];
    else if (source[i] === '|') parts.push('');
    else parts[parts.length - 1] += source[i];
  }
  const texts = parts.map(readPlainRegex);
  return texts.every(t => t !== null) ? texts : null;
}

// The field names of a path, step by step from the start entity. A step the
// profile does not know shows as the end of its predicate.
function namePath(profile, startUri, hops) {
  let shapeUris = [startUri];
  return hops.map(hop => {
    const fields = findFields(profile, shapeUris, hop);
    shapeUris = [...new Set(fields.flatMap(f => f.nodes))];
    return [...new Set(fields.map(f => f.name).filter(Boolean))].join('/') || shortenUri(hop.predicate);
  });
}

// The entity a path lands on, by its label. A step that leads to several
// entities names them all.
function nameNode(profile, startUri, hops) {
  let shapeUris = [startUri];
  for (const hop of hops) shapeUris = [...new Set(findFields(profile, shapeUris, hop).flatMap(f => f.nodes))];
  return shapeUris.map(uri => profile.shapes.find(s => s.uri === uri)?.label || shortenUri(uri)).join(' of ');
}

// The fields a hop takes from any of these entities.
function findFields(profile, shapeUris, hop) {
  return shapeUris.flatMap(uri => getFields(profile, uri)
    .filter(f => f.path === hop.predicate && f.inverse === hop.inverse));
}

// The last part of a URI.
function shortenUri(uri) {
  return uri.replace(/^.*[/#]/, '');
}

// One line of at most MAX_LENGTH characters; a cut gets an ellipsis.
function shorten(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= MAX_LENGTH ? clean : `${clean.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}
