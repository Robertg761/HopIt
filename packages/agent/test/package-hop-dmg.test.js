import assert from 'node:assert/strict'
import test from 'node:test'

import { renderDmgReadme } from '../../../scripts/package-hop-dmg.mjs'

test('DMG readme explains drag installation and the unsigned launch path honestly', () => {
  const readme = renderDmgReadme()
  assert.match(readme, /Drag HopIt into the Applications folder/)
  assert.match(readme, /universal app for Apple silicon and Intel Macs/)
  assert.match(readme, /terminal installer are not required/)
  assert.match(readme, /not signed or notarized/)
  assert.match(readme, /Control-click/)
})
