// Node module customization hooks for plain-node unit tests.
// Redirects 'electron' and the app's store module to test stubs, because the
// real store needs better-sqlite3 built for Electron and the real electron
// package has no safeStorage outside Electron.
// All code, comments, log messages and docs in this project are English only.

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (
    context.parentURL?.includes('/dist/main/') &&
    (specifier === './store.js' || specifier === '../store.js')
  ) {
    return { url: new URL('./store-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
