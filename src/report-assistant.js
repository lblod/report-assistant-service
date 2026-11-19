// The answer to a chat turn, as { text, attachments }. Every bijlage exists
// before the answer is written.
//
// The LLM proposes a spec. The last spec that checked out goes on the answer
// as a bijlage, not in the text. Nothing runs in the chat.
//
// Every spec bijlage has a ReportSpec. It runs outside the chat, with no
// LLM: prepareSpec reads and checks it, runSavedSpec runs it.
import { uuid } from 'mu';
import { ask } from './llm/loop.js';
import { parseSpec } from './runner/spec.js';
import { checkSpec } from './runner/check.js';
import { runReport } from './runner/run.js';
import { describeReport } from './llm/summary.js';
import { storeSpecFile, readSpecFile, readConversationSpecs, writeShareFile, registerFile,
         registerReport, registerReportSpec, RESULT_TYPE } from './chat.js';

const NO_ANSWER = 'Er kwam geen antwoord. Probeer het opnieuw.';

// One refine turn: the LLM answers, and the spec it validated is stored and
// attached to that answer as a bijlage. The spec also gets its ReportSpec,
// with a description the LLM writes from the conversation, so the user can
// bookmark and run it. The description is nice to have: a failing LLM call
// must not block the answer. An empty answer (a reasoning model can end with
// no text) gets a fixed text and no spec: only a spec the user saw explained
// may run.
export async function refineSpec(turns, profiles, conversationUri) {
  const specs = await readConversationSpecs(conversationUri);
  const { text, spec } = await ask(turns, profiles, specs);
  if (!text.trim()) return { text: NO_ANSWER };
  if (!spec) return { text: text.trim(), attachments: [] };

  const specFile = await storeSpecFile(spec);
  const title = parseSpec(spec).title;
  let description;
  try {
    description = await describeReport([...turns, { role: 'assistant', content: text }], title);
  } catch (e) {
    console.error('[chat] no description for the spec:', e);
  }
  await registerReportSpec(title, description, conversationUri, specFile);
  return { text: text.trim(), attachments: [specFile] };
}

// A spec file read, parsed and checked against the profiles as they are
// now. Returns { spec }, or { error } with one sentence saying why it cannot
// run.
export async function prepareSpec(fileUri, profiles) {
  const content = await readSpecFile(fileUri);
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
// the ReportSpec's description. The CSV goes to the share and is registered
// as a result file, named after the spec's title so it downloads under a
// readable name. The share name is unique, so a second run never overwrites
// the first. Throws when the run fails.
export async function runSavedSpec(spec, reportSpec, profiles) {
  const shareName = `${uuid()}.csv`;
  writeShareFile(shareName, await runReport(spec, profiles.get(spec.profileUri)));
  const csvFile = await registerFile(shareName, 'text/csv', RESULT_TYPE, `${slugify(spec.title)}.csv`);
  await registerReport(spec.title, csvFile, reportSpec.description, reportSpec.uri);
}

// A file name from a title. Falls back to "report".
function slugify(title) {
  return (title || 'report').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'report';
}
