/**
 * Preflight: fail fast with a clear message when node_modules is missing or
 * stale relative to package-lock.json — instead of a cryptic deep
 * ERR_MODULE_NOT_FOUND once some module imports a not-yet-installed package
 * (e.g. the @opentelemetry/* deps added by the OTel logging work).
 *
 * Signal: npm rewrites node_modules/.package-lock.json on every install, so if
 * the committed lockfile is newer than that marker, deps changed since the last
 * install. Runs as predev/prebuild — see package.json.
 */
import { existsSync, statSync } from 'node:fs'

const LOCKFILE = 'package-lock.json'
const INSTALL_MARKER = 'node_modules/.package-lock.json'

function die(reason) {
  process.stderr.write(
    `\n\x1b[31m✖ Dependencies are out of date:\x1b[0m ${reason}\n` +
    `  Run \x1b[1mnpm install\x1b[0m, then retry.\n\n`,
  )
  process.exit(1)
}

if (!existsSync('node_modules')) die('node_modules/ is missing')
if (!existsSync(INSTALL_MARKER)) die(`no install marker (${INSTALL_MARKER})`)

if (statSync(LOCKFILE).mtimeMs > statSync(INSTALL_MARKER).mtimeMs) {
  die(`${LOCKFILE} is newer than the last install`)
}
