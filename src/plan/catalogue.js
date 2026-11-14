// The profiles as the model reads them when it fills a report plan: per
// profile its entities, per entity its values and its links, all by name.
// The model never sees a URI here. It writes names, and the compiler
// (compile.js) turns them into the predicates and URIs of a spec.
import { NUMERIC_DATATYPES } from '../runner/assemble.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
// A code list up to this size shows in full. A longer one does not: the
// compiler still knows its names and reports a wrong one.
const CODES_SHOWN_MAX = 60;
const FIELD_HINT_MAX = 90;
const ENTITY_HINT_MAX = 200;

// Every profile as { title, uri, entities }. An entity is { id, uri, label,
// description, targetClass, shared, fields }: its id is the last part of its
// URI, the name the model uses; shared says its class holds other entities
// too. A field is { name, predicate, inverse, datatype, codeClass, targets,
// description }: a value has a datatype, a code field a codeClass (sh:class),
// a link the ids of the entities it leads to. Throws when two entities of a
// profile, or two fields of an entity, go by one name: a plan could not tell
// them apart.
export function buildCatalogue(profiles) {
  return [...profiles.values()].map(profile => {
    const ids = new Map(profile.shapes.map(shape => [shape.uri, readLocalName(shape.uri)]));
    const entities = profile.shapes.map(shape => ({
      id: ids.get(shape.uri),
      uri: shape.uri,
      label: shape.label,
      description: shape.description || null,
      targetClass: shape.targetClass,
      shared: shape.discriminators.length > 0,
      fields: shape.fields.map(field => buildField(field, ids)).filter(Boolean),
    }));
    checkNames(profile, entities);
    return { title: profile.title, uri: profile.uri, entities };
  });
}

// One field for the catalogue, or null when the model cannot use it: no
// name, no path, or neither a value, a code nor a link.
function buildField(field, ids) {
  if (!field.name || !field.path) return null;
  const targets = field.datatype ? [] : field.nodes.map(uri => ids.get(uri)).filter(Boolean);
  const codeClass = (!field.datatype && !targets.length && field.class) || null;
  if (!field.datatype && !codeClass && !targets.length) return null;
  return {
    name: field.name,
    predicate: field.path,
    inverse: field.inverse,
    datatype: field.datatype || null,
    codeClass,
    targets,
    description: field.description || null,
  };
}

// A plan names entities and fields. Two with one name in the same place
// make every plan that uses the name ambiguous, so the profile is refused.
function checkNames(profile, entities) {
  const twice = (names) => names.find((name, i) => names.indexOf(name) !== i);
  const entity = twice(entities.map(e => e.id.toLowerCase()));
  if (entity) {
    throw new Error(`profile "${profile.title}": two entities are called "${entity}" (the last part of their URI). Rename one.`);
  }
  for (const e of entities) {
    const field = twice(e.fields.map(f => f.name.toLowerCase()));
    if (field) throw new Error(`profile "${profile.title}": entity "${e.id}" has two fields called "${field}". Rename one.`);
  }
}

// The field that holds the name of an entity: its skos:prefLabel, else its
// rdfs:label, else the field called "naam". Null when it has none.
export function findNameField(entity) {
  const values = entity.fields.filter(f => f.datatype);
  return values.find(f => f.predicate === SKOS_PREF_LABEL)
    || values.find(f => f.predicate === RDFS_LABEL)
    || values.find(f => f.name === 'naam')
    || null;
}

// True when an entity is a code list the service knows in full: it has a
// name and no links, its class is its own, and its names were read (see
// codes.js). Only then is a name that is not in the list a mistake. Any
// other entity can have instances the service does not read: of the
// bestuurseenheden, the public graph may hold just one.
export function isCodeList(entity, codes) {
  return !!findNameField(entity)
    && !entity.shared
    && entity.fields.every(f => !f.targets.length)
    && codes.isComplete(entity.targetClass);
}

// The catalogue as text for the model. Per entity one line with its id, its
// label when that differs, its codes when it is a short code list, and its
// description; then its values and its links.
export function renderCatalogue(catalogue, codes) {
  const lines = [];
  for (const profile of catalogue) {
    lines.push(`PROFILE "${profile.title}"`);
    for (const entity of profile.entities) {
      let line = entity.id;
      if (entity.label && entity.label.toLowerCase() !== entity.id.toLowerCase()) line += ` (${entity.label})`;
      const names = isCodeList(entity, codes) ? codes.labels(entity.targetClass) : [];
      if (names.length && names.length <= CODES_SHOWN_MAX) line += ` — codes: ${names.join('; ')}`;
      if (entity.description) line += ` — ${cut(entity.description, ENTITY_HINT_MAX)}`;
      lines.push(line);
      const values = entity.fields.filter(f => !f.targets.length).map(f => renderValueField(f, codes));
      const links = entity.fields.filter(f => f.targets.length).map(f => `${f.name} > ${f.targets.join(' | ')}${renderHint(f)}`);
      if (values.length) lines.push(`  waarden: ${values.join(', ')}`);
      if (links.length) lines.push(`  links: ${links.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// A value field: its name and what it holds when that is not text. A code
// field shows its codes when the list is short.
function renderValueField(field, codes) {
  let kind = readTypeWord(field.datatype);
  if (field.codeClass) {
    const names = codes.isComplete(field.codeClass) ? codes.labels(field.codeClass) : [];
    kind = names.length && names.length <= CODES_SHOWN_MAX ? `code: ${names.join('; ')}` : 'code';
  }
  return `${field.name}${kind ? ` (${kind})` : ''}${renderHint(field)}`;
}

// What a value field holds, as the word the model reads after its name.
// Text gets no word.
function readTypeWord(datatype) {
  if (datatype === XSD + 'date' || datatype === XSD + 'dateTime') return 'datum';
  if (datatype === XSD + 'boolean') return 'ja/nee';
  return NUMERIC_DATATYPES.has(datatype) ? 'getal' : '';
}

// The sh:description of a field, in square brackets after its name.
function renderHint(field) {
  return field.description ? ` [${cut(field.description, FIELD_HINT_MAX)}]` : '';
}

// A text of at most max characters; a cut gets an ellipsis.
function cut(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

// The last part of a URI: ".../report-entities/Mandataris" gives
// "Mandataris".
function readLocalName(uri) {
  return uri.replace(/^.*[/#]/, '');
}
