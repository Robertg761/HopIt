#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.resolve(__dirname, '../fixtures/demo-cloud.json')

const defaultOptions = {
  cloud: '.hopit-agent/cloud.json',
  workspace: 'mounts/hopit-core',
  journal: '.hopit-agent/journal.ndjson',
  events: '.hopit-agent/events.ndjson',
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2)
  const options = parseOptions(args)

  if (command === 'init') {
    await initCloud(options)
    return
  }

  if (command === 'hydrate') {
    await hydrateWorkspace(options)
    return
  }

  if (command === 'sync-once') {
    await syncOnce(options)
    return
  }

  if (command === 'watch') {
    await watchWorkspace(options)
    return
  }

  if (command === 'demo') {
    await runDemo(options)
    return
  }

  printHelp()
}

function parseOptions(args) {
  const options = { ...defaultOptions }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    if (key === 'force') {
      options.force = true
      continue
    }

    const value = args[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    options[key] = value
    i += 1
  }

  return options
}

async function initCloud(options) {
  if (existsSync(options.cloud) && !options.force) {
    await emit(options, 'cloud.exists', { cloud: options.cloud })
    return
  }

  const fixture = await readJson(fixturePath)
  await writeJson(options.cloud, withComputedMetadata(fixture))
  await emit(options, 'cloud.initialized', {
    cloud: options.cloud,
    files: Object.keys(fixture.files).length,
  })
}

async function hydrateWorkspace(options) {
  const cloud = await readJson(options.cloud)
  await fs.mkdir(options.workspace, { recursive: true })

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const absolutePath = path.join(options.workspace, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, file.content, 'utf8')
    await emit(options, 'file.hydrated', {
      path: relativePath,
      bytes: Buffer.byteLength(file.content),
      revision: file.revision,
    })
  }

  await emit(options, 'workspace.ready', {
    workspace: options.workspace,
    revision: cloud.revision,
  })
}

async function syncOnce(options) {
  const cloud = await readJson(options.cloud)
  const diskFiles = await readWorkspaceFiles(options.workspace)
  const cloudPaths = new Set(Object.keys(cloud.files))
  const writeEvents = []
  const now = new Date().toISOString()

  for (const [relativePath, content] of Object.entries(diskFiles)) {
    const nextHash = hashContent(content)
    const current = cloud.files[relativePath]
    cloudPaths.delete(relativePath)

    if (current?.hash === nextHash) continue

    const entry = {
      id: randomUUID(),
      type: current ? 'write' : 'create',
      path: relativePath,
      hash: nextHash,
      bytes: Buffer.byteLength(content),
      createdAt: now,
      status: 'pending',
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    cloud.revision += 1
    cloud.files[relativePath] = {
      content,
      hash: nextHash,
      size: Buffer.byteLength(content),
      revision: cloud.revision,
      updatedAt: now,
    }

    await emit(options, 'cloud.acknowledged', {
      id: entry.id,
      type: entry.type,
      path: relativePath,
      revision: cloud.revision,
    })

    writeEvents.push(entry)
  }

  for (const relativePath of cloudPaths) {
    const entry = {
      id: randomUUID(),
      type: 'delete',
      path: relativePath,
      createdAt: now,
      status: 'pending',
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    cloud.revision += 1
    delete cloud.files[relativePath]

    await emit(options, 'cloud.acknowledged', {
      id: entry.id,
      type: entry.type,
      path: relativePath,
      revision: cloud.revision,
    })

    writeEvents.push(entry)
  }

  await writeJson(options.cloud, cloud)
  await emit(options, 'sync.complete', {
    writes: writeEvents.length,
    revision: cloud.revision,
  })
}

async function watchWorkspace(options) {
  if (!existsSync(options.cloud)) await initCloud(options)
  await hydrateWorkspace(options)
  await emit(options, 'watch.started', { workspace: options.workspace })

  let timer
  const scheduleSync = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      syncOnce(options).catch((error) => {
        console.error(error)
      })
    }, 250)
  }

  watch(options.workspace, { recursive: true }, scheduleSync)
  console.log(`HopIt agent watching ${options.workspace}`)
  console.log('Press Ctrl+C to stop.')
}

async function runDemo(options) {
  const demoOptions = {
    ...options,
    cloud: options.cloud === defaultOptions.cloud ? '.hopit-agent/demo/cloud.json' : options.cloud,
    workspace: options.workspace === defaultOptions.workspace ? 'mounts/demo-hopit-core' : options.workspace,
    journal: options.journal === defaultOptions.journal ? '.hopit-agent/demo/journal.ndjson' : options.journal,
    events: options.events === defaultOptions.events ? '.hopit-agent/demo/events.ndjson' : options.events,
    force: true,
  }

  await initCloud(demoOptions)
  await hydrateWorkspace(demoOptions)

  const readmePath = path.join(demoOptions.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nEdited through the HopIt mounted workspace spike.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: 'README.md' })

  await syncOnce(demoOptions)

  const cloud = await readJson(demoOptions.cloud)
  const saved = cloud.files['README.md']?.content.includes('mounted workspace spike')

  await emit(demoOptions, 'demo.verified', {
    cloud: demoOptions.cloud,
    workspace: demoOptions.workspace,
    journal: demoOptions.journal,
    saved,
  })

  if (!saved) {
    throw new Error('Demo verification failed: cloud README did not receive the edit.')
  }
}

async function readWorkspaceFiles(root) {
  const result = {}

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const relativePath = toCloudPath(path.relative(root, absolutePath))
      result[relativePath] = await fs.readFile(absolutePath, 'utf8')
    }
  }

  await walk(root)
  return result
}

function withComputedMetadata(cloud) {
  const next = structuredClone(cloud)
  for (const file of Object.values(next.files)) {
    file.hash = hashContent(file.content)
    file.size = Buffer.byteLength(file.content)
  }
  return next
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function toCloudPath(value) {
  return value.split(path.sep).join('/')
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function appendNdjson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

async function emit(options, event, detail) {
  const payload = {
    event,
    detail,
    at: new Date().toISOString(),
  }
  await appendNdjson(options.events, payload)
  console.log(`${event} ${JSON.stringify(detail)}`)
}

function printHelp() {
  console.log(`HopIt agent spike

Commands:
  init        Seed a local cloud file graph
  hydrate     Materialize cloud files into the managed workspace
  sync-once   Scan workspace writes, journal them, and acknowledge to cloud
  watch       Hydrate and watch the workspace for edits
  demo        Run init, hydrate, edit, sync, and verify

Options:
  --cloud <path>      Cloud graph JSON path
  --workspace <path>  Managed workspace path
  --journal <path>    Pending write journal path
  --events <path>     Event log path
  --force             Overwrite the cloud graph on init
`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
