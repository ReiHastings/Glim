// title: resolve-extensionless.mjs
// project: Glim
// author: Reina Hastings
//
// purpose:
//   Node ESM resolve hook (test tooling only). The source uses Vite-style
//   extensionless relative imports (e.g. '../utils/dateUtils'); Vite resolves
//   these, but bare Node ESM does not. This hook appends '.js' to extensionless
//   relative specifiers so the standalone .mjs invariant tests can import the
//   REAL source modules unchanged. It does not touch application code.

export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.(m?js|cjs|json)$/.test(specifier)) {
    try {
      return await next(specifier + '.js', context);
    } catch { /* fall through to default resolution below */ }
  }
  return next(specifier, context);
}
