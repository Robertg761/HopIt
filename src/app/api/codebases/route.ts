import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import {
  createCloudCodebase,
  deleteCloudCodebase,
  listCloudCodebases,
  missingCloudBackendConfig,
  updateCloudCodebase,
  type CloudActor,
} from '@/lib/cloud-backend'
import { readLocalWorkspaceDiscovery } from '@/lib/local-workspace-discovery'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const unavailable = await unavailableReason(request, { allowBasicFallback: true })
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request, { allowBasicFallback: true })
    const codebases = await listCloudCodebases(actor)
    const localDiscovery = await readLocalWorkspaceDiscovery()
    const mergedCodebases = mergeLocalWorkspaceDiscovery(
      Array.isArray(codebases) ? codebases : [],
      localDiscovery,
    )
    return NextResponse.json({
      ok: true,
      codebases: mergedCodebases,
      workspaceDiscovery: summarizeLocalWorkspaceDiscovery(localDiscovery),
    }, responseInit())
  } catch (error) {
    return codebaseError('codebase_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    const codebase = await createCloudCodebase({
      name: requireText(body.name, 'name'),
      codebaseId: optionalText(body.codebaseId),
      description: optionalText(body.description),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebase,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    const codebase = await updateCloudCodebase({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      name: optionalText(body.name),
      visibility: visibilityValue(body.visibility),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebase,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_update_failed', errorMessage(error), 400)
  }
}

export async function DELETE(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    await deleteCloudCodebase({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_delete_failed', errorMessage(error), 400)
  }
}

async function unavailableReason(request: Request, { allowBasicFallback = false } = {}) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for codebases. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }

  if (hasValidBasicAuthFallbackCredentials(request.headers)) {
    return allowBasicFallback
      ? null
      : {
          code: 'browser_auth_required',
          message: 'Managing codebases requires product auth.',
          status: 401,
        }
  }

  const { userId } = await auth()
  if (!userId) {
    return {
      code: 'browser_auth_required',
      message: 'Managing codebases requires product auth.',
      status: 401,
    }
  }

  return null
}

async function requireActor(request: Request, { allowBasicFallback = false } = {}): Promise<CloudActor> {
  if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
  const { userId } = await auth()
  if (!userId) throw new Error('Product auth is required.')
  return { userId }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return recordValue(body) ?? {}
}

function requireText(value: unknown, label: string) {
  const text = optionalText(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function visibilityValue(value: unknown) {
  if (value === 'private' || value === 'team-visible' || value === 'review-visible') return value
  return undefined
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function responseInit() {
  return {
    headers: {
      'Cache-Control': 'no-store',
    },
  }
}

function mergeLocalWorkspaceDiscovery(cloudCodebases: unknown[], localDiscovery: unknown) {
  const discovery = recordValue(localDiscovery)
  const localCodebases = Array.isArray(discovery?.codebases)
    ? discovery.codebases.map(localWorkspaceCodebaseRow).filter(Boolean)
    : []
  const localById = new Map(
    localCodebases
      .map((codebase) => [codebase?.codebase?.id, codebase] as const)
      .filter((entry): entry is [string, NonNullable<ReturnType<typeof localWorkspaceCodebaseRow>>] => Boolean(entry[0] && entry[1])),
  )

  const merged = cloudCodebases.map((codebase) => {
    const cloudRow = recordValue(codebase) ?? {}
    const cloudCodebase = recordValue(cloudRow.codebase)
    const id = optionalText(cloudCodebase?.id) ?? optionalText(cloudRow.id)
    if (!id) return codebase
    const local = localById.get(id)
    if (!local) return codebase

    localById.delete(id)
    return {
      ...cloudRow,
      ...local,
      codebase: {
        ...recordValue(local.codebase),
        ...cloudCodebase,
      },
      selectedState: local.selectedState ?? cloudRow.selectedState ?? null,
      access: local.access ?? cloudRow.access ?? null,
      revision: local.revision ?? cloudRow.revision ?? null,
      fileCount: local.fileCount || numberValue(cloudRow.fileCount) || 0,
      privateFileCount: local.privateFileCount ?? numberValue(cloudRow.privateFileCount) ?? 0,
      memberCount: Math.max(local.memberCount ?? 0, numberValue(cloudRow.memberCount) ?? 0),
    }
  })

  for (const local of localById.values()) {
    if (local) merged.push(local)
  }

  return merged
}

function localWorkspaceCodebaseRow(value: unknown) {
  const row = recordValue(value)
  if (!row) return null

  const id = optionalText(row.id) ?? optionalText(recordValue(row.codebase)?.id)
  if (!id) return null

  const selectedState = recordValue(row.selectedState)
  const workspace = recordValue(row.workspace)
  const hydration = recordValue(workspace?.hydration) ?? recordValue(row.hydration)
  const remoteCursor = recordValue(row.remoteCursor)

  return {
    codebase: {
      id,
      name: optionalText(row.name) ?? id,
      ownerId: optionalText(row.ownerId) ?? optionalText(recordValue(row.codebase)?.ownerId),
    },
    selectedState: {
      id: optionalText(selectedState?.id) ?? optionalText(row.activeChangeSetId),
      revision: numberValue(selectedState?.revision) ?? numberValue(remoteCursor?.selectedStateRevision),
      effectiveVisibility: optionalText(selectedState?.effectiveVisibility) ?? optionalText(selectedState?.visibility),
      reviewState: optionalText(selectedState?.reviewState),
      mergeState: optionalText(selectedState?.mergeState),
      conflictState: optionalText(selectedState?.conflictState),
    },
    access: recordValue(row.access),
    workspace: {
      ...workspace,
      hydration,
    },
    remoteUpdate: recordValue(row.remoteUpdate),
    revision: numberValue(row.revision) ?? numberValue(remoteCursor?.graphRevision),
    updatedAt: optionalText(row.updatedAt),
    fileCount: numberValue(row.visibleFileCount) ?? numberValue(row.fileCount) ?? 0,
    privateFileCount: numberValue(row.privateFileCount) ?? numberValue(row.hiddenFileCount) ?? 0,
    memberCount: numberValue(row.memberCount) ?? 0,
    materialization: optionalText(row.materialization),
    attached: row.attached === true,
    available: row.available === true,
    source: optionalText(row.source),
  }
}

function summarizeLocalWorkspaceDiscovery(value: unknown) {
  const discovery = recordValue(value)
  if (!discovery) return null
  const root = recordValue(discovery.root)
  const cloud = recordValue(discovery.cloud)
  return {
    ok: discovery.ok === true,
    root: root
      ? {
          path: optionalText(root.path),
          exists: root.exists === true,
          index: recordValue(root.index),
        }
      : null,
    cloud: cloud
      ? {
          service: optionalText(cloud.service),
          discovery: optionalText(cloud.discovery),
          error: optionalText(cloud.error),
        }
      : null,
    error: optionalText(discovery.error),
  }
}

function codebaseError(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, error: { code, message }, codebases: [] }, { status, ...responseInit() })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Codebase request failed.'
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
