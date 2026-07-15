import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const __filename = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..')
const packagerPath = path.join(repoRoot, 'scripts', 'package-hop.mjs')
const packagerSource = readFileSync(packagerPath, 'utf8')

// Pull an embedded support-file template out of the packager source and resolve
// it the same way JS would at runtime, so we assert against the exact POSIX sh
// that reaches disk (escaping and all) without a network build.
function resolveTemplate(name) {
  const marker = `'${name}',`
  const i = packagerSource.indexOf(marker)
  assert.ok(i >= 0, `expected an embedded template for ${name}`)
  const start = packagerSource.indexOf('`', i) + 1
  const end = packagerSource.indexOf('`', start)
  assert.ok(start > 0 && end > start, `expected a template literal for ${name}`)
  const raw = packagerSource.slice(start, end)
  // The templates contain only escape sequences (no ${} interpolation reaches
  // JS: literal ${...} is written as \${...}), so this is a pure string.
  return Function('return `' + raw + '`')()
}

const macos = resolveTemplate('install-macos-launch-agent.sh')
const systemd = resolveTemplate('install-systemd-user-service.sh')

for (const [label, script] of [['macos', macos], ['systemd', systemd]]) {
  test(`${label} installer is valid POSIX sh (sh -n)`, () => {
    const result = spawnSync('sh', ['-n', '-'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, `sh -n failed: ${result.stderr || result.stdout}`)
  })

  test(`${label} installer writes a hop wrapper that execs the packaged launcher by absolute path`, () => {
    // The wrapper lives in an unquoted heredoc: $PACKAGE_ROOT expands at
    // install time while "\$@" stays literal so the wrapper forwards its own
    // arguments at runtime.
    assert.match(script, /exec "\$PACKAGE_ROOT\/bin\/hop" "\\\$@"/, 'expected the wrapper to exec $PACKAGE_ROOT/bin/hop with "$@"')
    assert.match(script, /HOP_STAGE="\$BIN_DIR\/\.hop\.new\.\$\$"/, 'expected a staged temp wrapper')
    assert.match(script, /mv -f "\$HOP_STAGE" "\$HOP_LINK"/, 'expected atomic activation of the wrapper')
  })

  test(`${label} installer prefers /usr/local/bin, falls back to ~/.local/bin`, () => {
    assert.match(script, /if \[ -w \/usr\/local\/bin \]; then/, 'expected a writable /usr/local/bin preference')
    assert.match(script, /BIN_DIR=\/usr\/local\/bin/, 'expected /usr/local/bin as the preferred target')
    assert.match(script, /BIN_DIR="\$HOME\/\.local\/bin"/, 'expected a ~/.local/bin fallback')
  })

  test(`${label} installer prints a PATH hint without editing rc files`, () => {
    assert.match(script, /is not on your PATH\. Add it with:/, 'expected a one-line PATH hint')
    assert.match(script, /export PATH=\\"\$BIN_DIR:\\\$PATH\\"/, 'expected the export PATH suggestion')
    assert.match(script, /case ":\$\{PATH\}:" in/, 'expected the same PATH membership check as public/install.sh')
    // Must not touch shell rc files.
    assert.equal(/\.bashrc|\.zshrc|\.profile/.test(script), false, 'installer must not edit shell rc files')
  })

  test(`${label} installer confirms the global command target`, () => {
    assert.match(script, /Global command: \$HOP_LINK -> \$PACKAGE_ROOT\/bin\/hop/, 'expected a confirmation line')
  })
}
