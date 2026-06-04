// TypeScript 6.0 enabled `noUncheckedSideEffectImports` by default, so a
// side-effect import like `import './globals.css'` now needs a declaration.
// Next.js ships types for `*.module.css` but not for plain global CSS imports.
declare module '*.css'
