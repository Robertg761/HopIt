import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_EPISODE_GAP_MS,
  clusterEpisodes,
  episodeId,
  stepsFromVersionRows,
} from '@hopit/backend-d1'

const BASE = Date.parse('2026-07-12T09:00:00.000Z')

// Build a file-version row shaped like listFileVersions() output.
function row({ revision, path, device = 'Laptop', minute = 0, second = 0 }) {
  const createdAt = new Date(BASE + minute * 60000 + second * 1000).toISOString()
  return { graphRevision: revision, path, deviceName: device, createdAt }
}

test('clusterEpisodes returns no episodes for empty input', () => {
  assert.deepEqual(clusterEpisodes([]), [])
  assert.deepEqual(clusterEpisodes(null), [])
})

test('clusterEpisodes groups one revision with many files into a single step', () => {
  const rows = [
    row({ revision: 1, path: 'src/a.js', minute: 0 }),
    row({ revision: 1, path: 'src/b.js', minute: 0 }),
    row({ revision: 1, path: 'README.md', minute: 0 }),
  ]
  const [episode] = clusterEpisodes(rows)
  assert.equal(episode.fromRevision, 1)
  assert.equal(episode.toRevision, 1)
  assert.equal(episode.stepCount, 1)
  assert.equal(episode.changedPathCount, 3)
  assert.deepEqual(episode.samplePaths, ['README.md', 'src/a.js', 'src/b.js'])
  assert.equal(episode.episodeId, episodeId(1, 1))
})

test('clusterEpisodes keeps steps under the gap threshold in one episode', () => {
  const rows = [
    row({ revision: 1, path: 'src/a.js', minute: 0 }),
    row({ revision: 2, path: 'src/b.js', minute: 10 }),
    row({ revision: 3, path: 'src/c.js', minute: 20 }),
  ]
  const episodes = clusterEpisodes(rows, { gapMs: DEFAULT_EPISODE_GAP_MS })
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].stepCount, 3)
  assert.equal(episodes[0].fromRevision, 1)
  assert.equal(episodes[0].toRevision, 3)
  assert.equal(episodes[0].changedPathCount, 3)
})

test('clusterEpisodes splits when the gap exceeds the threshold', () => {
  const rows = [
    row({ revision: 1, path: 'src/a.js', minute: 0 }),
    row({ revision: 2, path: 'src/b.js', minute: 45 }), // 45m > 30m default
  ]
  const episodes = clusterEpisodes(rows)
  assert.equal(episodes.length, 2)
  assert.deepEqual(episodes.map((e) => e.fromRevision), [1, 2])
})

test('clusterEpisodes treats a gap exactly at the threshold as the same episode', () => {
  const gapMs = 30 * 60 * 1000
  const atThreshold = clusterEpisodes(
    [row({ revision: 1, path: 'a', minute: 0 }), row({ revision: 2, path: 'b', minute: 30 })],
    { gapMs },
  )
  assert.equal(atThreshold.length, 1)

  const justOver = clusterEpisodes(
    [row({ revision: 1, path: 'a', minute: 0 }), row({ revision: 2, path: 'b', minute: 30, second: 1 })],
    { gapMs },
  )
  assert.equal(justOver.length, 2)
})

test('clusterEpisodes splits on a device change even within the gap window', () => {
  const rows = [
    row({ revision: 1, path: 'a', device: 'Laptop', minute: 0 }),
    row({ revision: 2, path: 'b', device: 'Desktop', minute: 1 }),
    row({ revision: 3, path: 'c', device: 'Desktop', minute: 2 }),
  ]
  const episodes = clusterEpisodes(rows)
  assert.equal(episodes.length, 2)
  assert.equal(episodes[0].deviceName, 'Laptop')
  assert.equal(episodes[0].stepCount, 1)
  assert.equal(episodes[1].deviceName, 'Desktop')
  assert.equal(episodes[1].stepCount, 2)
})

test('clusterEpisodes is deterministic regardless of input row order', () => {
  const rows = [
    row({ revision: 1, path: 'src/a.js', minute: 0 }),
    row({ revision: 2, path: 'src/b.js', minute: 5 }),
    row({ revision: 3, path: 'src/c.js', device: 'Desktop', minute: 40 }),
  ]
  const shuffled = [rows[2], rows[0], rows[1]]
  assert.deepEqual(clusterEpisodes(shuffled), clusterEpisodes(rows))
})

test('clusterEpisodes bounds samplePaths and reports the full changed count', () => {
  const rows = ['e', 'd', 'c', 'b', 'a', 'f', 'g'].map((name, i) =>
    row({ revision: 1, path: `src/${name}.js`, minute: 0, second: i }),
  )
  const [episode] = clusterEpisodes(rows, { sampleLimit: 3 })
  assert.equal(episode.changedPathCount, 7)
  assert.equal(episode.samplePaths.length, 3)
  assert.deepEqual(episode.samplePaths, ['src/a.js', 'src/b.js', 'src/c.js'])
})

test('stepsFromVersionRows collapses rows to ordered per-revision steps', () => {
  const steps = stepsFromVersionRows([
    row({ revision: 2, path: 'b', minute: 5 }),
    row({ revision: 1, path: 'a', minute: 0 }),
    row({ revision: 1, path: 'a2', minute: 0 }),
  ])
  assert.deepEqual(steps.map((s) => s.revision), [1, 2])
  assert.equal(steps[0].paths.size, 2)
})

test('clusterEpisodes ignores rows with unusable revision or timestamp', () => {
  const rows = [
    row({ revision: 1, path: 'a', minute: 0 }),
    { graphRevision: null, path: 'x', deviceName: 'Laptop', createdAt: new Date(BASE).toISOString() },
    { graphRevision: 2, path: 'y', deviceName: 'Laptop', createdAt: 'not-a-date' },
  ]
  const episodes = clusterEpisodes(rows)
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].changedPathCount, 1)
})
