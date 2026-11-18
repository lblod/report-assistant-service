// The tools the LLM calls, refinement only: describe_profile,
// validate_spec, read_spec and lookup_values. Each returns { content }, the
// plain text for the model; validate_spec adds spec when the spec checked
// out. No report is created, no spec is evaluated; the database reads run
// under the service scope (public graph).
import { parseSpec } from '../runner/spec.js';
import { checkSpec, buildWhereNotes, checkProfile } from '../runner/check.js';
import { describeProfile } from './describe.js';
import { lookupValues } from './explore.js';
import { readSpecFile } from '../chat.js';

// The tool definitions sent to the model, in the OpenAI format. The
// descriptions are what the LLM reads to decide which tool to call.
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'describe_profile',
      description: 'Describe one profile: its entities, fields, relations and labels. Inline the values of short code lists.',
      parameters: {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'The profile URI from the profile list' },
        },
        required: ['profile_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'validate_spec',
      description: 'Validate a report spec (Turtle). Returns "ok", followed by one line per rep:where saying where it applies, or one clear sentence saying what is wrong and what to write instead. No database is touched.',
      parameters: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'The spec as Turtle text' },
        },
        required: ['spec'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_spec',
      description: 'Return the Turtle of an older spec of this conversation. The current spec already comes with the user\'s message; use this only when the user asks for an older spec. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          file_uri: { type: 'string', description: 'The file URI of the spec, as its spec line in the conversation shows it' },
        },
        required: ['file_uri'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_values',
      description: 'Search the names (skos:prefLabel) of what a link field reaches, a code list or an entity such as a bestuurseenheid, for a term, so a filter can test the link with the URI (sh:hasValue or sh:in). Returns up to 25 matches with their URIs and labels, a note when there may be more, and an exact flag when a label equals the term. Reads candidate values only; it never tells you how many subjects a spec would match. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'The profile URI from the profile list' },
          field: { type: 'string', description: 'The field as "entityLabel.fieldLabel", e.g. "bestuurseenheid.naam"' },
          term: { type: 'string', description: 'The Dutch word or name to search for' },
        },
        required: ['profile_id', 'field', 'term'],
      },
    },
  },
];

// Runs the tool the model asked for, by name. Returns { content } or, for
// validate_spec, { content, spec }: see the top of this file. specs are the
// specs of this conversation: read_spec opens no other.
export async function runTool(name, args, profiles, specs) {
  switch (name) {
    case 'describe_profile': return { content: await handleDescribeProfile(args, profiles) };
    case 'validate_spec': return handleValidateSpec(args, profiles);
    case 'read_spec': return { content: await handleReadSpec(args, specs) };
    case 'lookup_values': return { content: await handleLookupValues(args, profiles) };
    default: return { content: `unknown tool "${name}"` };
  }
}

// describe_profile: the menu of one profile. The system prompt only holds
// the menu of the current spec's profile; this gives the model any other.
async function handleDescribeProfile({ profile_id }, profiles) {
  return checkProfile(profiles, profile_id) || describeProfile(profiles.get(profile_id));
}

// validate_spec: parse and check a spec. The model gets "ok" plus where
// each rep:where applies, or one error sentence it can act on. An accepted
// spec also comes back as spec: this check is the only way into a bijlage.
function handleValidateSpec({ spec }, profiles) {
  let parsed;
  try {
    parsed = parseSpec(spec);
  } catch (e) {
    return { content: `the spec did not parse: ${e.message}` };
  }
  const error = checkSpec(parsed, profiles);
  if (error) return { content: error };
  return { content: ['ok', ...buildWhereNotes(parsed, profiles.get(parsed.profileUri))].join('\n'), spec };
}

// read_spec: the Turtle of an older spec, so the user can go back to it.
// Only a spec of this conversation is readable: the model names the file,
// and it must not reach another user's spec. The model may copy the uri
// with its angle brackets.
async function handleReadSpec({ file_uri }, specs) {
  const fileUri = String(file_uri || '').trim().replace(/^<|>$/g, '');
  if (!specs.some(s => s.fileUri === fileUri)) return 'no such spec file.';
  return await readSpecFile(fileUri) || 'no such spec file.';
}

// lookup_values: code-list values that match a term, so a filter names
// real URIs instead of guesses.
async function handleLookupValues({ profile_id, field, term }, profiles) {
  const error = checkProfile(profiles, profile_id);
  if (error) return error;
  if (!term) return 'no term to search for.';
  return lookupValues(profiles.get(profile_id), field, term);
}
