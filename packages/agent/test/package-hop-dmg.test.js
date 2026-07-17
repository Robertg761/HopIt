import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDmgSpecification } from '../../../scripts/package-hop-dmg.mjs'

test('DMG Finder layout presents only the drag installation surface', () => {
  const specification = buildDmgSpecification({ appPath: '/tmp/HopIt.app' })
  assert.equal(specification.background.endsWith('HopIt-dmg-background.png'), true)
  assert.equal(specification['icon-size'], 128)
  assert.deepEqual(specification.window.size, { width: 660, height: 420 })
  assert.deepEqual(specification.contents, [
    { x: 170, y: 235, type: 'file', path: '/tmp/HopIt.app' },
    { x: 490, y: 235, type: 'link', path: '/Applications' },
  ])
})
