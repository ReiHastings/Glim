// Node ESM resolve hook (test-only) for the sync scenario test. Aliases the
// firebase modules to in-memory mocks so the REAL sync.js runs against a fake
// Firestore, and appends '.js' to any other extensionless relative import
// (Vite-style) so source modules resolve under bare Node.

export async function resolve(specifier, context, next) {
  if (specifier === 'firebase/firestore') {
    return { url: new URL('./mocks/firestore.mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === './firebase' || specifier.endsWith('/firebase')) {
    return { url: new URL('./mocks/firebase.mock.mjs', import.meta.url).href, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.(m?js|cjs|json)$/.test(specifier)) {
    try {
      return await next(specifier + '.js', context);
    } catch { /* fall through to default resolution */ }
  }
  return next(specifier, context);
}
