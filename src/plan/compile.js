// A report plan to a spec. The model fills a plan: one small JSON object
// that names a profile, an entity, filters and columns in the words of the
// catalogue (catalogue.js). This file turns the plan into the Turtle spec the
// runner reads: field names become predicates, the names of codes become
// URIs. What is wrong in a plan comes back as sentences the model can act
// on, all of them at once. The spec then passes the validator like any
// other. No model and no database here; what the service read of the code
// lists comes in as `codes` (codes.js).
//
// A plan:
//   { "profile": "Mandaten", "entity": "Mandataris", "title": "Schepenen",
//     "filters": [ { "path": ["bekleedt mandaat", "bestuursfunctie"], "is": "Schepen" } ],
//     "columns": [ { "label": "achternaam", "path": ["persoon", "achternaam"] } ] }
//
// A filter has a path and one test: is, is_one_of, contains, from/to, exists
// or none. A column has a label and a path, and may have collect (join, min,
// max), separator and only_where (a filter on the values of its cell).
import { parseSpec } from '../runner/spec.js';
import { checkSpec } from '../runner/check.js';
import { NUMERIC_DATATYPES } from '../runner/assemble.js';
import { buildCatalogue, findNameField, isCodeList } from './catalogue.js';
import { NO_CODES } from './codes.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_DATE = XSD + 'date';
const XSD_DATETIME = XSD + 'dateTime';
const XSD_BOOLEAN = XSD + 'boolean';
const SPEC_BASE = 'http://data.lblod.info/id/report-specs/';
const TESTS = ['is', 'is_one_of', 'contains', 'from', 'to', 'exists', 'none'];
// names of a code list repeated in an error, at most
const CODES_IN_ERROR_MAX = 60;
const NEAR_CODES_MAX = 8;

// Returns { errors, notes, turtle }. errors are English sentences for the
// model, every one found; turtle is only there without errors. notes are
// Dutch sentences for the user: what the proposal cannot show by itself.
export function compilePlan(plan, profiles, codes = NO_CODES) {
  const errors = [];
  const notes = new Set();
  if (!isObject(plan)) return { errors: ['the plan is not a JSON object.'], notes: [] };

  const home = findHome(plan, buildCatalogue(profiles));
  if (home.error) return { errors: [home.error], notes: [] };
  const ctx = {
    profile: home.profile,
    row: home.entity,
    entities: new Map(home.profile.entities.map(e => [e.id, e])),
    codes,
    errors,
    notes,
  };

  const filters = mergeFilters(compileFilters(plan.filters, ctx));
  const columns = compileColumns(plan.columns, ctx);
  if (errors.length) return { errors, notes: [...notes] };

  const turtle = writeSpec(plan, ctx, filters, columns);
  // The service's own parser and validator have the last word.
  try {
    const refused = checkSpec(parseSpec(turtle), profiles);
    if (refused) return { errors: [`the validator refused the plan: ${refused}`], notes: [...notes] };
  } catch (e) {
    return { errors: [`the plan gave a spec that does not parse: ${e.message}`], notes: [...notes] };
  }
  return { errors, notes: [...notes], turtle };
}

// Adds an error and returns null, so a step can end with "return fail(...)".
function fail(ctx, message) {
  ctx.errors.push(message);
  return null;
}

// ---- profile and entity -------------------------------------------------

// The profile and the row entity of a plan. An entity named under the wrong
// profile, or under none, is put right when one profile alone has it.
function findHome(plan, catalogue) {
  let profile = catalogue.find(p => sameName(p.title, plan.profile) || p.uri === plan.profile) || null;
  let entity = profile && findEntity(profile, plan.entity);
  if (!entity) {
    const homes = catalogue.filter(p => findEntity(p, plan.entity));
    if (homes.length === 1) {
      profile = homes[0];
      entity = findEntity(profile, plan.entity);
    }
  }
  if (!profile) return { error: `"profile": no profile "${plan.profile ?? ''}". Profiles: ${catalogue.map(p => p.title).join(', ')}.` };
  if (!entity) {
    const ids = profile.entities.map(e => e.id);
    return { error: `"entity": no entity "${plan.entity ?? ''}" in profile "${profile.title}". Entities: ${ids.join(', ')}.${suggest(plan.entity, ids)}` };
  }
  return { profile, entity };
}

// An entity by its id, or by its label when one entity alone carries it.
function findEntity(profile, name) {
  const byLabel = profile.entities.filter(e => sameName(e.label, name));
  return profile.entities.find(e => sameName(e.id, name)) || (byLabel.length === 1 ? byLabel[0] : null);
}

// ---- paths --------------------------------------------------------------

// Walks the field names of a path from the row entity. Returns { hops,
// entities, fields }: the hops for the spec, the entities the path stands on
// after its last step (none after a value) and the fields that step can be.
//
// Two slips are put right, because the profile leaves no doubt about them:
// a step that names the entity the path already stands on is skipped, and
// one link the model left out is filled in when it is the only way to the
// step (findDetours).
function walkPath(path, where, ctx) {
  if (!Array.isArray(path)) return fail(ctx, `${where}: "path" must be a list of field names.`);
  let entities = [ctx.row];
  let fields = [];
  const hops = [];
  for (const [i, raw] of path.entries()) {
    const step = cleanStep(raw);
    let found = findFields(entities, step);
    if (!found.length && entities.length) {
      if (entities.some(e => isCalled(e, step))) continue;
      const detours = findDetours(entities, step, hops.at(-1), ctx);
      if (detours.length > 1) {
        const ways = detours.map(d => [d.link.name, ...(d.namesEntity ? [] : [step])].join(' › '));
        return fail(ctx, `${where}: step ${i + 1} "${step}" is not a field of ${listIds(entities)}, and it can be reached in ${detours.length} ways: ${ways.join('  |  ')}. Write the path out with the one you mean.`);
      }
      if (detours.length === 1) {
        const { link, namesEntity } = detours[0];
        hops.push(toHop(link));
        fields = [link];
        entities = findTargets([link], ctx);
        if (namesEntity) continue;
        found = findFields(entities, step);
      }
    }
    if (!found.length) {
      if (!entities.length) return fail(ctx, `${where}: step ${i} is a value, the path cannot go on after it with "${step}".`);
      const have = listFieldNames(entities);
      return fail(ctx, `${where}: step ${i + 1} "${step}" is not a field of ${listIds(entities)}. Fields there: ${have.join(', ')}.${suggest(step, have)}`);
    }
    if (new Set(found.map(f => `${f.predicate} ${f.inverse}`)).size > 1) {
      return fail(ctx, `${where}: step ${i + 1} "${step}" means different things on ${listIds(entities)}.`);
    }
    hops.push(toHop(found[0]));
    fields = found;
    entities = findTargets(found, ctx);
  }
  return { hops, entities, fields };
}

// A link the model left out: the links of where the path stands that lead to
// an entity called `step`, or to an entity with a field called `step`. One
// link, never more: a longer way round can be the only route and still make
// no sense. Never straight back over the link the path just took.
function findDetours(entities, step, lastHop, ctx) {
  const detours = new Map();
  for (const entity of entities) {
    for (const link of entity.fields.filter(f => f.targets.length)) {
      if (lastHop && link.predicate === lastHop.predicate && link.inverse !== lastHop.inverse) continue;
      for (const target of findTargets([link], ctx)) {
        if (target === entity) continue;
        const namesEntity = isCalled(target, step);
        if (!namesEntity && !findFields([target], step).length) continue;
        detours.set(`${link.predicate} ${link.inverse} ${namesEntity}`, { link, namesEntity });
      }
    }
  }
  return [...detours.values()];
}

// A path that ends on a link, taken one step further: to the name of what
// the link reaches. A filter on a name and a column both need a value.
function walkToName(walked, where, ctx) {
  const nameless = walked.entities.filter(e => !findNameField(e));
  if (nameless.length) {
    return fail(ctx, `${where}: the path ends on ${listIds(nameless)}, which has no name field. Add one of its fields to the path: ${listFieldNames(nameless).join(', ')}.`);
  }
  const names = walked.entities.map(findNameField);
  if (new Set(names.map(f => f.predicate)).size > 1) {
    return fail(ctx, `${where}: the path ends on several kinds of things with different name fields. Add a field to the path.`);
  }
  return { hops: [...walked.hops, toHop(names[0])], entities: [], fields: names };
}

// One more step from where a path stands.
function walkOn(walked, name, where, ctx) {
  const found = findFields(walked.entities, cleanStep(name));
  if (!found.length) {
    const have = listFieldNames(walked.entities);
    return fail(ctx, `${where}: "${name}" is not a field of ${listIds(walked.entities)}. Fields there: ${have.join(', ')}.${suggest(name, have)}`);
  }
  return { hops: [...walked.hops, toHop(found[0])], entities: findTargets(found, ctx), fields: found };
}

const endsOnLink = (walked) => walked.fields.some(f => f.targets.length);
const endsOnCode = (walked) => walked.fields.some(f => f.codeClass);
const readDatatype = (walked) => walked.fields.find(f => f.datatype)?.datatype || null;
const isRangeType = (datatype) => datatype === XSD_DATE || datatype === XSD_DATETIME || NUMERIC_DATATYPES.has(datatype);

// ---- tests --------------------------------------------------------------

// The test of a filter on where its path ends. Returns { hops, lines,
// wheres }: the path (a test on a name goes one step further than the plan
// wrote), the constraints as Turtle and, for an entity described by several
// of its fields, the rep:where conditions that tie those fields to one node.
function compileTest(walked, cond, where, ctx) {
  const given = TESTS.filter(k => cond[k] !== undefined && cond[k] !== null);
  const bounds = given.filter(k => k === 'from' || k === 'to');
  if (!given.length) return fail(ctx, `${where}: no condition. Add one of: is, is_one_of, contains, from/to, exists, none.`);
  if (given.length > 1 && bounds.length !== given.length) {
    return fail(ctx, `${where}: several conditions (${given.join(', ')}). Give exactly one (from and to may go together).`);
  }
  switch (given[0]) {
    case 'exists':
      return { hops: walked.hops, lines: [cond.exists === false || sameName(cond.exists, 'false') ? 'sh:maxCount 0' : 'sh:minCount 1'] };
    case 'none':
      return compileNone(walked, cond.none, where, ctx);
    case 'from':
    case 'to':
      return compileRange(walked, cond, bounds, where, ctx);
    case 'contains':
      return compileContains(walked, cond.contains, where, ctx);
    case 'is':
      if (isObject(cond.is)) return compileIsEntity(walked, cond.is, where, ctx);
      return compileIs(walked, Array.isArray(cond.is) ? cond.is : [cond.is], 'is', where, ctx);
    default:
      return compileIs(walked, cond.is_one_of, 'is_one_of', where, ctx);
  }
}

// "none": nothing on the path passes the inner test.
function compileNone(walked, inner, where, ctx) {
  if (!isObject(inner)) return fail(ctx, `${where}: "none" needs a condition object, for example {"is": "..."}.`);
  if (inner.none !== undefined) return fail(ctx, `${where}: "none" inside "none" is not possible. Write the condition itself.`);
  const test = compileTest(walked, inner, `${where} none`, ctx);
  return test && { ...test, lines: [...new Set([...test.lines, 'sh:maxCount 0'])] };
}

// "from" and "to": a range on a date or a number, both ends included. On a
// dateTime field a day runs from its first second to its last.
function compileRange(walked, cond, bounds, where, ctx) {
  const datatype = readDatatype(walked);
  if (endsOnLink(walked) || !isRangeType(datatype)) return fail(ctx, `${where}: from/to needs a path that ends on a date or number field.`);
  const isNumber = NUMERIC_DATATYPES.has(datatype);
  const lines = [];
  for (const bound of bounds) {
    const text = String(cond[bound]).trim();
    const value = isNumber ? writeNumber(text) : writeDay(text, datatype, bound);
    if (!value) return fail(ctx, `${where}: "${bound}" must be ${isNumber ? 'a whole number' : 'a date as YYYY-MM-DD'}.`);
    lines.push(`${bound === 'from' ? 'sh:minInclusive' : 'sh:maxInclusive'} ${value}`);
  }
  return { hops: walked.hops, lines };
}

// A whole number as a Turtle literal, or null. Only whole numbers: the
// runner writes an xsd:integer into its query as a number, any other number
// as text.
function writeNumber(text) {
  return /^-?\d+$/.test(text) ? `"${text}"^^<${XSD}integer>` : null;
}

// A day as a Turtle literal of the field's datatype, or null when the text
// does not start with a real date. The time of a dateTime is in UTC, so the
// spec means the same wherever the service runs.
function writeDay(text, datatype, bound) {
  const day = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const date = new Date(`${day}T00:00:00Z`);
  if (!day || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  if (datatype === XSD_DATE) return `"${day}"^^<${XSD_DATE}>`;
  return `"${day}T${bound === 'from' ? '00:00:00' : '23:59:59'}Z"^^<${XSD_DATETIME}>`;
}

// "contains": the text occurs in the value, case aside. On a link it is the
// name of what the link reaches.
function compileContains(walked, text, where, ctx) {
  if ((typeof text !== 'string' && typeof text !== 'number') || !String(text).trim()) {
    return fail(ctx, `${where}: "contains" needs a text.`);
  }
  if (endsOnCode(walked)) return fail(ctx, `${where}: the path ends on a code, which has no text to search. Use "is" with the name of the code.`);
  const target = endsOnLink(walked) ? walkToName(walked, where, ctx) : walked;
  return target && { hops: target.hops, lines: [`sh:pattern ${quote(escapeRegex(String(text)))}`, 'sh:flags "i"'] };
}

// "is" with an object: one entity that has all these field values, for
// example { "soort bestuur": "Gemeente", "naam": "Aalst" } on a path that
// ends on a bestuurseenheid. The first field is the filter, the others hang
// on it as rep:where, so all of them test the same node.
function compileIsEntity(walked, values, where, ctx) {
  if (!endsOnLink(walked)) {
    return fail(ctx, `${where}: "is" with an object needs a path that ends on an entity (a link field). This path ends on a value: write "is": "<value>".`);
  }
  const entries = Object.entries(values);
  if (!entries.length) return fail(ctx, `${where}: "is": {} names no field.`);
  // { "naam": "Gemeente" } says what "is": "Gemeente" says, and that form
  // finds the code when it is one
  const names = walked.entities.map(findNameField);
  if (entries.length === 1 && !isObject(entries[0][1]) && names.every(f => f && sameName(f.name, entries[0][0]))) {
    return compileTest(walked, { is: entries[0][1] }, where, ctx);
  }
  const parts = [];
  for (const [field, value] of entries) {
    const further = walkOn(walked, field, where, ctx);
    const part = further && compileTest(further, { is: value }, `${where} is.${field}`, ctx);
    if (!part) return null;
    parts.push(part);
  }
  const [first, ...rest] = parts;
  if (rest.some(part => part.wheres?.length)) {
    return fail(ctx, `${where}: an object inside the "is" object may name one field only.`);
  }
  return { hops: first.hops, lines: first.lines, wheres: [...(first.wheres || []), ...rest.map(writeWhere)] };
}

// "is" and "is_one_of" with plain values, by what the path ends on.
function compileIs(walked, values, kind, where, ctx) {
  if (!Array.isArray(values) || !values.length || values.some(v => v === null || typeof v === 'object')) {
    return fail(ctx, `${where}: "${kind}" needs ${kind === 'is' ? 'a value' : 'a list of values'}.`);
  }
  if (endsOnCode(walked)) return compileCodes(walked, values, where, ctx);
  if (endsOnLink(walked)) return compileNames(walked, values, where, ctx);
  const datatype = readDatatype(walked);
  if (datatype === XSD_BOOLEAN) {
    const word = String(values[0]).trim().toLowerCase();
    if (values.length > 1 || !['true', 'false', 'ja', 'nee'].includes(word)) return fail(ctx, `${where}: a ja/nee field takes true or false.`);
    return { hops: walked.hops, lines: [`sh:hasValue "${word === 'true' || word === 'ja'}"^^<${XSD_BOOLEAN}>`] };
  }
  if (isRangeType(datatype)) return fail(ctx, `${where}: use "from" and "to" on a date or number field.`);
  return { hops: walked.hops, lines: writeExactNames(values) };
}

// Names on a link. A name the service reads becomes the URI of the thing,
// and the filter tests the link. A name it does not read is a mistake when
// the link leads to a code list. Of anything else the service reads a part
// at most, so there a name it does not read is no mistake: the filter then
// tests the name itself, the whole name, where the report runs.
function compileNames(walked, values, where, ctx) {
  const classes = [...new Set(walked.entities.filter(e => !e.shared).map(e => e.targetClass))];
  const uris = [];
  const unread = [];
  for (const value of values) {
    const found = [...new Set(classes.flatMap(c => ctx.codes.find(c, value)))];
    if (found.length) uris.push(...found);
    else unread.push(value);
  }
  if (!unread.length) return { hops: walked.hops, lines: [writeUris([...new Set(uris)])] };

  if (walked.entities.every(e => isCodeList(e, ctx.codes))) {
    return fail(ctx, `${where}: ${unread.map(v => describeMiss(v, classes, ctx)).join(', ')} is not a code of ${listIds(walked.entities)}. Use the exact name of a code, or "contains" for a text match.`);
  }
  const named = walkToName(walked, where, ctx);
  if (!named) return null;
  const kind = walked.entities.map(e => e.label || e.id).join(' of ');
  for (const value of unread) {
    ctx.notes.add(`De assistent kan niet nagaan of er een ${kind} "${value}" bestaat: het rapport zoekt op exact die naam.`);
  }
  return { hops: named.hops, lines: writeExactNames(values) };
}

// Names on a code field (sh:class): the codes have no shape of their own,
// so every name must be one the service reads.
function compileCodes(walked, values, where, ctx) {
  const classes = [...new Set(walked.fields.map(f => f.codeClass).filter(Boolean))];
  const uris = [];
  const unread = [];
  for (const value of values) {
    const found = [...new Set(classes.flatMap(c => ctx.codes.find(c, value)))];
    if (found.length) uris.push(...found);
    else unread.push(value);
  }
  if (!unread.length) return { hops: walked.hops, lines: [writeUris([...new Set(uris)])] };
  if (!classes.some(c => ctx.codes.isComplete(c))) {
    return fail(ctx, `${where}: the codes of "${walked.fields[0].name}" cannot be read, so none of them can be named. Use "exists", or leave the filter out.`);
  }
  return fail(ctx, `${where}: ${unread.map(v => describeMiss(v, classes, ctx)).join(', ')} is not a code of "${walked.fields[0].name}". Use the exact name of a code.`);
}

// A name that is no code, with the codes that come close: the ones that
// contain it, or the whole list when that is short.
function describeMiss(value, classes, ctx) {
  const all = [...new Set(classes.flatMap(c => ctx.codes.labels(c)))];
  const near = all.filter(label => label.toLowerCase().includes(String(value).trim().toLowerCase())).slice(0, NEAR_CODES_MAX);
  if (near.length) return `"${value}" (codes that contain it: ${near.join('; ')})`;
  if (all.length && all.length <= CODES_IN_ERROR_MAX) return `"${value}" (the codes are: ${all.join('; ')})`;
  return `"${value}"`;
}

// ---- filters and columns ------------------------------------------------

// A filter, or the only_where of a column: its path and its test. tested is
// the path as the plan wrote it, before a test on a name went further.
function compileCondition(cond, where, ctx) {
  if (!isObject(cond)) return fail(ctx, `${where}: must be an object.`);
  const walked = walkPath(cond.path ?? [], where, ctx);
  if (!walked) return null;
  if (!walked.hops.length) return fail(ctx, `${where}: "path" is empty. A filter needs at least one field.`);
  const test = compileTest(walked, cond, where, ctx);
  return test && { hops: test.hops, lines: test.lines, wheres: test.wheres || [], tested: walked.hops };
}

// The filters of a plan. A filter that says what an earlier one says counts
// once: a model at times writes one twice, the second time by another route
// to the same path.
function compileFilters(filters, ctx) {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters)) {
    fail(ctx, '"filters" must be a list.');
    return [];
  }
  const compiled = new Map();
  for (const [i, filter] of filters.entries()) {
    const condition = compileCondition(filter, `filters[${i}]`, ctx);
    if (condition && !compiled.has(writeCondition(condition))) compiled.set(writeCondition(condition), condition);
  }
  return [...compiled.values()];
}

// Two filters on different fields of the same linked thing mean one thing
// that has both: "soort bestuur is Gemeente" and "naam is Aalst", each at
// the end of the same path to a bestuurseenheid. As two filters, a different
// bestuurseenheid could meet each. So the second becomes a rep:where on the
// first, which tests the same node.
function mergeFilters(filters) {
  const merged = [];
  for (const filter of filters) {
    const anchor = JSON.stringify(filter.tested.slice(0, -1));
    const field = JSON.stringify(filter.tested.at(-1));
    const mergeable = filter.tested.length > 1 && !filter.wheres.length && !filter.lines.includes('sh:maxCount 0');
    const host = mergeable && merged.find(m => m.mergeable && m.anchor === anchor && !m.fields.has(field));
    if (host) {
      host.wheres.push(writeWhere(filter));
      host.fields.add(field);
    } else {
      merged.push({ ...filter, wheres: [...filter.wheres], anchor, mergeable, fields: new Set([field]) });
    }
  }
  return merged;
}

function compileColumns(columns, ctx) {
  if (!Array.isArray(columns) || !columns.length) {
    fail(ctx, '"columns" needs at least one column.');
    return [];
  }
  const labels = new Set();
  const compiled = [];
  for (const [i, column] of columns.entries()) {
    const where = `columns[${i}]`;
    if (!isObject(column)) {
      fail(ctx, `${where}: must be an object.`);
    } else if (typeof column.label !== 'string' || !column.label.trim()) {
      fail(ctx, `${where}: needs a "label".`);
    } else if (labels.has(column.label)) {
      fail(ctx, `${where}: the label "${column.label}" is used twice. Labels must differ.`);
    } else {
      labels.add(column.label);
      const turtle = compileColumn(column, where, ctx);
      if (turtle) compiled.push(turtle);
    }
  }
  return compiled;
}

// One column as Turtle. A column shows a value, so a path that ends on a
// link goes on to the name of what it reaches; an empty path is the row
// itself.
function compileColumn(column, where, ctx) {
  if (column.path === undefined || column.path === null) return fail(ctx, `${where}: needs a "path". [] is the URI of the row itself.`);
  let walked = walkPath(column.path, where, ctx);
  if (walked && endsOnLink(walked)) walked = walkToName(walked, where, ctx);
  if (!walked) return null;
  const parts = [`sh:path ${walked.hops.length ? writePath(walked.hops) : 'rep:self'}`, `rdfs:label ${quote(column.label)}`];

  if (column.collect) {
    const mode = readCollect(column.collect);
    if (!mode) return fail(ctx, `${where}: "collect" is "join", "min" or "max".`);
    if (mode !== 'sh:groupConcat' && !isRangeType(readDatatype(walked))) {
      return fail(ctx, `${where}: "collect": "${column.collect}" needs a path that ends on a date or number field.`);
    }
    // the row itself is one value: nothing to collect
    if (walked.hops.length) {
      parts.push(`rep:collect ${mode}`);
      if (mode === 'sh:groupConcat' && typeof column.separator === 'string' && column.separator) {
        parts.push(`sh:separator ${quote(column.separator)}`);
      }
    }
  }

  if (column.only_where) {
    const condition = compileCondition(column.only_where, `${where}.only_where`, ctx);
    if (!condition) return null;
    if (condition.wheres.length) return fail(ctx, `${where}.only_where: "is" with several fields is not possible here. Test one field.`);
    const first = walked.hops[0];
    if (!first || first.predicate !== condition.hops[0].predicate || first.inverse !== condition.hops[0].inverse) {
      return fail(ctx, `${where}.only_where: its path must begin with the same step as the path of the column.`);
    }
    parts.push(writeWhere(condition));
  }
  return `[ ${parts.join(' ; ')} ]`;
}

// The collect mode of a column. "join" also goes by a few other words a
// model writes for it.
function readCollect(word) {
  const w = String(word).trim().toLowerCase();
  if (w === 'min') return 'sh:min';
  if (w === 'max') return 'sh:max';
  return /join|concat|list|all|group|samen|cel/.test(w) ? 'sh:groupConcat' : null;
}

// ---- Turtle -------------------------------------------------------------

// The spec. Full URIs throughout, so no prefix can be missing.
function writeSpec(plan, ctx, filters, columns) {
  const title = typeof plan.title === 'string' && plan.title.trim() ? plan.title.trim() : (ctx.row.label || ctx.row.id);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'rapport';
  return `@prefix rep: <http://mu.semte.ch/vocabularies/reporting/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct: <http://purl.org/dc/terms/> .

<${SPEC_BASE}${slug}> a rep:ReportSpec , sh:NodeShape ;
  dct:title ${quote(title)} ;
  rep:profile <${ctx.profile.uri}> ;
  sh:targetClass <${ctx.row.targetClass}> ;
  rep:entity <${ctx.row.uri}> ;
${filters.map(f => `  sh:property [ ${writeCondition(f)} ] ;\n`).join('')}  rep:columns (
${columns.map(c => `    ${c}`).join('\n')}
  ) .
`;
}

const toHop = (field) => ({ predicate: field.predicate, inverse: field.inverse });
const writePath = (hops) => `( ${hops.map(h => (h.inverse ? `[ sh:inversePath <${h.predicate}> ]` : `<${h.predicate}>`)).join(' ')} )`;
const writeCondition = (c) => `sh:path ${writePath(c.hops)} ; ${[...c.lines, ...(c.wheres || [])].join(' ; ')}`;
const writeWhere = (c) => `rep:where [ ${writeCondition({ ...c, wheres: [] })} ]`;
const writeUris = (uris) => (uris.length === 1 ? `sh:hasValue <${uris[0]}>` : `sh:in ( ${uris.map(u => `<${u}>`).join(' ')} )`);

// A whole value, case aside: one name, or one of several.
function writeExactNames(values) {
  return [`sh:pattern ${quote(`^(${values.map(v => escapeRegex(String(v).trim())).join('|')})$`)}`, 'sh:flags "i"'];
}

// A Turtle string. The escapes of a JSON string are valid in Turtle.
function quote(text) {
  return JSON.stringify(String(text));
}

// Text inside a regex: its syntax characters lose their meaning.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- names --------------------------------------------------------------

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const isCalled = (entity, name) => sameName(entity.id, name) || sameName(entity.label, name);
const findFields = (entities, name) => entities.flatMap(e => e.fields.filter(f => sameName(f.name, name)));
const findTargets = (fields, ctx) => [...new Set(fields.flatMap(f => f.targets))].map(id => ctx.entities.get(id));
const listIds = (entities) => entities.map(e => e.id).join(' | ');
const listFieldNames = (entities) => [...new Set(entities.flatMap(e => e.fields.map(f => f.name)))];

// A step as the model wrote it, without the word in brackets the catalogue
// shows after a field: "start (datum)" is the field "start".
function cleanStep(step) {
  return String(step ?? '').replace(/\s*[([](datum|getal|ja\/nee|tekst|code)[)\]]\s*$/i, '').trim();
}

// " Did you mean ...?" when one of the options is the word in other case,
// or holds it, or is held by it.
function suggest(word, options) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return '';
  const hit = options.find(o => o.toLowerCase() === w)
    || options.find(o => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()));
  return hit ? ` Did you mean "${hit}"?` : '';
}
