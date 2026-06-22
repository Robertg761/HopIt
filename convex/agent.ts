import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { DatabaseReader } from "./_generated/server";
import type { AccessContext, AuthIdentity, Capability } from "./access";
import {
  accessSourceFromGraph,
  accessSourceFromCodebase,
  createInvitationToken,
  filterGraphForAccessContext,
  hashInvitationToken,
  isNonEmptyString,
  normalizeCodebaseRole,
  normalizeEmail,
  optionalText,
  readCodebaseAccessContext,
  readCodebaseById,
  readUserById,
  readUserByPrimaryEmail,
  requireAgentToken,
  requireCodebaseCapabilityForActor,
  requireConfiguredOwnerEmail,
  resolveReadActor,
  resolveWriteActor,
  scopeForPath,
  stringOrNull,
  summarizeAccessContext,
  summarizeAuthIdentity,
  syncGraphAccessRows,
  upsertCodebaseMember,
  upsertUserFromCurrentAuth,
  userIdFromIdentity,
} from "./access";

const graphValidator = v.any();
const detailValidator = v.any();
const invitableCodebaseRoleValidator = v.union(
  v.literal("maintainer"),
  v.literal("member"),
  v.literal("viewer"),
);
const fileMutationTypeValidator = v.union(
  v.literal("create"),
  v.literal("write"),
  v.literal("delete"),
);
const agentSessionCapabilityValidator = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("sync"),
  v.literal("watch"),
  v.literal("invite"),
  v.literal("admin"),
);
const agentSessionStatusValidator = v.union(
  v.literal("active"),
  v.literal("revoked"),
);

export const getGraph = query({
  args: {
    codebaseId: v.string(),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireAgentAccess(ctx, args.codebaseId, {
      token: args.token,
      sessionToken: args.sessionToken,
    }, "read");
    const graph = await readGraph(ctx, args.codebaseId);
    if (!graph || access.kind === "service") return graph;
    return filterGraphForAccessContext(graph, access.access);
  },
});

export const dashboard = query({
  args: {
    codebaseId: v.string(),
    token: v.optional(v.string()),
    requesterUserId: v.optional(v.string()),
    requesterSessionId: v.optional(v.string()),
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
    const access = await readCodebaseAccessContext(ctx, accessSourceFromGraph(graph), {
      userId: args.requesterUserId,
      sessionId: args.requesterSessionId,
      allowOwnerFallback: true,
    });
    const visibleGraph = filterGraphForAccessContext(graph, access);
    const visibleAccess = visibleGraph.visibilityContext as AccessContext;

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
      status: buildStatus(visibleGraph, {
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
      }, visibleAccess),
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
        graph: visibleGraph,
        access: summarizeAccessContext(visibleAccess),
      },
    };
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const userId = userIdFromIdentity(identity as AuthIdentity);
    const user = await readUserById(ctx, userId);

    return {
      identity: summarizeAuthIdentity(identity as AuthIdentity),
      user,
    };
  },
});

export const upsertViewer = mutation({
  args: {},
  handler: async (ctx) => {
    return await upsertUserFromCurrentAuth(ctx);
  },
});

export const claimCodebaseOwner = mutation({
  args: {
    codebaseId: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, undefined);
    requireConfiguredOwnerEmail(actor);

    const codebase = await readCodebaseById(ctx, args.codebaseId);
    if (!codebase) throw new Error(`Codebase ${args.codebaseId} was not found.`);

    const members = await ctx.db
      .query("codebaseMembers")
      .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
      .collect();
    const conflictingOwner = members.find(
      (member) =>
        member.role === "owner" &&
        member.status === "active" &&
        member.userId !== actor.userId &&
        !isBootstrapOwnerMember(member, codebase),
    );
    if (conflictingOwner) {
      throw new Error(`Codebase ${args.codebaseId} already has an active owner.`);
    }

    const now = new Date().toISOString();
    for (const member of members) {
      if (member.role === "owner" && member.status === "active" && member.userId !== actor.userId) {
        await ctx.db.patch(member._id, {
          status: "suspended",
          suspendedByUserId: actor.userId,
          suspendedAt: now,
          updatedAt: now,
        });
      }
    }

    await upsertCodebaseMember(ctx, {
      codebaseId: args.codebaseId,
      userId: actor.userId,
      role: "owner",
      status: "active",
      source: "owner-claim",
      joinedAt: now,
      now,
    });

    await ctx.db.patch(codebase._id, {
      ownerId: actor.userId,
      owner: claimedOwnerValue(codebase.owner, actor),
      updatedAt: now,
    });

    return {
      ok: true,
      codebaseId: args.codebaseId,
      ownerId: actor.userId,
    };
  },
});

export const listCodebaseMembers = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(v.union(v.literal("active"), v.literal("suspended"))),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "read");

    const members = await ctx.db
      .query("codebaseMembers")
      .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
      .collect();
    const visibleMembers = args.status ? members.filter((member) => member.status === args.status) : members;

    return await Promise.all(
      visibleMembers
        .sort((a, b) => roleSort(a.role) - roleSort(b.role) || a.userId.localeCompare(b.userId))
        .map(async (member) => ({
          ...member,
          profile: summarizeUser(await readUserById(ctx, member.userId)),
        })),
    );
  },
});

export const listCodebaseInvitations = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    )),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "invite");

    const invitations = await ctx.db
      .query("codebaseInvitations")
      .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
      .collect();
    const visibleInvitations = args.status
      ? invitations.filter((invitation) => invitationStatusForRead(invitation) === args.status)
      : invitations;

    return visibleInvitations
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summarizeInvitation);
  },
});

export const createCodebaseInvitation = mutation({
  args: {
    codebaseId: v.string(),
    email: v.string(),
    role: invitableCodebaseRoleValidator,
    expiresAt: v.optional(v.string()),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "invite");

    const normalizedEmail = normalizeEmail(args.email);
    if (!normalizedEmail) throw new Error("Invitation email is required.");
    const existingMember = await readActiveMemberByEmail(ctx, args.codebaseId, normalizedEmail);
    if (existingMember) {
      throw new Error(`${normalizedEmail} already has active access to ${args.codebaseId}.`);
    }

    const existingPendingInvite = await ctx.db
      .query("codebaseInvitations")
      .withIndex("by_codebase_email", (q) => q.eq("codebaseId", args.codebaseId).eq("normalizedEmail", normalizedEmail))
      .collect();
    const now = new Date().toISOString();
    await expirePendingInvitations(ctx, existingPendingInvite, now);
    if (existingPendingInvite.some(isInvitationCurrentlyPending)) {
      throw new Error(`A pending invitation already exists for ${normalizedEmail}.`);
    }

    const expiresAt = normalizeFutureTimestamp(args.expiresAt, "Invitation expiry");
    const { token, tokenHash } = await createUniqueInvitationToken(ctx);

    const invitation = {
      codebaseId: args.codebaseId,
      normalizedEmail,
      role: args.role,
      tokenHash,
      status: "pending" as const,
      invitedByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    } as any;
    if (expiresAt) invitation.expiresAt = expiresAt;

    const invitationId = await ctx.db.insert("codebaseInvitations", invitation);

    return {
      invitationId,
      codebaseId: args.codebaseId,
      normalizedEmail,
      role: args.role,
      status: "pending",
      token,
    };
  },
});

export const acceptCodebaseInvitation = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const actor = await upsertUserFromCurrentAuth(ctx);
    if (!actor.primaryEmail) throw new Error("A verified account email is required to accept an invitation.");
    if (actor.currentAuthEmailVerified !== true) {
      throw new Error("A verified account email is required to accept an invitation.");
    }

    const tokenHash = await hashInvitationToken(args.token);
    const invitation = await ctx.db
      .query("codebaseInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!invitation) throw new Error("Invitation not found.");
    if (invitation.status !== "pending") throw new Error("Invitation is no longer pending.");
    if (isInvitationExpired(invitation)) {
      await ctx.db.patch(invitation._id, {
        status: "expired",
        updatedAt: new Date().toISOString(),
      });
      throw new Error("Invitation has expired.");
    }

    if (normalizeEmail(actor.primaryEmail) !== invitation.normalizedEmail) {
      throw new Error("Authenticated account email does not match this invitation.");
    }

    const now = new Date().toISOString();
    await upsertCodebaseMember(ctx, {
      codebaseId: invitation.codebaseId,
      userId: actor.userId,
      role: normalizeCodebaseRole(invitation.role, "member"),
      status: "active",
      invitedByUserId: invitation.invitedByUserId,
      source: "invitation",
      joinedAt: now,
      now,
    });
    await ctx.db.patch(invitation._id, {
      status: "accepted",
      acceptedByUserId: actor.userId,
      acceptedAt: now,
      updatedAt: now,
    });

    return {
      codebaseId: invitation.codebaseId,
      userId: actor.userId,
      role: invitation.role,
      status: "accepted",
    };
  },
});

export const revokeCodebaseInvitation = mutation({
  args: {
    invitationId: v.id("codebaseInvitations"),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    const invitation = await requireInvitation(ctx, args.invitationId);
    await requireCodebaseCapabilityForActor(ctx, invitation.codebaseId, actor, "invite");

    if (invitation.status !== "pending") {
      throw new Error("Only pending invitations can be revoked.");
    }

    const now = new Date().toISOString();
    await ctx.db.patch(args.invitationId, {
      status: "revoked",
      revokedByUserId: actor.userId,
      revokedAt: now,
      updatedAt: now,
    });

    return summarizeInvitation(await requireInvitation(ctx, args.invitationId));
  },
});

export const suspendCodebaseMember = mutation({
  args: {
    codebaseId: v.string(),
    userId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    const { codebase } = await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "manage_members");
    const member = await requireCodebaseMember(ctx, args.codebaseId, args.userId);
    assertMutableMember(codebase, member, "suspend");

    const now = new Date().toISOString();
    await ctx.db.patch(member._id, {
      status: "suspended",
      suspendedByUserId: actor.userId,
      suspendedAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(member._id);
  },
});

export const removeCodebaseMember = mutation({
  args: {
    codebaseId: v.string(),
    userId: v.string(),
    token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    const { codebase } = await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "manage_members");
    const member = await requireCodebaseMember(ctx, args.codebaseId, args.userId);
    assertMutableMember(codebase, member, "remove");

    const now = new Date().toISOString();
    await ctx.db.patch(member._id, {
      status: "suspended",
      source: "removed",
      suspendedByUserId: actor.userId,
      suspendedAt: now,
      updatedAt: now,
    });

    return {
      ok: true,
      codebaseId: args.codebaseId,
      userId: args.userId,
      removedByUserId: actor.userId,
    };
  },
});

export const saveGraph = mutation({
  args: {
    graph: graphValidator,
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    validateRawGraph(args.graph);
    const graph = normalizeGraph(args.graph);
    validateGraph(graph);
    const codebaseId = graph.codebase.id;
    await requireAgentAccess(ctx, codebaseId, {
      token: args.token,
      sessionToken: args.sessionToken,
    }, "admin", { touch: true });
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
    await syncGraphAccessRows(ctx, graph, now);

    const existingFiles = await ctx.db
      .query("files")
      .withIndex("by_codebase", (q) => q.eq("codebaseId", codebaseId))
      .collect();
    const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const incomingPaths = new Set(Object.keys(graph.files));

    for (const [filePath, file] of Object.entries(graph.files)) {
      const content = String((file as { content?: string }).content ?? "");
      const hash = typeof (file as { hash?: unknown }).hash === "string"
        ? (file as { hash: string }).hash
        : null;
      if (hash) {
        await upsertFileBlob(ctx, codebaseId, hash, content, now);
      }
      const fileValue: any = {
        codebaseId,
        path: filePath,
        content,
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
      if (hash) {
        fileValue.hash = hash;
        fileValue.blobHash = hash;
        fileValue.contentStorage = "convex-file-blob";
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

export const applyFileMutation = mutation({
  args: {
    codebaseId: v.string(),
    type: fileMutationTypeValidator,
    path: v.string(),
    content: v.optional(v.string()),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
    baseRevision: v.optional(v.union(v.number(), v.null())),
    targetStateRevision: v.optional(v.number()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAgentAccess(ctx, args.codebaseId, {
      token: args.token,
      sessionToken: args.sessionToken,
    }, "write", { touch: true });
    assertSafeGraphPath(args.path);

    const codebase = await ctx.db
      .query("codebases")
      .withIndex("by_codebase_id", (q) => q.eq("codebaseId", args.codebaseId))
      .unique();
    if (!codebase) throw new Error(`Codebase ${args.codebaseId} was not found.`);

    const selectedState = codebase.selectedState as any;
    if (
      args.targetStateRevision !== undefined &&
      selectedState?.revision !== args.targetStateRevision
    ) {
      throw new Error(
        `selected_state_revision_mismatch: expected ${args.targetStateRevision}, got ${selectedState?.revision ?? null}`,
      );
    }

    const existingFile = await readFileByPath(ctx, args.codebaseId, args.path);
    if (args.baseRevision !== undefined) {
      const actualRevision = existingFile?.revision ?? null;
      if (args.baseRevision !== actualRevision) {
        throw new Error(`base_revision_mismatch: expected ${args.baseRevision}, got ${actualRevision}`);
      }
    }

    const now = new Date().toISOString();
    const previousRevision = codebase.revision;
    let nextRevision = previousRevision;

    if (args.type === "delete") {
      if (existingFile) {
        nextRevision += 1;
        await ctx.db.delete(existingFile._id);
      }
    } else {
      if (typeof args.content !== "string") {
        throw new Error(`File ${args.type} requires content.`);
      }
      if (!args.hash) {
        throw new Error(`File ${args.type} requires a content hash.`);
      }

      const size = args.size ?? byteLength(args.content);
      const scope = scopeForPath(args.path) as "shared" | "owner-private";
      const changed =
        !existingFile ||
        existingFile.hash !== args.hash ||
        existingFile.scope !== scope ||
        existingFile.content !== args.content;

      if (changed) {
        nextRevision += 1;
        await upsertFileBlob(ctx, args.codebaseId, args.hash, args.content, now);
        const fileValue = {
          codebaseId: args.codebaseId,
          path: args.path,
          content: args.content,
          blobHash: args.hash,
          contentStorage: "convex-file-blob",
          hash: args.hash,
          size,
          scope,
          revision: nextRevision,
          updatedAt: now,
        };

        if (existingFile) {
          await ctx.db.patch(existingFile._id, fileValue);
        } else {
          await ctx.db.insert("files", fileValue);
        }
      }
    }

    if (nextRevision !== previousRevision) {
      const nextSelectedState = selectedState && typeof selectedState === "object"
        ? {
            ...selectedState,
            revision: nextRevision,
          }
        : selectedState;
      await ctx.db.patch(codebase._id, {
        revision: nextRevision,
        selectedState: nextSelectedState,
        updatedAt: now,
      });
    }

    return {
      ok: true,
      id: `${args.codebaseId}:${args.path}:${nextRevision}`,
      codebaseId: args.codebaseId,
      type: args.type,
      path: args.path,
      scope: scopeForPath(args.path),
      revision: nextRevision,
      selectedStateType: selectedState?.type ?? null,
      selectedStateId: selectedState?.id ?? null,
      selectedStateRevision: nextRevision !== previousRevision ? nextRevision : (selectedState?.revision ?? null),
    };
  },
});

export const registerAgentSession = mutation({
  args: {
    codebaseId: v.string(),
    sessionId: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    capabilities: v.optional(v.array(agentSessionCapabilityValidator)),
    expiresAt: v.optional(v.string()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const registration = await resolveAgentSessionRegistrationActor(ctx, args);
    const now = new Date().toISOString();
    const sessionId = normalizeAgentSessionId(args.sessionId ?? createAgentSessionId());
    const deviceName = optionalText(args.deviceName);
    const expiresAt = normalizeFutureTimestamp(args.expiresAt, "Agent session expiry");
    const existing = await ctx.db
      .query("agentSessions")
      .withIndex("by_session_id", (q: any) => q.eq("sessionId", sessionId))
      .unique();

    if (existing?.status === "revoked") {
      throw new Error(`Agent session ${sessionId} is revoked and cannot be reused.`);
    }
    if (existing) {
      assertReusableAgentSession(existing, {
        codebaseId: args.codebaseId,
        userId: registration.userId,
      });
    }

    const sessionToken = await createAgentSessionToken();
    const sessionValue: any = {
      userId: registration.userId,
      sessionId,
      codebaseId: args.codebaseId,
      tokenHash: sessionToken.tokenHash,
      tokenPrefix: sessionToken.tokenPrefix,
      capabilities: normalizeAgentSessionCapabilities(args.capabilities),
      status: "active",
      lastSeenAt: now,
      updatedAt: now,
    };
    if (deviceName) sessionValue.deviceName = deviceName;
    if (expiresAt) sessionValue.expiresAt = expiresAt;

    let agentSessionId;
    if (existing) {
      await ctx.db.patch(existing._id, sessionValue);
      agentSessionId = existing._id;
    } else {
      agentSessionId = await ctx.db.insert("agentSessions", {
        ...sessionValue,
        createdAt: now,
      });
    }

    return {
      session: summarizeAgentSession(await requireAgentSessionById(ctx, agentSessionId)),
      sessionToken: sessionToken.token,
    };
  },
});

export const listAgentSessions = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(agentSessionStatusValidator),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAgentAccess(ctx, args.codebaseId, {
      token: args.token,
      sessionToken: args.sessionToken,
    }, "admin");

    const sessions = await ctx.db
      .query("agentSessions")
      .withIndex("by_codebase", (q: any) => q.eq("codebaseId", args.codebaseId))
      .collect();

    return sessions
      .filter((session) => !args.status || session.status === args.status)
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .map(summarizeAgentSession);
  },
});

export const touchAgentSession = mutation({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await requireMutableAgentSession(ctx, args);
    if (session.status !== "active") throw new Error("Only active agent sessions can be touched.");
    const now = new Date().toISOString();
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      updatedAt: now,
    });

    return summarizeAgentSession(await requireAgentSessionById(ctx, session._id));
  },
});

export const revokeAgentSession = mutation({
  args: {
    sessionId: v.string(),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await requireMutableAgentSession(ctx, args);
    const now = new Date().toISOString();
    await ctx.db.patch(session._id, {
      status: "revoked",
      revokedByUserId: await revokedByUserId(ctx, args, session),
      revokedAt: now,
      updatedAt: now,
    });

    return summarizeAgentSession(await requireAgentSessionById(ctx, session._id));
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
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAgentAccess(ctx, args.codebaseId, {
      token: args.token,
      sessionToken: args.sessionToken,
    }, "sync", { touch: true });

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

async function requireAgentAccess(
  ctx: any,
  codebaseId: string,
  credentials: { token?: string; sessionToken?: string },
  capability: string,
  options: { touch?: boolean } = {},
) {
  if (credentials.token !== undefined || !credentials.sessionToken) {
    requireAgentToken(credentials.token);
    return { kind: "service" as const, userId: "service:hopit-agent" };
  }

  const session = await requireActiveAgentSessionByToken(ctx, credentials.sessionToken, codebaseId, capability);
  const codebase = await readCodebaseById(ctx, codebaseId);
  if (!codebase) throw new Error(`Codebase ${codebaseId} was not found.`);
  const access = await readCodebaseAccessContext(ctx, accessSourceFromCodebase(codebase), {
    userId: session.userId,
    sessionId: session.sessionId,
  });
  const requiredCapability = codebaseCapabilityForAgentCapability(capability);
  if (requiredCapability && !access.permissions.includes(requiredCapability)) {
    throw new Error(`Agent session user ${session.userId} does not have ${requiredCapability} access to ${codebaseId}.`);
  }

  if (options.touch) {
    const now = new Date().toISOString();
    await ctx.db.patch(session._id, {
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  return { kind: "agent-session" as const, userId: session.userId, session, access };
}

function codebaseCapabilityForAgentCapability(capability: string): Capability | null {
  if (capability === "sync" || capability === "watch") return "read";
  if (capability === "admin") return "manage_members";
  if (
    capability === "read" ||
    capability === "write" ||
    capability === "invite" ||
    capability === "review" ||
    capability === "merge" ||
    capability === "release"
  ) {
    return capability;
  }
  return null;
}

async function resolveAgentSessionRegistrationActor(ctx: any, args: any) {
  if (args.sessionToken && args.token === undefined) {
    const access = await requireAgentAccess(ctx, args.codebaseId, {
      sessionToken: args.sessionToken,
    }, "admin", { touch: true });
    return {
      userId: access.userId,
    };
  }

  const actor = await resolveWriteActor(ctx, args.token);
  const { codebase } = await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "manage_members");
  return {
    userId: actor.kind === "service" ? codebase.ownerId : actor.userId,
  };
}

async function requireActiveAgentSessionByToken(
  ctx: any,
  token: string,
  codebaseId: string | null,
  capability: string,
) {
  const tokenHash = await hashAgentSessionToken(token);
  const session = await ctx.db
    .query("agentSessions")
    .withIndex("by_token_hash", (q: any) => q.eq("tokenHash", tokenHash))
    .unique();

  if (!session) throw new Error("Agent session token was not found.");
  if (session.status !== "active") throw new Error("Agent session is not active.");
  if (session.expiresAt && isExpiredTimestamp(session.expiresAt)) {
    throw new Error("Agent session token has expired.");
  }
  if (codebaseId && session.codebaseId !== codebaseId) {
    throw new Error(`Agent session is not scoped to codebase ${codebaseId}.`);
  }
  if (!agentSessionHasCapability(session, capability)) {
    throw new Error(`Agent session does not have ${capability} capability.`);
  }

  return session;
}

async function requireMutableAgentSession(ctx: any, args: any) {
  const session = await ctx.db
    .query("agentSessions")
    .withIndex("by_session_id", (q: any) => q.eq("sessionId", args.sessionId))
    .unique();
  if (!session) throw new Error(`Agent session ${args.sessionId} was not found.`);

  if (args.sessionToken && args.token === undefined) {
    const tokenSession = await requireActiveAgentSessionByToken(
      ctx,
      args.sessionToken,
      session.codebaseId ?? null,
      "read",
    );
    if (tokenSession.sessionId === session.sessionId) return session;
    if (!agentSessionHasCapability(tokenSession, "admin")) {
      throw new Error("Agent session token can only modify itself unless it has admin capability.");
    }
    if (!session.codebaseId) {
      throw new Error("Agent session token cannot manage unscoped sessions.");
    }
    await requireAgentAccess(ctx, session.codebaseId, { sessionToken: args.sessionToken }, "admin");
    return session;
  }

  const actor = await resolveWriteActor(ctx, args.token);
  if (actor.kind === "service") return session;
  if (actor.userId === session.userId) return session;
  if (session.codebaseId) {
    await requireCodebaseCapabilityForActor(ctx, session.codebaseId, actor, "manage_members");
    return session;
  }

  throw new Error(`User ${actor.userId} cannot modify agent session ${session.sessionId}.`);
}

async function revokedByUserId(ctx: any, args: any, session: any) {
  if (args.sessionToken && args.token === undefined) {
    const tokenSession = await requireActiveAgentSessionByToken(
      ctx,
      args.sessionToken,
      session.codebaseId ?? null,
      "read",
    );
    return tokenSession.userId;
  }

  const actor = await resolveWriteActor(ctx, args.token);
  return actor.userId;
}

async function requireAgentSessionById(ctx: any, id: string) {
  const session = await ctx.db.get(id);
  if (!session) throw new Error("Agent session was not found.");
  return session;
}

function summarizeAgentSession(session: any) {
  const { tokenHash, ...safeSession } = session;
  return safeSession;
}

function normalizeAgentSessionCapabilities(capabilities: string[] | undefined) {
  const values = capabilities && capabilities.length > 0
    ? capabilities
    : ["read", "write", "sync", "watch"];
  return Array.from(new Set(values)).sort();
}

function agentSessionHasCapability(session: any, capability: string) {
  const capabilities = Array.isArray(session.capabilities) ? session.capabilities : [];
  return capabilities.includes("admin") || capabilities.includes(capability);
}

async function createAgentSessionToken() {
  const token = `hst_${randomBase64Url(32)}`;
  return {
    token,
    tokenHash: await hashAgentSessionToken(token),
    tokenPrefix: token.slice(0, 12),
  };
}

function createAgentSessionId() {
  return `as_${randomBase64Url(12)}`;
}

async function hashAgentSessionToken(token: string) {
  const normalized = token.trim();
  if (!normalized) throw new Error("Agent session token is required.");
  if (!normalized.startsWith("hst_")) throw new Error("Agent session token has an invalid format.");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hopit.agent-session.v1:${normalized}`),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

function randomBase64Url(byteCount: number) {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createUniqueInvitationToken(ctx: any) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = await createInvitationToken();
    const existingToken = await ctx.db
      .query("codebaseInvitations")
      .withIndex("by_token_hash", (q: any) => q.eq("tokenHash", token.tokenHash))
      .unique();
    if (!existingToken) return token;
  }

  throw new Error("Could not allocate a unique invitation token.");
}

async function requireInvitation(ctx: any, invitationId: string) {
  const invitation = await ctx.db.get(invitationId);
  if (!invitation) throw new Error("Invitation not found.");
  return invitation;
}

async function requireCodebaseMember(ctx: any, codebaseId: string, userId: string) {
  const member = await ctx.db
    .query("codebaseMembers")
    .withIndex("by_codebase_user", (q: any) => q.eq("codebaseId", codebaseId).eq("userId", userId))
    .unique();
  if (!member) throw new Error(`Member ${userId} was not found for ${codebaseId}.`);
  return member;
}

function assertMutableMember(codebase: any, member: any, action: "remove" | "suspend") {
  if (member.role === "owner" || member.userId === codebase.ownerId) {
    throw new Error(`Codebase owners cannot be ${action}d through member management.`);
  }
}

async function readActiveMemberByEmail(ctx: any, codebaseId: string, normalizedEmail: string) {
  const user = await readUserByPrimaryEmail(ctx, normalizedEmail);
  if (!user) return null;

  const member = await ctx.db
    .query("codebaseMembers")
    .withIndex("by_codebase_user", (q: any) => q.eq("codebaseId", codebaseId).eq("userId", user.userId))
    .unique();
  return member?.status === "active" ? member : null;
}

function assertReusableAgentSession(
  existing: any,
  registration: { codebaseId: string; userId: string },
) {
  if (existing.userId !== registration.userId) {
    throw new Error(`Agent session ${existing.sessionId} belongs to a different user.`);
  }
  if (existing.codebaseId !== registration.codebaseId) {
    throw new Error(`Agent session ${existing.sessionId} is scoped to a different codebase.`);
  }
}

function summarizeInvitation(invitation: any) {
  const { tokenHash, ...safeInvitation } = invitation;
  return {
    ...safeInvitation,
    status: invitationStatusForRead(invitation),
  };
}

function summarizeUser(user: any) {
  if (!user) return null;
  return {
    userId: user.userId,
    primaryEmail: user.primaryEmail ?? null,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

function roleSort(role: string) {
  if (role === "owner") return 0;
  if (role === "maintainer") return 1;
  if (role === "member") return 2;
  if (role === "viewer") return 3;
  return 4;
}

function isBootstrapOwnerMember(member: any, codebase: any) {
  if (member.userId === "local-owner") return true;
  return member.source === "graph-owner" && member.userId === codebase.ownerId;
}

function claimedOwnerValue(existingOwner: any, actor: any) {
  const owner =
    existingOwner && typeof existingOwner === "object" && !Array.isArray(existingOwner)
      ? { ...existingOwner }
      : {};
  owner.id = actor.userId;
  if (stringOrNull(actor.displayName)) owner.name = actor.displayName;
  if (stringOrNull(actor.primaryEmail)) owner.email = actor.primaryEmail;
  return owner;
}

async function expirePendingInvitations(ctx: any, invitations: any[], now: string) {
  await Promise.all(
    invitations
      .filter(isInvitationExpired)
      .map((invitation) =>
        ctx.db.patch(invitation._id, {
          status: "expired",
          updatedAt: now,
        }),
      ),
  );
}

function isInvitationCurrentlyPending(invitation: any) {
  return invitation.status === "pending" && !isInvitationExpired(invitation);
}

function isInvitationExpired(invitation: any) {
  if (invitation.status !== "pending") return false;
  if (!invitation.expiresAt) return false;

  return isExpiredTimestamp(invitation.expiresAt);
}

function invitationStatusForRead(invitation: any) {
  return isInvitationExpired(invitation) ? "expired" : invitation.status;
}

function normalizeFutureTimestamp(value: string | undefined, label: string) {
  const text = optionalText(value);
  if (!text) return undefined;

  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp.`);
  if (time <= Date.now()) throw new Error(`${label} must be in the future.`);
  return new Date(time).toISOString();
}

function isExpiredTimestamp(value: string) {
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function normalizeAgentSessionId(value: string) {
  const sessionId = optionalText(value);
  if (!sessionId) throw new Error("Agent session id is required.");
  if (!/^[A-Za-z0-9_.:-]{3,160}$/.test(sessionId)) {
    throw new Error("Agent session id may only contain letters, numbers, dots, underscores, colons, and dashes.");
  }
  return sessionId;
}

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
        blobHash: file.blobHash ?? file.hash ?? null,
        contentStorage: file.contentStorage ?? "inline",
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

async function readFileByPath(ctx: any, codebaseId: string, filePath: string) {
  return await ctx.db
    .query("files")
    .withIndex("by_codebase_path", (q: any) => q.eq("codebaseId", codebaseId).eq("path", filePath))
    .unique();
}

async function upsertFileBlob(ctx: any, codebaseId: string, hash: string, content: string, now: string) {
  const size = byteLength(content);
  const existingBlob = await ctx.db
    .query("fileBlobs")
    .withIndex("by_codebase_hash", (q: any) => q.eq("codebaseId", codebaseId).eq("hash", hash))
    .unique();

  if (existingBlob) {
    if (existingBlob.content !== content || existingBlob.size !== size) {
      throw new Error(`content_hash_collision: existing blob content differs for ${hash}.`);
    }
    return existingBlob._id;
  }

  return await ctx.db.insert("fileBlobs", {
    codebaseId,
    hash,
    content,
    size,
    createdAt: now,
  });
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
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

function buildStatus(graph: any, events: Record<string, any>, access: AccessContext | null = null) {
  const filePaths = Object.keys(graph.files ?? {});
  const privateCount = filePaths.filter((filePath) => scopeForPath(filePath) === "owner-private").length;
  const syncHealth = buildSyncHealth(events);
  const refreshHealth = buildRefreshHealth(events);
  const visibilityContext = (graph.visibilityContext ?? access) as AccessContext | null;
  const accessSummary = summarizeAccessContext(visibilityContext);

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
    requesterId: accessSummary?.id ?? null,
    requesterSessionId: accessSummary?.sessionId ?? null,
    requesterRole: accessSummary?.role ?? null,
    access: accessSummary,
    visibleFileCount: accessSummary?.visibleFileCount ?? filePaths.length,
    hiddenFileCount: accessSummary?.hiddenFileCount ?? 0,
    hiddenScopeCounts: accessSummary?.hiddenScopeCounts ?? { shared: 0, private: 0 },
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
      requester: accessSummary,
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
