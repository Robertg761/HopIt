import assert from 'node:assert/strict'
import test from 'node:test'

import { renderDmgReadme, renderMacInstaller } from '../../../scripts/package-hop-dmg.mjs'

test('DMG installer selects the Mac architecture and installs without administrator access', () => {
  const installer = renderMacInstaller({ version: '0.0.1+test' })
  assert.match(installer, /arm64 \| aarch64\) TARGET="darwin-arm64"/)
  assert.match(installer, /x86_64 \| amd64\) TARGET="darwin-x64"/)
  assert.match(installer, /INSTALL_DIR="\$\{HOPIT_INSTALL_DIR:-\$HOME\/\.hopit\}"/)
  assert.match(installer, /BIN_DIR="\$\{HOPIT_BIN_DIR:-\$HOME\/\.local\/bin\}"/)
  assert.match(installer, /exec "\$LAUNCHER" setup/)
  assert.equal(installer.includes('sudo'), false)
})

test('DMG readme explains the unsigned launch path honestly', () => {
  const readme = renderDmgReadme()
  assert.match(readme, /both Apple silicon and Intel runtimes/)
  assert.match(readme, /not signed or notarized/)
  assert.match(readme, /Control-click/)
})
