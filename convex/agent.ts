import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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

    const events = await ctx.db
      .query("agentEvents")
      .withIndex("by_codebase_at", (q) => q.eq("codebaseId", args.codebaseId))
      .order("desc")
      .take(20);
    const recent = events.reverse().map((entry) => ({
      id: entry._id,
      event: entry.event,
      type: entry.event,
      at: entry.at,
      timestamp: entry.at,
      detail: entry.detail,
      payload: entry.detail,
    }));
    const lastAcknowledgement = findLastEvent(recent, "cloud.acknowledged");
    const lastSync = findLastEvent(recent, "sync.complete");
    const lastStartedSync = findLastEvent(recent, "sync.started");
    const lastFailedSync = findLastEvent(recent, "sync.failed");
    const lastRecoveredSync = findLastEvent(recent, "sync.recovered");
    const lastRefreshStarted = findLastEvent(recent, "refresh.started");
    const lastRefreshBlocked = findLastEvent(recent, "refresh.blocked");
    const lastRefreshComplete = findLastEvent(recent, "refresh.complete");
    const lastRemoteUpdate = findLastEvent(recent, "remote-update");

    return {
      status: buildStatus(graph, {
        recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        lastRemoteUpdate,
      }),
      events: {
        recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        lastRemoteUpdate,
        totalEntries: events.length,
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

    const graph = normalizeGraph(args.graph);
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

async function readGraph(ctx: any, codebaseId: string) {
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

  return {
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
}

function requireAgentToken(token: string | undefined) {
  const expected = process.env.HOPIT_AGENT_TOKEN;
  if (expected && token !== expected) {
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

function buildStatus(graph: any, events: Record<string, any>) {
  const filePaths = Object.keys(graph.files ?? {});
  const privateCount = filePaths.filter((filePath) => scopeForPath(filePath) === "owner-private").length;
  const lastSync = events.lastSync;
  const lastFailedSync = events.lastFailedSync;
  const lastRefreshBlocked = events.lastRefreshBlocked;

  return {
    ok: !lastFailedSync && !lastRefreshBlocked,
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
      state: lastFailedSync ? "failed" : lastSync ? "healthy" : "idle",
      lastSuccessfulAt: lastSync?.at ?? null,
      lastAcknowledgementAt: events.lastAcknowledgement?.at ?? null,
    },
    refresh: {
      state: lastRefreshBlocked ? "blocked" : events.lastRefreshComplete ? "healthy" : "idle",
    },
    remoteUpdate: {
      state: events.lastRemoteUpdate ? "updated" : "idle",
      lastUpdate: events.lastRemoteUpdate ?? null,
    },
    events,
  };
}

function findLastEvent(events: Array<{ event?: string }>, eventName: string) {
  return events.findLast((entry) => entry.event === eventName) ?? null;
}

function scopeForPath(filePath: string) {
  return filePath === ".private" || filePath.startsWith(".private/") ? "owner-private" : "shared";
}
