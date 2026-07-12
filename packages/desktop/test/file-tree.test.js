import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { translateFileBadge, buildDirectoryListing, aggregateFolderBadge } from '../src/lib/file-tree.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realStatus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'status-hopit.json'), 'utf8'))
const realFiles = realStatus.workspace.files

test('badge translation covers the agent file states', () => {
  assert.equal(translateFileBadge({ hydrated: true, state: 'hydrated' }).label, 'On this Mac')
  assert.equal(translateFileBadge({ hydrated: false, state: 'cloud-only' }).label, 'Cloud only')
  assert.equal(translateFileBadge({ dirty: true }).label, 'Editing… syncing')
  assert.equal(translateFileBadge({ pending: true }).label, 'Syncing…')
  assert.equal(translateFileBadge({ blocked: true }).label, 'Issue')
  assert.equal(translateFileBadge(null).label, '—')
})

test('issue outranks editing which outranks plain local', () => {
  assert.equal(translateFileBadge({ blocked: true, dirty: true, hydrated: true }).code, 'issue')
  assert.equal(translateFileBadge({ dirty: true, hydrated: true }).code, 'editing')
})

test('root listing over the real files map groups top-level folders and files', () => {
  const listing = buildDirectoryListing(realFiles, { subpath: '' })
  const folderNames = listing.folders.map((folder) => folder.name)
  assert.ok(folderNames.includes('docs'))
  assert.ok(folderNames.includes('src'))
  assert.ok(folderNames.includes('convex'))
  const fileNames = listing.files.map((file) => file.name)
  assert.ok(fileNames.includes('README.md'))
  assert.ok(fileNames.includes('.gitignore'))
  // No nested paths leak into the root level.
  assert.ok(!fileNames.some((name) => name.includes('/')))
})

test('subpath listing shows only immediate children', () => {
  const listing = buildDirectoryListing(realFiles, { subpath: 'src/app' })
  const names = [...listing.folders.map((f) => f.name), ...listing.files.map((f) => f.name)]
  assert.ok(names.includes('api') || names.includes('globals.css'))
  for (const file of listing.files) {
    assert.ok(file.path.startsWith('src/app/'))
    assert.ok(!file.name.includes('/'))
  }
})

test('real hydrated files carry the On this Mac badge and byte sizes', () => {
  const listing = buildDirectoryListing(realFiles, { subpath: '' })
  const readme = listing.files.find((file) => file.name === 'README.md')
  assert.equal(readme.badge.label, 'On this Mac')
  assert.equal(typeof readme.bytesOnDisk, 'number')
})

test('folder badge aggregates: any issue wins; mixed local/cloud is honest', () => {
  assert.equal(aggregateFolderBadge({ issue: 1, local: 5, total: 6 }).code, 'issue')
  assert.equal(aggregateFolderBadge({ syncing: 1, local: 5, total: 6 }).code, 'syncing')
  const mixed = aggregateFolderBadge({ cloud: 2, local: 3, total: 5 })
  assert.equal(mixed.code, 'mixed')
  assert.equal(mixed.label, '3/5 on this Mac')
  assert.equal(aggregateFolderBadge({ cloud: 5, total: 5, local: 0 }).code, 'cloud')
  assert.equal(aggregateFolderBadge({ local: 5, total: 5 }).code, 'local')
})

test('empty and unknown subpaths return an empty listing, not a crash', () => {
  const listing = buildDirectoryListing(realFiles, { subpath: 'no/such/dir' })
  assert.equal(listing.empty, true)
  const nullListing = buildDirectoryListing(null, { subpath: '' })
  assert.equal(nullListing.empty, true)
})
