import assert from 'node:assert/strict'
import test from 'node:test'

import {
  accessContextForCodebaseHead,
  filterVisibleGraphForRequester,
} from '../../backend-d1/src/helpers/access.js'

const sharedPaths = ['README.md', 'src/index.js']
const privatePaths = ['.private/notes.md']

test('D1 access matrix hides private active drafts and preserves team and review visibility', () => {
  const cases = [
    { requester: 'owner', visibility: 'private', expected: [...sharedPaths, ...privatePaths] },
    { requester: 'member', visibility: 'private', expected: [] },
    { requester: 'viewer', visibility: 'private', expected: [] },
    { requester: 'guest', visibility: 'private', expected: [] },
    { requester: 'member', visibility: 'team-visible', expected: sharedPaths },
    { requester: 'viewer', visibility: 'team-visible', expected: sharedPaths },
    { requester: 'member', visibility: 'review-visible', expected: sharedPaths },
    { requester: 'viewer', visibility: 'review-visible', expected: sharedPaths },
    { requester: 'guest', visibility: 'review-visible', expected: [] },
  ]

  for (const { requester, visibility, expected } of cases) {
    const graph = makeGraph({ visibility })
    const request = requestFor(requester)
    const visible = filterVisibleGraphForRequester(graph, request)
    assert.deepEqual(
      Object.keys(visible.files).sort(),
      [...expected].sort(),
      `${requester} with ${visibility} visibility`,
    )
    assert.equal(visible.visibilityContext.visibleFileCount, expected.length)
    assert.equal(visible.visibilityContext.hiddenFileCount, 3 - expected.length)
    assert.deepEqual(visible.visibilityContext.hiddenScopeCounts, {
      shared: sharedPaths.length - expected.filter((path) => !path.startsWith('.private/')).length,
      private: requester === 'owner' ? 0 : privatePaths.length,
    })
  }
})

test('D1 access matrix exposes shared Main files while keeping owner-private paths owner-only', () => {
  const graph = makeGraph({ visibility: 'private', selectedStateType: 'main' })

  for (const requester of ['member', 'viewer']) {
    const visible = filterVisibleGraphForRequester(graph, requestFor(requester))
    assert.deepEqual(Object.keys(visible.files).sort(), [...sharedPaths].sort())
  }

  const guest = filterVisibleGraphForRequester(graph, requestFor('guest'))
  assert.deepEqual(Object.keys(guest.files), [])
  const owner = filterVisibleGraphForRequester(graph, requestFor('owner'))
  assert.deepEqual(Object.keys(owner.files).sort(), [...sharedPaths, ...privatePaths].sort())
})

test('D1 head access counts follow the same draft visibility matrix', () => {
  for (const visibility of ['private', 'team-visible', 'review-visible']) {
    const graph = makeGraph({ visibility })
    const filtered = filterVisibleGraphForRequester(graph, requestFor('member'))
    const headAccess = accessContextForCodebaseHead({
      fileCount: 3,
      privateFileCount: 1,
      selectedState: graph.selectedState,
      visibility: graph.visibility,
    }, filtered.visibilityContext)

    assert.equal(headAccess.visibleFileCount, visibility === 'private' ? 0 : 2)
    assert.equal(headAccess.hiddenFileCount, visibility === 'private' ? 3 : 1)
    assert.deepEqual(headAccess.hiddenScopeCounts, {
      shared: visibility === 'private' ? 2 : 0,
      private: 1,
    })
  }
})

function requestFor(requester) {
  if (requester === 'owner') return { requesterId: 'user-owner' }
  if (requester === 'guest') return { requesterId: 'user-guest' }
  return {
    requesterId: `user-${requester}`,
    membership: {
      user_id: `user-${requester}`,
      role: requester,
      status: 'active',
      source: 'test-membership',
    },
  }
}

function makeGraph({ visibility, selectedStateType = 'active-change-set' }) {
  return {
    schemaVersion: 2,
    codebase: { id: 'security-core', name: 'Security Core', ownerId: 'user-owner' },
    main: { id: 'main', revision: 1 },
    selectedState: {
      type: selectedStateType,
      id: selectedStateType === 'main' ? 'main' : 'cs_security',
      ownerId: 'user-owner',
      revision: 1,
      effectiveVisibility: visibility,
    },
    owner: { id: 'user-owner' },
    collaborators: [],
    visibility: { effective: visibility },
    revision: 1,
    files: {
      'README.md': { kind: 'file', content: 'readme', revision: 1, scope: 'shared' },
      'src/index.js': { kind: 'file', content: 'source', revision: 1, scope: 'shared' },
      '.private/notes.md': { kind: 'file', content: 'secret', revision: 1, scope: 'owner-private' },
    },
  }
}
