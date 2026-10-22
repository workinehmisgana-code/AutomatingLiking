// Compile and run a TypeScript check, then clean up.
//
//   node scripts/run-ts-check.mjs scripts/check-genre-feed.ts
//
// The check is TypeScript because it tests the REAL feed functions rather than a
// copy of them, and there is no TS runner in this project — only the compiler.
//
// PASSING HERE IS NOT PASSING THE BUILD. This compiles with --target es2020 so
// the script can run under node; the project tsconfig has no target at all, so
// `next build` type-checks these same files as ES5 and rejects things this
// accepts — spreading a Map iterator, for one. A script that runs fine here can
// still fail the deploy, so run `tsc --noEmit` after adding one.
// So: transpile the four files it needs into a throwaway directory, run it, and
// delete the directory whatever happened.
//
//   node scripts/run-genre-feed-check.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const out = join(root, '.checkbuild')
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/run-ts-check.mjs <scripts/check-something.ts>')
  process.exit(2)
}
const compiled = target.replace(/\.ts$/, '.js')

// The compiler is invoked through node rather than through npx: spawning a .cmd
// shim on Windows needs a shell, and `npx tsc` failing for that reason looked
// exactly like the check not compiling.
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const tsc = spawnSync(
  process.execPath,
  [
    tscBin,
    target,
    '--outDir', '.checkbuild',
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    // As the project tsconfig: default imports of CommonJS packages (nodemailer).
    '--esModuleInterop',
    // The feed and config files are plain functions; nothing here needs the
    // Next.js path aliases or the DOM lib.
    '--types', 'node',
  ],
  { cwd: root, stdio: 'inherit' }
)

if (tsc.status !== 0) {
  rmSync(out, { recursive: true, force: true })
  console.error('[!] could not compile the check')
  process.exit(tsc.status ?? 1)
}

// Anything after the target is forwarded to the script. Without this a flag
// like --write was silently swallowed and the script ran in its read-only
// default, reporting that it had written nothing - which looks exactly like a
// script that decided not to.
// WHERE TSC PUT IT. The output path depends on the COMMON ROOT of everything
// compiled: a check that imports ../lib/* gets .checkbuild/scripts/x.js, and
// one that imports nothing outside scripts/ gets .checkbuild/x.js. Assuming the
// first gave "Cannot find module" on the second, which reads like a compile
// failure and is not one.
const candidates = [join(out, compiled), join(out, basename(compiled))]
const entry = candidates.find((p) => existsSync(p))
if (!entry) {
  rmSync(out, { recursive: true, force: true })
  console.error(`[!] compiled, but no output at:\n    ${candidates.join('\n    ')}`)
  process.exit(1)
}

const run = spawnSync(process.execPath, [entry, ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
})
rmSync(out, { recursive: true, force: true })
process.exit(run.status ?? 1)
