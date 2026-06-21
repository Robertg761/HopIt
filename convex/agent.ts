import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { DatabaseReader } from "./_generated/server";

declare const process: {
  env: {
    HOPIT_AGENT_TOKEN?: string;
    HOPIT_ALLOW_UNAUTHENTICATED_AGENT?: string;
  };
};

const graphValidator = v.any();
const detailValidator = v.any();

export const getGraph = query({
  args: {
    codebaseId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireAgentToken(args.token);
    return await readGraph(ctx, args.codebaseId);
  },
});

export const dashboard = query({
  args: {
    codebaseId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireAgentToken(args.token);

    const graph = await readGraph(ctx, args.codebaseId);
    if (!graph) {
      return {
        status: null,
        events: { recent: [], lastAcknowledgement: null, lastSync: null },
        cloud: { graph: null },
        error: {
          code: "convex_graph_not_found",
          message: `No HopIt codebase graph exists in Convex for ${args.codebaseId}.`,
        },
      };
    }

    const eventEntries = await ctx.db
      .query("agentEvents")
      .withIndex("by_codebase_at", (q) => q.eq("codebaseId", args.codebaseId))
      .order("desc")
      .take(20);
    const recent = eventEntries.reverse().map(mapAgentEvent);
    const [
      lastAcknowledgement,
      lastSync,
      lastStartedSync,
      lastFailedSync,
      lastRecoveredSync,
      lastRefreshStarted,
      lastRefreshBlocked,
      lastRefreshComplete,
      lastRemoteUpdate,
    ] = await Promise.all([
      readLatestEvent(ctx, args.codebaseId, "cloud.acknowledged"),
      readLatestEvent(ctx, args.codebaseId, "sync.complete"),
      readLatestEvent(ctx, args.codebaseId, "sync.started"),
      readLatestEvent(ctx, args.codebaseId, "sync.failed"),
      readLatestEvent(ctx, args.codebaseId, "sync.recovered"),
      readLatestEvent(ctx, args.codebaseId, "refresh.started"),
      readLatestEvent(ctx, args.codebaseId, "refresh.blocked"),
      readLatestEvent(ctx, args.codebaseId, "refresh.complete"),
      readLatestEvent(ctx, args.codebaseId, "remote-update"),
    ]);
    const latestSyncEvent = latestEventOf([
      lastStartedSync,
      lastSync,
      lastFailedSync,
      lastRecoveredSync,
    ]);
    const latestRefreshEvent = latestEventOf([
      lastRefreshStarted,
      lastRefreshBlocked,
      lastRefreshComplete,
    ]);

    return {
      status: buildStatus(graph, {
        recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        latestSyncEvent,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        latestRefreshEvent,
        lastRemoteUpdate,
      }),
      events: {
        recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        latestSyncEvent,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        latestRefreshEvent,
        lastRemoteUpdate,
        totalEntries: eventEntries.length,
      },
      cloud: {
        path: `convex:${args.codebaseId}`,
        service: "convex-cloud-graph",
        exists: true,
        graph,
      },
    };
  },
});

export const saveGraph = mutation({
  args: {
    graph: graphValidator,
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireAgentToken(args.token);

    validateRawGraph(args.graph);
    const graph = normalizeGraph(args.graph);
    validateGraph(graph);
    const codebaseId = graph.codebase.id;
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query("codebases")
      .withIndex("by_codebase_id", (q) => q.eq("codebaseId", codebaseId))
      .unique();
    const codebaseValue = {
      codebaseId,
      name: graph.codebase.name,
      ownerId: graph.codebase.ownerId,
      schemaVersion: graph.schemaVersion,
      revision: graph.revision,
      main: graph.main,
      selectedState: graph.selectedState,
      owner: graph.owner,
      collaborators: graph.collaborators,
      session: graph.session,
      visibility: graph.visibility,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, codebaseValue);
    } else {
      await ctx.db.insert("codebases", codebaseValue);
    }

    const existingFiles = await ctx.db
      .query("files")
      .withIndex("by_codebase", (q) => q.eq("codebaseId", codebaseId))
      .collect();
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const incomingPaths = new Set(Object.keys(graph.files));

    for (const [filePath, file] of Object.entries(graph.files)) {
      const fileValue: any = {
        codebaseId,
        path: filePath,
        content: String((file as { content?: string }).content ?? ""),
        scope: scopeForPath(filePath),
        revision:
          typeof (file as { revision?: unknown }).revision === "number"
            ? (file as { revision: number }).revision
            : graph.revision,
        updatedAt:
          typeof (file as { updatedAt?: unknown }).updatedAt === "string"
            ? (file as { updatedAt: string }).updatedAt
            : now,
      };
      if (typeof (file as { hash?: unknown }).hash === "string") {
        fileValue.hash = (file as { hash: string }).hash;
      }
      if (typeof (file as { size?: unknown }).size === "number") {
        fileValue.size = (file as { size: number }).size;
      }
      const existingFile = existingByPath.get(filePath);

      if (existingFile) {
        await ctx.db.patch(existingFile._id, fileValue);
      } else {
        await ctx.db.insert("files", fileValue);
      }
    }

    for (const file of existingFiles) {
      if (!incomingPaths.has(file.path)) {
        await ctx.db.delete(file._id);
      }
    }

    return {
      ok: true,
      codebaseId,
      revision: graph.revision,
      fileCount: incomingPaths.size,
    };
  },
});

export const appendEvent = mutation({
  args: {
    codebaseId: v.string(),
    event: v.string(),
    detail: detailValidator,
    at: v.optional(v.string()),
    source: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireAgentToken(args.token);

    const eventValue: any = {
      codebaseId: args.codebaseId,
      event: args.event,
      detail: args.detail,
      at: args.at ?? new Date().toISOString(),
    };
    if (args.source) eventValue.source = args.source;

    return await ctx.db.insert("agentEvents", eventValue);
  },
});

async function readGraph(ctx: { db: DatabaseReader }, codebaseId: string) {
  const codebase = await ctx.db
    .query("codebases")
    .withIndex("by_codebase_id", (q) => q.eq("codebaseId", codebaseId))
    .unique();

  if (!codebase) return null;

  const files = await ctx.db
    .query("files")
    .withIndex("by_codebase", (q) => q.eq("codebaseId", codebaseId))
    .collect();
  const filesByPath = Object.fromEntries(
    files.map((file) => [
      file.path,
      {
        content: file.content,
        hash: file.hash ?? null,
        size: file.size ?? file.content.length,
        scope: file.scope,
        revision: file.revision,
        updatedAt: file.updatedAt,
      },
    ]),
  );

  const graph = {
    schemaVersion: codebase.schemaVersion,
    codebase: {
      id: codebase.codebaseId,
      name: codebase.name,
      ownerId: codebase.ownerId,
    },
    main: codebase.main,
    selectedState: codebase.selectedState,
    owner: codebase.owner,
    collaborators: codebase.collaborators,
    session: codebase.session,
    visibility: codebase.visibility,
    revision: codebase.revision,
    files: filesByPath,
  };
  validateGraph(graph);
  return graph;
}

function requireAgentToken(token: string | undefined) {
  const expected = process.env.HOPIT_AGENT_TOKEN;
  if (!expected) {
    if (process.env.HOPIT_ALLOW_UNAUTHENTICATED_AGENT === "1") return;
    throw new Error("HOPIT_AGENT_TOKEN must be configured for Convex HopIt access.");
  }
  if (token !== expected) {
    throw new Error("Unauthorized HopIt agent token.");
  }
}

function normalizeGraph(graph: unknown) {
  if (!graph || typeof graph !== "object") {
    throw new Error("Expected a HopIt cloud graph object.");
  }

  const value = graph as Record<string, any>;
  value.schemaVersion ??= 2;
  value.codebase ??= {};
  value.codebase.id ??= "hopit";
  value.codebase.name ??= value.codebase.id;
  value.owner ??= {};
  value.owner.id ??= value.codebase.ownerId ?? "local-owner";
  value.codebase.ownerId ??= value.owner.id;
  value.main ??= { id: "main", revision: value.revision ?? 0 };
  value.selectedState ??= { type: "active-change-set", id: `cs_${value.codebase.id}_local` };
  value.collaborators = Array.isArray(value.collaborators) ? value.collaborators : [];
  value.session ??= { id: "session_local", deviceName: "local-device" };
  value.visibility ??= { productDefault: "private", effective: "private" };
  value.revision = Number.isInteger(value.revision) ? value.revision : 0;
  value.files = value.files && typeof value.files === "object" ? value.files : {};

  return value as {
    schemaVersion: number;
    codebase: { id: string; name: string; ownerId: string };
    main: unknown;
    selectedState: unknown;
    owner: unknown;
    collaborators: unknown[];
    session: unknown;
    visibility: unknown;
    revision: number;
    files: Record<string, unknown>;
  };
}

function validateRawGraph(graph: unknown) {
  if (!graph || typeof graph !== "object") {
    throw new Error("Expected a HopIt cloud graph object.");
  }

  const value = graph as Record<string, any>;
  if (value.files !== undefined && (!value.files || typeof value.files !== "object" || Array.isArray(value.files))) {
    throw new Error("HopIt graph files must be an object.");
  }

  for (const [filePath, file] of Object.entries(value.files ?? {})) {
    assertSafeGraphPath(filePath);
    const scope = (file as { scope?: unknown })?.scope;
    if (typeof scope === "string" && scope !== scopeForPath(filePath)) {
      throw new Error(`HopIt graph scope mismatch for ${filePath}: expected ${scopeForPath(filePath)}, got ${scope}.`);
    }
  }
}

function validateGraph(graph: ReturnType<typeof normalizeGraph>) {
  const errors: string[] = [];
  const visibilityValues = new Set(["private", "team-visible", "review-visible"]);
  const reviewStates = new Set(["not-open", "open", "merged"]);
  const mergeStates = new Set(["unmerged", "merged"]);
  const conflictStates = new Set(["none", "conflicted"]);
  const selectedState = graph.selectedState as any;
  const main = graph.main as any;
  const owner = graph.owner as any;
  const session = graph.session as any;
  const visibility = graph.visibility as any;

  if (graph.schemaVersion !== 2) errors.push("schemaVersion must be 2.");
  if (!isNonEmptyString(graph.codebase.id)) errors.push("codebase.id is required.");
  if (!isNonEmptyString(graph.codebase.name)) errors.push("codebase.name is required.");
  if (!isNonEmptyString(graph.codebase.ownerId)) errors.push("codebase.ownerId is required.");
  if (!isNonEmptyString(owner?.id)) errors.push("owner.id is required.");
  if (graph.codebase.ownerId !== owner?.id) errors.push("codebase.ownerId must match owner.id.");
  if (!isNonEmptyString(main?.id)) errors.push("main.id is required.");
  if (!Number.isInteger(main?.revision)) errors.push("main.revision must be an integer.");
  if (selectedState?.type !== "active-change-set" && selectedState?.type !== "main") {
    errors.push("selectedState.type must be active-change-set or main.");
  }
  if (!isNonEmptyString(selectedState?.id)) errors.push("selectedState.id is required.");
  if (!Number.isInteger(selectedState?.revision)) errors.push("selectedState.revision must be an integer.");
  if (!Number.isInteger(graph.revision)) errors.push("revision must be an integer.");
  if (!visibilityValues.has(visibility?.effective)) errors.push("visibility.effective is invalid.");
  if (!visibilityValues.has(selectedState?.effectiveVisibility)) errors.push("selectedState.effectiveVisibility is invalid.");
  if (!reviewStates.has(selectedState?.reviewState)) errors.push("selectedState.reviewState is invalid.");
  if (!mergeStates.has(selectedState?.mergeState)) errors.push("selectedState.mergeState is invalid.");
  if (!conflictStates.has(selectedState?.conflictState)) errors.push("selectedState.conflictState is invalid.");
  if (!isNonEmptyString(session?.id)) errors.push("session.id is required.");
  if (!isNonEmptyString(session?.deviceName)) errors.push("session.deviceName is required.");

  for (const [filePath, file] of Object.entries(graph.files)) {
    const value = file as any;
    try {
      assertSafeGraphPath(filePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (typeof value.content !== "string") errors.push(`${filePath}.content must be a string.`);
    if (value.scope !== scopeForPath(filePath)) errors.push(`${filePath}.scope must be ${scopeForPath(filePath)}.`);
    if (!Number.isInteger(value.revision)) errors.push(`${filePath}.revision must be an integer.`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid HopIt cloud graph: ${errors.join(" ")}`);
  }
}

function assertSafeGraphPath(filePath: string) {
  if (!filePath || filePath.startsWith("/") || filePath === "." || filePath.includes("\0")) {
    throw new Error(`Invalid HopIt graph path: ${filePath}`);
  }
  const parts = filePath.split("/");
  if (parts.includes("..") || parts.includes("")) {
    throw new Error(`Invalid HopIt graph path: ${filePath}`);
  }
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

function buildStatus(graph: any, events: Record<string, any>) {
  const filePaths = Object.keys(graph.files ?? {});
  const privateCount = filePaths.filter((filePath) => scopeForPath(filePath) === "owner-private").length;
  const syncHealth = buildSyncHealth(events);
  const refreshHealth = buildRefreshHealth(events);

  return {
    ok: syncHealth.state !== "failed" && refreshHealth.state !== "blocked",
    generatedAt: new Date().toISOString(),
    mode: {
      adapter: "managed-folder",
      cacheMode: "local-cache",
      sourceOfTruth: "convex",
    },
    codebaseId: graph.codebase?.id ?? null,
    codebaseName: graph.codebase?.name ?? null,
    selectedStateType: graph.selectedState?.type ?? null,
    activeChangeSetId: graph.selectedState?.type === "active-change-set" ? graph.selectedState?.id : null,
    mainId: graph.main?.id ?? null,
    ownerId: graph.owner?.id ?? graph.codebase?.ownerId ?? null,
    sessionId: graph.session?.id ?? null,
    visibleFileCount: filePaths.length,
    hiddenFileCount: 0,
    hiddenScopeCounts: { shared: 0, private: 0 },
    effectiveChangeSetVisibility: graph.selectedState?.effectiveVisibility ?? graph.visibility?.effective ?? null,
    review: {
      state: graph.selectedState?.reviewState ?? "not-open",
      detail: graph.selectedState?.review ?? null,
    },
    merge: {
      state: graph.selectedState?.mergeState ?? "unmerged",
      detail: graph.selectedState?.merge ?? null,
      mainRevision: graph.main?.revision ?? null,
    },
    conflict: {
      state: graph.selectedState?.conflictState ?? "none",
      detail: graph.selectedState?.conflict ?? null,
    },
    workspace: {
      path: "Convex cloud backend",
      exists: true,
      adapter: "managed-folder",
      cacheMode: "local-cache",
    },
    cloud: {
      path: `convex:${graph.codebase?.id ?? "unknown"}`,
      service: "convex-cloud-graph",
      exists: true,
      schemaVersion: graph.schemaVersion ?? null,
      codebase: graph.codebase ?? null,
      main: graph.main ?? null,
      selectedState: graph.selectedState ?? null,
      owner: graph.owner ?? null,
      session: graph.session ?? null,
      visibility: graph.visibility ?? null,
      revision: graph.revision ?? null,
      fileCount: filePaths.length,
      scopeCounts: { shared: filePaths.length - privateCount, private: privateCount },
    },
    journal: {
      pendingCount: 0,
      failedCount: 0,
      acknowledgedCount: 0,
    },
    sync: {
      ...syncHealth,
      lastSuccessfulAt: events.lastSync?.at ?? null,
      lastAcknowledgementAt: events.lastAcknowledgement?.at ?? null,
    },
    refresh: refreshHealth,
    remoteUpdate: {
      state: events.lastRemoteUpdate ? "updated" : "idle",
      lastUpdate: events.lastRemoteUpdate ?? null,
    },
    events,
  };
}

async function readLatestEvent(ctx: { db: DatabaseReader }, codebaseId: string, eventName: string) {
  const [event] = await ctx.db
    .query("agentEvents")
    .withIndex("by_codebase_at", (q) => q.eq("codebaseId", codebaseId))
    .filter((q) => q.eq(q.field("event"), eventName))
    .order("desc")
    .take(1);

  return event ? mapAgentEvent(event) : null;
}

function mapAgentEvent(entry: any) {
  return {
    id: entry._id,
    event: entry.event,
    type: entry.event,
    at: entry.at,
    timestamp: entry.at,
    detail: entry.detail,
    payload: entry.detail,
  };
}

function latestEventOf(events: Array<{ at?: string | null } | null>) {
  return events.reduce((latest, event) => {
    if (!event) return latest;
    if (!latest) return event;

    return eventTime(event) >= eventTime(latest) ? event : latest;
  }, null as { at?: string | null } | null);
}

function buildSyncHealth(events: Record<string, any>) {
  const latestSyncEvent = events.latestSyncEvent;
  let state = "idle";

  if (latestSyncEvent?.event === "sync.failed") {
    state = "failed";
  } else if (latestSyncEvent?.event === "sync.started") {
    state = "syncing";
  } else if (latestSyncEvent?.event === "sync.complete" || latestSyncEvent?.event === "sync.recovered") {
    state = "healthy";
  }

  return {
    state,
    lastStartedSync: events.lastStartedSync ?? null,
    lastSuccessfulSync: events.lastSync ?? null,
    lastFailedSync: events.lastFailedSync ?? null,
    lastRecoveredSync: events.lastRecoveredSync ?? null,
    latestSyncEvent: latestSyncEvent ?? null,
    lastError: state === "failed" ? (events.lastFailedSync?.detail?.reason ?? null) : null,
  };
}

function buildRefreshHealth(events: Record<string, any>) {
  const latestRefreshEvent = events.latestRefreshEvent;
  let state = "idle";

  if (latestRefreshEvent?.event === "refresh.blocked") {
    state = "blocked";
  } else if (latestRefreshEvent?.event === "refresh.started") {
    state = "refreshing";
  } else if (latestRefreshEvent?.event === "refresh.complete") {
    state = "healthy";
  }

  return {
    state,
    lastStarted: events.lastRefreshStarted ?? null,
    lastBlocked: events.lastRefreshBlocked ?? null,
    lastComplete: events.lastRefreshComplete ?? null,
    latestRefreshEvent: latestRefreshEvent ?? null,
    lastError: state === "blocked" ? (events.lastRefreshBlocked?.detail?.reason ?? null) : null,
  };
}

function eventTime(event: { at?: string | null }) {
  const time = new Date(event.at ?? "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

function scopeForPath(filePath: string) {
  return filePath === ".private" || filePath.startsWith(".private/") ? "owner-private" : "shared";
}
