import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { NextResponse } from 'next/server'

const RELEASE_BASE_URL = 'https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev'
const TARGETS = new Set(['macos', 'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
const LOCAL_DMG_PATH = path.join(process.cwd(), 'artifacts', 'HopIt-macOS.dmg')

export const runtime = 'nodejs'

type ReleaseManifest = {
  version?: unknown
  targets?: Record<string, { key?: unknown }>
  downloads?: { macos?: { key?: unknown } }
}

export async function GET(request: Request, { params }: { params: Promise<{ target: string }> }) {
  const { target } = await params
  if (!TARGETS.has(target)) {
    return NextResponse.json({ error: 'Unsupported HopIt download target.' }, { status: 404 })
  }

  const format = new URL(request.url).searchParams.get('format')
  const wantsDmg = target === 'macos' || format === 'dmg'
  if (wantsDmg) {
    const local = await localDmgResponse()
    if (local) return local
  }

  try {
    const response = await fetch(`${RELEASE_BASE_URL}/latest/manifest.json`, {
      next: { revalidate: 300 },
    })
    if (!response.ok) throw new Error(`Release manifest returned ${response.status}.`)

    const manifest = await response.json() as ReleaseManifest
    const key = downloadKey(manifest, target, wantsDmg ? 'dmg' : 'archive')
    if (!key) {
      throw new Error(wantsDmg
        ? 'The macOS disk image has not been published yet.'
        : 'Release manifest does not contain a safe target archive.')
    }

    const redirect = NextResponse.redirect(`${RELEASE_BASE_URL}/${key}`, 307)
    redirect.headers.set('Cache-Control', 'public, max-age=300, must-revalidate')
    return redirect
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'HopIt download is temporarily unavailable.',
    }, { status: 503 })
  }
}

export function downloadKey(manifest: ReleaseManifest, target: string, format: 'dmg' | 'archive') {
  if (format === 'dmg') {
    const dmgKey = manifest.downloads?.macos?.key
    if (typeof dmgKey !== 'string') return null
    return /^(?:latest|releases\/[A-Za-z0-9._+-]+)\/HopIt-macOS\.dmg$/.test(dmgKey) ? dmgKey : null
  }

  const archiveName = `hop-${target}.tar.gz`
  const manifestKey = manifest.targets?.[target]?.key
  if (typeof manifestKey === 'string') {
    const safeKey = new RegExp(`^(?:latest|releases/[A-Za-z0-9._+-]+)/${archiveName.replaceAll('.', '\\.')}$`)
    if (safeKey.test(manifestKey)) return manifestKey
  }

  if (typeof manifest.version !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(manifest.version)) return null
  return `releases/${manifest.version}/${archiveName}`
}

async function localDmgResponse() {
  try {
    const stat = await fs.stat(LOCAL_DMG_PATH)
    if (!stat.isFile()) return null
    const stream = Readable.toWeb(createReadStream(LOCAL_DMG_PATH)) as ReadableStream<Uint8Array>
    return new NextResponse(stream, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="HopIt-macOS.dmg"',
        'Content-Length': String(stat.size),
        'Content-Type': 'application/x-apple-diskimage',
      },
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}
