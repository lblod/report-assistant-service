## Unreleased

#### :rocket: Enhancement
- The LLM fills a JSON plan that the service compiles to the spec; the tool loop stays behind `REFINE_PROTOCOL=tools` [RVS-58]
- Write the proposal and the report description from the spec instead of with the LLM [RVS-58]

#### :bug: Bug Fix
- Read LLM answers that come as a list of parts [RVS-58]
- Time limit on LLM calls and retry on a 429 [RVS-58]
- Refuse a spec with a looping RDF list instead of hanging on it [RVS-58]
- Refuse a spec without a title before it runs [RVS-58]
- Same data gives the same CSV: fixed order of rows and joined values [RVS-58]

#### :house: Internal
- Add tests, run with `npm test` [RVS-58]

## v0.1.0 (2026-11-06)

#### :rocket: Enhancement
- initial release
