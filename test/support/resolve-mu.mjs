// Module hook: the bare import "mu" resolves to the stand-in.
const STAND_IN = new URL('./mu.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'mu') return { url: STAND_IN, shortCircuit: true };
  return nextResolve(specifier, context);
}
