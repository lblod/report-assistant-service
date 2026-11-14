// A refine turn where the model fills a report plan. The model gets the
// rules of a plan, the catalogue of the profiles and the conversation, and
// answers with one JSON object. The service compiles that plan to a spec
// (compile.js). A plan with mistakes goes back to the model once or twice,
// with every mistake in one message. No tool calls, no Turtle: this is what
// a small model can do.
//
// The answer to the user is not the model's text. It is written from the
// compiled spec (runner/render.js), so what the user agrees to is what runs.
import { callLlm } from '../llm/loop.js';
import { parseSpec } from '../runner/spec.js';
import { explainSpec } from '../runner/render.js';
import { SPEC_MEDIA_TYPE, readSpecFile } from '../chat.js';
import { buildCatalogue, renderCatalogue } from './catalogue.js';
import { compilePlan } from './compile.js';
import { loadCodes } from './read-codes.js';

// How often a plan with mistakes goes back to the model.
const MAX_REPAIRS = 2;
// PLAN_JSON_MODE=false leaves response_format out, for a provider that
// refuses it; the plan is then read from the text all the same.
const JSON_MODE = !/^(false|0)$/i.test(process.env.PLAN_JSON_MODE || '');
// The temperature of the plan call. Empty: not sent, for a model that only
// takes its own default.
const TEMPERATURE = process.env.PLAN_TEMPERATURE ?? '0';
// The first line of a spec file made from a plan holds that plan, so the
// next turn can hand the model its own plan back to change.
const PLAN_LINE = '# plan: ';

const TEXT = {
  confirm: 'De volledige specificatie staat in de bijlage. Zeg "voer uit" om dit rapport te maken, of zeg wat er anders moet.',
  failed: 'Het lukte niet om een geldig rapportvoorstel te maken. Formuleer de vraag anders of preciezer.',
};

const RULES = `You turn a Dutch question about a report into a JSON report plan. You never write SPARQL or Turtle and you never see the data. Reply with ONE JSON object and nothing else.

A report has one row per ENTITY of one profile, keeps the rows that pass all FILTERS, and shows the COLUMNS.

{
  "profile": "<profile name>",
  "entity": "<entity id: what one row is>",
  "title": "<short Dutch title>",
  "filters": [ <filter>, ... ],
  "columns": [ <column>, ... ]
}

A path is a list of field names from the catalogue, starting at the row entity. A field under "waarden" is a value and ends a path. A field under "links" (written "field > Entity") moves to that entity; the next step is a field of that entity. Text in [square brackets] is only an explanation of a field.

column: { "label": "<header>", "path": [ ... ] }
- "path": [] is the URI of the row itself. A path that ends on a link shows the name of that entity.
- optional "collect": "join" puts all values in one cell (optional "separator"); "min" or "max" keeps the lowest or highest date or number.
- optional "only_where": <filter> keeps only the values for which the filter holds. Its path also starts at the row entity and begins with the same steps as the column.

filter: { "path": [ ... ], and exactly one of the following }
- "is": "<name>"  the path ends on exactly this. On a link, give the NAME of the code or thing, never a URI.
- "is": { "<field>": "<value>", ... }  the path ends on one entity that has all these field values.
- "is_one_of": [ "<name>", ... ]
- "contains": "<text>"  the text occurs in the value, case does not matter.
- "from": "YYYY-MM-DD" and/or "to": "YYYY-MM-DD"  for dates and numbers.
- "exists": true or false  the path leads somewhere, or leads nowhere.
- "none": { "is": ... } or { "contains": ... }  nothing on the path matches. Use it for "has no ...".

Rules:
- You choose the profile and the entity; the user never names them. Entity ids are the words at the start of a line in the catalogue; a Dutch word in round brackets after an id is only its label.
- Filters are optional. A question without a condition lists all rows: "filters": []. Never refuse because a question is broad.
- Use only names from the catalogue, spelled exactly. Codes are listed after "codes:"; use their exact names.
- When the catalogue says how one entity is pointed at, follow it: "de gemeente Aalst" is a Bestuurseenheid, so the path that ends on the Bestuurseenheid gets "is": { "soort bestuur": "Gemeente", "naam": "Aalst" }.
- The only things you cannot do are: count, sort, take a top N or first N, compare rows with each other, and show data that no profile has. Only then reply { "cannot": "<one Dutch sentence that says why>" }. In every other case reply with a plan, also when you are not sure.
- When the user changes the current plan, reply with the full new plan.`;

// Worked examples, in the names of the portal's profiles. They show the
// form; the model takes the names from the catalogue.
const EXAMPLES = `Examples.
Question: Geef alle vestigingen van het type Gemeentehuis met hun omschrijving.
{"profile":"Organisaties","entity":"Vestiging","title":"Gemeentehuizen","filters":[{"path":["type vestiging"],"is":"Gemeentehuis"}],"columns":[{"label":"omschrijving","path":["omschrijving"]}]}
Question: Welke schepenen van de gemeente Aalst zijn in 2024 gestart? Toon achternaam en startdatum.
{"profile":"Mandaten","entity":"Mandataris","title":"Schepenen van Aalst gestart in 2024","filters":[{"path":["bekleedt mandaat","bestuursfunctie"],"is":"Schepen"},{"path":["start"],"from":"2024-01-01","to":"2024-12-31"},{"path":["bekleedt mandaat","zit in bestuursorgaan","is tijdspecialisatie van","bestuurt"],"is":{"soort bestuur":"Gemeente","naam":"Aalst"}}],"columns":[{"label":"achternaam","path":["persoon","achternaam"]},{"label":"startdatum","path":["start"]}]}
Question: Welke organisaties hebben geen hoofdvestiging?
{"profile":"Organisaties","entity":"Organisatie","title":"Organisaties zonder hoofdvestiging","filters":[{"path":["hoofdvestiging"],"exists":false}],"columns":[{"label":"naam","path":["naam"]}]}
Question: Hoeveel mandatarissen heeft elke gemeente?
{"cannot":"Tellen is niet mogelijk: een rapport toont rijen, geen aantallen."}`;

// One refine turn. turns is the conversation so far, [{ role, content,
// attachments }], newest last. Returns { text, spec }: the answer for the
// user and the spec to attach to it, or null when the turn gave none. Same
// shape as ask() of the tool loop.
export async function propose(turns, profiles) {
  const catalogue = buildCatalogue(profiles);
  const codes = await loadCodes(catalogue);
  const messages = buildMessages(turns, renderCatalogue(catalogue, codes));

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const message = await callLlm(messages, { extra: buildRequestFields() });
    const reply = message.content || '';
    const plan = readPlan(reply);
    let errors;
    if (!plan) {
      errors = [message.finishReason === 'length'
        ? 'the reply was cut off before the JSON object was complete. Reply with the JSON object only.'
        : 'the reply is not one JSON object.'];
    } else if (typeof plan.cannot === 'string' && plan.cannot.trim() && !plan.entity) {
      return { text: plan.cannot.trim(), spec: null };
    } else {
      const compiled = compilePlan(plan, profiles, codes);
      if (!compiled.errors.length) return { text: writeProposal(compiled, profiles, codes), spec: `${PLAN_LINE}${JSON.stringify(plan)}\n${compiled.turtle}` };
      errors = compiled.errors;
    }
    console.log(`[plan] the plan has ${errors.length} mistake(s)${attempt < MAX_REPAIRS ? '; asking the model again' : ''}`);
    messages.push({ role: 'assistant', content: reply || '{}' });
    messages.push({
      role: 'user',
      content: `That plan cannot be used:\n${errors.map(e => `- ${e}`).join('\n')}\nReply with the full corrected JSON plan and nothing else.`,
    });
  }
  return { text: TEXT.failed, spec: null };
}

// The system prompt (rules, examples, today's date, the catalogue), the
// conversation so far, and the last message with the current plan under it.
function buildMessages(turns, catalogue) {
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: 'system', content: `${RULES}\n\n${EXAMPLES}\n\nToday is ${today}.\n\nCATALOGUE\n${catalogue}` }];
  for (const turn of turns.slice(0, -1)) messages.push({ role: turn.role, content: turn.content });
  const last = turns.at(-1);
  const plan = findCurrentPlan(turns);
  messages.push({ role: last.role, content: plan ? `${last.content}\n\nThe current plan:\n${JSON.stringify(plan)}` : last.content });
  return messages;
}

// What the plan call adds to the request, by the settings above.
function buildRequestFields() {
  const fields = {};
  if (JSON_MODE) fields.response_format = { type: 'json_object' };
  if (TEMPERATURE.trim() !== '' && Number.isFinite(Number(TEMPERATURE))) fields.temperature = Number(TEMPERATURE);
  return fields;
}

// The plan of the last spec bijlage in the conversation, or null: there is
// no spec yet, or it was not made from a plan (the tool loop wrote it).
function findCurrentPlan(turns) {
  const name = turns.flatMap(t => t.attachments || [])
    .filter(a => a.mediaType === SPEC_MEDIA_TYPE).at(-1)?.name;
  const turtle = name ? readSpecFile(name) : null;
  const firstLine = (turtle || '').split('\n')[0];
  return firstLine.startsWith(PLAN_LINE) ? readPlan(firstLine.slice(PLAN_LINE.length)) : null;
}

// The JSON object in a reply, also when the model put a code fence or words
// around it. Null when there is none.
export function readPlan(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The answer of a turn that gave a spec: the spec in words, with what the
// compiler wants the user to know, and how to go on.
function writeProposal({ turtle, notes }, profiles, codes) {
  const spec = parseSpec(turtle);
  return `${explainSpec(spec, profiles.get(spec.profileUri), codes.labelOf, notes)}\n\n${TEXT.confirm}`;
}
