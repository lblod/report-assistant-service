// The names of code lists and other things with a name, as far as the
// service scope reads them (the public graph). The compiler resolves the
// names in a plan with them, and the catalogue shows the short code lists.

// What was read, ready to ask questions of. lists: Map from class URI to
// { values: [{ uri, label }], more }; more says the class holds more than
// was read.
export function createCodes(lists) {
  const names = new Map();
  for (const { values } of lists.values()) {
    for (const { uri, label } of values) if (!names.has(uri)) names.set(uri, label);
  }
  // true when the class was read in full and holds something
  const isComplete = (classUri) => {
    const list = lists.get(classUri);
    return !!list && list.values.length > 0 && !list.more;
  };
  return {
    isComplete,
    // the names of a class in alphabetical order, each once
    labels(classUri) {
      const labels = (lists.get(classUri)?.values || []).map(v => v.label);
      return [...new Set(labels)].sort((a, b) => a.localeCompare(b, 'nl'));
    },
    // The URIs in a class that carry this name, case aside. None of a class
    // that was not read in full: the name could belong to a thing that was
    // not read.
    find(classUri, name) {
      if (!isComplete(classUri)) return [];
      const wanted = normalise(name);
      return [...new Set(lists.get(classUri).values.filter(v => normalise(v.label) === wanted).map(v => v.uri))];
    },
    // the name of a URI, or undefined
    labelOf: (uri) => names.get(uri),
  };
}

// Nothing read: every name in a plan is then matched as text.
export const NO_CODES = createCodes(new Map());

function normalise(text) {
  return String(text ?? '').trim().toLowerCase();
}
