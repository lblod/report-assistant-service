// The answer to a chat turn, as { text, attachments }. Every bijlage exists
// before the answer is written.
//
// The LLM proposes a spec. The last spec that checked out goes on the answer
// as a bijlage, not in the text. Nothing runs in the chat.
//
// The user saves a spec as a report spec. A saved spec runs outside the
// chat, with no LLM: prepareSpec reads and checks it, runSavedSpec runs it.
import { uuid } from 'mu';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { runReport } from './runner/run.js';
import { storeSpecFile, readSpecFile, writeShareFile, registerFile, registerReport,
         SPEC_MEDIA_TYPE, RESULT_TYPE } from './chat.js';

const NO_ANSWER = 'Er kwam geen antwoord. Probeer het opnieuw.';

// One refine turn: the LLM answers, and the spec it validated is stored and
// attached to that answer as a bijlage. An empty answer (a reasoning model
// can end with no text) gets a fixed text and no spec: only a spec the user
// saw explained may run.
export async function refineSpec(turns, profiles) {
  const { text, spec } = await ask(turns, profiles);
  if (!text.trim()) return { text: NO_ANSWER };
  const attachments = spec ? [await storeSpecFile(spec)] : [];
  return { text: text.trim(), attachments };
}

// A spec file read, parsed and checked against the profiles as they are
// now. Returns { spec }, or { error } with one sentence saying why it cannot
// run. The chat and the spec tab both go through here.
export function prepareSpec(fileName, profiles) {
  const content = readSpecFile(fileName);
  if (!content) return { error: 'this report spec has no spec file' };
  let spec;
  try {
    spec = parseSpec(content);
  } catch (e) {
    return { error: `the spec file did not parse: ${e.message}` };
  }
  const error = checkSpec(spec, profiles);
  return error ? { error } : { spec };
}

// Runs a saved spec again as the user, outside the chat, and records a new
// report that conforms to the same ReportSpec. No LLM: the new report keeps
// the ReportSpec's description. Throws when the run fails.
export async function runSavedSpec(spec, reportSpec, profiles) {
  const csvFile = await runSpec(spec, profiles);
  await registerReport(spec.title, csvFile, reportSpec.description, reportSpec.uri);
}

// Runs a spec as the user, writes the CSV to the share and registers it as a
// result file, named after the spec's title so it downloads under a readable
// name. Returns the logical file uri. The share name is unique, so a second
// run never overwrites the first.
async function runSpec(spec, profiles) {
  const shareName = `${uuid()}.csv`;
  writeShareFile(shareName, await runReport(spec, profiles.get(spec.profileUri)));
  return registerFile(shareName, 'text/csv', RESULT_TYPE, `${slugify(spec.title)}.csv`);
}

// The spec bijlage with this uri in the history, or null. A save names its
// spec by uri; only a spec attached to a message of the conversation counts.
export function findSpecAttachment(history, uri) {
  return history.flatMap(message => message.attachments)
    .find(a => a.mediaType === SPEC_MEDIA_TYPE && a.uri === uri) || null;
}

// A file name from a title. Falls back to "report".
function slugify(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
