// The chat's reads and writes: conversations, messages, their bijlagen and
// the reports. Everything runs as the caller, with no graph: the app's
// authorization decides where a write lands.
//
// A bijlage is a real file: a logical nfo:FileDataObject the file service
// serves at /files/<uuid>/download, over a physical share:// object with
// nie:dataSource back to the logical one.
import { readFileSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { query, update, uuid,
         sparqlEscapeUri, sparqlEscapeString, sparqlEscapeInt, sparqlEscapeDateTime } from 'mu';

// Messages of history a turn reads.
const HISTORY_LIMIT = 20;
// Specs of one conversation the model gets to know of, the newest ones.
const SPEC_LIMIT = 50;
const REPORT_CLASS = 'http://lblod.data.gift/vocabularies/reporting/Report';
const REPORT_SPEC_CLASS = 'http://lblod.data.gift/vocabularies/reporting/ReportSpec';
const SHARE_DIR = process.env.SHARE_DIR || '/share';
// A physical file's uri is this plus its path under SHARE_DIR.
const SHARE_PREFIX = 'share://';
const MESSAGE_BASE = 'http://data.lblod.info/id/chat-messages/';
const FILE_BASE = 'http://data.lblod.info/files/';
const REPORT_BASE = 'http://data.lblod.info/id/reports/';
const REPORT_SPEC_BASE = 'http://data.lblod.info/id/report-specs/';
// The agent that signs the assistant's messages, seeded by the portal's
// chat-assistant migration. It is also the source (prov:wasAttributedTo) of
// every spec and report the service writes, never a person.
export const CHAT_ASSISTANT_URI = process.env.CHAT_ASSISTANT_URI || 'http://data.lblod.info/id/chat-agents/report-assistant';

const SPEC_MEDIA_TYPE = 'text/turtle';
// The bijlage types. Match the add-chat-attachment-types-codelist migration
// in the portal. The type says what a file is: readSpecFile opens only a
// file typed SPEC_TYPE, so the LLM can never read a CSV or any other file.
const SPEC_TYPE = 'http://lblod.data.gift/concepts/6693014e-7b7d-448c-bb24-80c9758521f3';
export const RESULT_TYPE = 'http://lblod.data.gift/concepts/28d97698-e219-4a92-bdbd-7ab367a7524e';

const PREFIXES = `
  PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
  PREFIX sioc: <http://rdfs.org/sioc/ns#>
  PREFIX dct: <http://purl.org/dc/terms/>
  PREFIX foaf: <http://xmlns.com/foaf/0.1/>
  PREFIX as: <https://www.w3.org/ns/activitystreams#>
  PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>
  PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>
  PREFIX prov: <http://www.w3.org/ns/prov#>
`;

// The conversation with this uuid, or null when it does not exist or the
// caller may not read it. This read is the access check: the caller's
// session decides what is readable.
export async function readConversation(id) {
  const result = await query(`${PREFIXES}
    SELECT ?conversation ?title ?creator WHERE {
      ?conversation a sioc:Thread ;
        mu:uuid ${sparqlEscapeString(id)} .
      OPTIONAL { ?conversation dct:title ?title . }
      OPTIONAL { ?conversation foaf:maker ?creator . }
    } LIMIT 1`);
  const binding = result.results.bindings[0];
  if (!binding) return null;
  return { uri: binding.conversation.value, title: binding.title?.value, creator: binding.creator?.value };
}

// The last HISTORY_LIMIT messages, oldest first, as
// { role, content, attachments }, attachments being the logical file uris.
// Two queries: the limit counts messages, and a message with bijlagen comes
// back once per bijlage. The model needs the conversation so far; the
// assistant's messages are told apart by its agent URI (CHAT_ASSISTANT_URI).
export async function readHistory(conversationUri) {
  const result = await query(`${PREFIXES}
    SELECT ?message ?content ?maker ?created WHERE {
      ?message sioc:has_container ${sparqlEscapeUri(conversationUri)} ;
        sioc:content ?content ;
        foaf:maker ?maker ;
        dct:created ?created .
    } ORDER BY DESC(?created) LIMIT ${HISTORY_LIMIT}`);
  const byMessage = new Map();
  for (const b of result.results.bindings.reverse()) {
    byMessage.set(b.message.value, {
      role: b.maker.value === CHAT_ASSISTANT_URI ? 'assistant' : 'user',
      content: b.content.value,
      attachments: [],
    });
  }
  if (!byMessage.size) return [];

  const attached = await query(`${PREFIXES}
    SELECT ?message ?doc WHERE {
      VALUES ?message { ${[...byMessage.keys()].map(sparqlEscapeUri).join(' ')} }
      ?message as:attachment ?doc .
    }`);
  for (const b of attached.results.bindings) {
    byMessage.get(b.message.value)?.attachments.push(b.doc.value);
  }
  return [...byMessage.values()];
}

// One message with its bijlagen, in one update that also touches the
// conversation. A title is only given for the first question: it names the
// conversation. attachments are the logical uris of files that already exist.
// Returns the message uuid.
export async function writeMessage({ conversationUri, content, maker, attachments = [], title }) {
  const id = uuid();
  const message = sparqlEscapeUri(`${MESSAGE_BASE}${id}`);
  const conversation = sparqlEscapeUri(conversationUri);
  const now = sparqlEscapeDateTime(new Date());

  await update(`${PREFIXES}
    DELETE {
      ${conversation} sioc:last_activity_date ?old .
    }
    INSERT {
      ${message} a sioc:Post ;
        mu:uuid ${sparqlEscapeString(id)} ;
        sioc:has_container ${conversation} ;
        sioc:content ${sparqlEscapeString(content)} ;
        dct:created ${now} .
      ${maker ? `${message} foaf:maker ${sparqlEscapeUri(maker)} .` : ''}
      ${attachments.map(file => `${message} as:attachment ${sparqlEscapeUri(file)} .`).join('\n      ')}
      ${conversation} sioc:last_activity_date ${now} .
      ${title ? `${conversation} dct:title ${sparqlEscapeString(title)} .` : ''}
    }
    WHERE {
      OPTIONAL { ${conversation} sioc:last_activity_date ?old . }
    }`);

  return id;
}

// The ReportSpec of a spec bijlage, written in the turn that made the spec:
// the report's title, description and creation time, dct:isPartOf its
// conversation and prov:generated its Turtle file. The user bookmarks it in
// the frontend; the spec tab lists only the bookmarked ones. The Turtle file
// is what runs, outside the chat. A report links here with dct:conformsTo.
// Its source (prov:wasAttributedTo) is the assistant agent.
export async function registerReportSpec(title, description, conversationUri, specFileUri) {
  const id = uuid();
  const spec = `${REPORT_SPEC_BASE}${id}`;
  const titleLine = title ? `dct:title ${sparqlEscapeString(title)} ;\n        ` : '';
  const descriptionLine = description
    ? `dct:description ${sparqlEscapeString(description)} ;\n        `
    : '';
  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(spec)} a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} ;
        ${titleLine}${descriptionLine}prov:wasAttributedTo ${sparqlEscapeUri(CHAT_ASSISTANT_URI)} ;
        dct:created ${sparqlEscapeDateTime(new Date())} ;
        dct:isPartOf ${sparqlEscapeUri(conversationUri)} ;
        prov:generated ${sparqlEscapeUri(specFileUri)} .
    }`);
}

// The report of one run, pointing at the logical file of its CSV, so it
// shows up in the reports list. The description is the short text in the
// user's language, written from the conversation. The report conforms to its
// ReportSpec (dct:conformsTo); a spec that runs again gets one report per run.
// Its source (prov:wasAttributedTo) is the assistant agent, also on a re-run.
export async function registerReport(title, fileUri, description, specUri) {
  const id = uuid();
  const descriptionLine = description
    ? `dct:description ${sparqlEscapeString(description)} ;\n        `
    : '';
  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(`${REPORT_BASE}${id}`)} a ${sparqlEscapeUri(REPORT_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} ;
        dct:title ${sparqlEscapeString(title)} ;
        ${descriptionLine}prov:wasAttributedTo ${sparqlEscapeUri(CHAT_ASSISTANT_URI)} ;
        dct:created ${sparqlEscapeDateTime(new Date())} ;
        prov:generated ${sparqlEscapeUri(fileUri)} ;
        dct:conformsTo ${sparqlEscapeUri(specUri)} .
    }`);
}

// The ReportSpec with this uuid as { uri, title, description, specFileUri },
// or null when it does not exist or the caller may not read it. This read
// is the access check: the caller's session decides what is readable.
// specFileUri is its Turtle file (prov:generated).
export async function readReportSpec(id) {
  const result = await query(`${PREFIXES}
    SELECT ?spec ?title ?description ?specFile WHERE {
      ?spec a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        mu:uuid ${sparqlEscapeString(id)} .
      OPTIONAL { ?spec dct:title ?title . }
      OPTIONAL { ?spec dct:description ?description . }
      OPTIONAL { ?spec prov:generated ?specFile . }
    } LIMIT 1`);
  const binding = result.results.bindings[0];
  if (!binding) return null;
  return {
    uri: binding.spec.value,
    title: binding.title?.value,
    description: binding.description?.value,
    specFileUri: binding.specFile?.value,
  };
}

// The specs of a conversation, oldest first, as { fileUri, title, created }:
// the newest SPEC_LIMIT of them. The last one is the current spec. Only a
// ReportSpec over a spec file counts. The conversation was read as the
// caller, so these are the caller's specs.
export async function readConversationSpecs(conversationUri) {
  const result = await query(`${PREFIXES}
    SELECT ?file ?title ?created WHERE {
      ?spec a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        dct:isPartOf ${sparqlEscapeUri(conversationUri)} ;
        prov:generated ?file ;
        dct:created ?created .
      ?file dct:type ${sparqlEscapeUri(SPEC_TYPE)} .
      OPTIONAL { ?spec dct:title ?title . }
    } ORDER BY DESC(?created) LIMIT ${SPEC_LIMIT}`);
  return result.results.bindings.reverse().map(b => ({
    fileUri: b.file.value,
    title: b.title?.value,
    created: b.created.value,
  }));
}

// Writes a file to the share folder, where the file service serves it
// from.
export function writeShareFile(fileName, content) {
  writeFileSync(`${SHARE_DIR}/${fileName}`, content, 'utf8');
}

// A new spec bijlage; returns its logical file uri.
export async function storeSpecFile(spec) {
  const fileName = `specificatie-${uuid()}.ttl`;
  writeShareFile(fileName, spec);
  return registerFile(fileName, SPEC_MEDIA_TYPE, SPEC_TYPE);
}

// The Turtle of the spec bijlage with this logical file uri, or null when
// there is no such spec file. Only a file typed SPEC_TYPE passes, so this
// never opens a CSV. The physical file under it (nie:dataSource) says where
// the content is on the share.
export async function readSpecFile(fileUri) {
  if (!fileUri) return null;
  const result = await query(`${PREFIXES}
    SELECT ?physical WHERE {
      ${sparqlEscapeUri(fileUri)} dct:type ${sparqlEscapeUri(SPEC_TYPE)} .
      ?physical nie:dataSource ${sparqlEscapeUri(fileUri)} .
    } LIMIT 1`);
  const path = findSharePath(result.results.bindings[0]?.physical.value);
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// Where the physical file with this share:// uri is on disk, or null when
// the uri is no share uri or tries to leave the share.
function findSharePath(physicalUri) {
  if (!physicalUri?.startsWith(SHARE_PREFIX) || physicalUri.includes('..')) return null;
  return `${SHARE_DIR}/${physicalUri.slice(SHARE_PREFIX.length)}`;
}

// One logical file called `name` over the physical share file `shareName`,
// both nfo:FileDataObject with the bijlage type as dct:type. Returns the
// logical file uri. That is the shape the file service expects. A share
// name must be unique: two files on one share name overwrite each other.
export async function registerFile(shareName, format, type, name = shareName) {
  const id = uuid();
  const logical = `${FILE_BASE}${id}`;
  const size = sparqlEscapeInt(statSync(`${SHARE_DIR}/${shareName}`).size);
  const now = sparqlEscapeDateTime(new Date());

  await update(`${PREFIXES}
    INSERT DATA {
      ${sparqlEscapeUri(logical)} a nfo:FileDataObject ;
        mu:uuid ${sparqlEscapeString(id)} ;
        nfo:fileName ${sparqlEscapeString(name)} ;
        dct:format ${sparqlEscapeString(format)} ;
        nfo:fileSize ${size} ;
        nfo:fileCreated ${now} ;
        dct:type ${sparqlEscapeUri(type)} .
      ${sparqlEscapeUri(`${SHARE_PREFIX}${shareName}`)} a nfo:FileDataObject ;
        mu:uuid ${sparqlEscapeString(uuid())} ;
        nfo:fileName ${sparqlEscapeString(shareName)} ;
        dct:format ${sparqlEscapeString(format)} ;
        nfo:fileSize ${size} ;
        nfo:fileCreated ${now} ;
        nie:dataSource ${sparqlEscapeUri(logical)} ;
        dct:type ${sparqlEscapeUri(type)} .
    }`);

  return logical;
}

// Deletes the conversation, its messages, its report specs and its spec
// files (the logical file, the physical one under it and the share file).
// The reports stay, with their CSV: they are results, listed under Reports.
// A kept report's dct:conformsTo then points at a deleted spec. Returns how
// many share files it removed. It runs as the caller, so the auth layer
// keeps a user to their own conversation.
export async function deleteConversation(conversationUri) {
  const conversation = sparqlEscapeUri(conversationUri);

  // The spec files and their physical files first: once the triples are
  // gone they cannot be found back. Only a bijlage typed SPEC_TYPE counts:
  // the service sets that type, a client cannot, so a file attached to a
  // message by any other way is never removed from the share.
  const result = await query(`${PREFIXES}
    SELECT DISTINCT ?doc ?physical WHERE {
      ?message sioc:has_container ${conversation} ;
        as:attachment ?doc .
      ?doc dct:type ${sparqlEscapeUri(SPEC_TYPE)} .
      OPTIONAL { ?physical nie:dataSource ?doc . }
    }`);
  const rows = result.results.bindings;
  const docs = [...new Set(rows.map(b => b.doc.value))];
  const paths = [...new Set(rows.map(b => findSharePath(b.physical?.value)).filter(Boolean))];

  await update(`
    DELETE {
      ?conversation ?cp ?co .
    } WHERE {
      VALUES ?conversation { ${conversation} }
      ?conversation ?cp ?co .
    }`);

  await update(`${PREFIXES}
    DELETE {
      ?message ?mp ?mo .
    } WHERE {
      ?message sioc:has_container ${conversation} ;
        ?mp ?mo .
    }`);

  await update(`${PREFIXES}
    DELETE {
      ?spec ?sp ?so .
    } WHERE {
      ?spec a ${sparqlEscapeUri(REPORT_SPEC_CLASS)} ;
        dct:isPartOf ${conversation} ;
        ?sp ?so .
    }`);

  if (docs.length) {
    await update(`${PREFIXES}
      DELETE {
        ?doc ?dp ?do .
        ?physical ?pp ?po .
      } WHERE {
        VALUES ?doc { ${docs.map(sparqlEscapeUri).join(' ')} }
        ?doc ?dp ?do .
        OPTIONAL { ?physical nie:dataSource ?doc ; ?pp ?po . }
      }`);
  }

  let removed = 0;
  for (const path of paths) {
    try {
      unlinkSync(path);
      removed++;
    } catch {
      // the file was already gone
    }
  }
  return removed;
}
