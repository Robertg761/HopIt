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
const fileEntryKindValidator = v.union(
  v.literal("file"),
  v.literal("symlink"),
  v.literal("directory"),
);
const fileEntryEncodingValidator = v.union(v.literal("utf8"), v.literal("base64"));
const privacyZoneKindValidator = v.union(
  v.literal("repo-content"),
  v.literal("owner-private"),
  v.literal("secrets"),
  v.literal("git-internals"),
  v.literal("public-snapshot"),
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
const deviceKeyStatusValidator = v.union(
  v.literal("pending"),
  v.literal("trusted"),
  v.literal("revoked"),
  v.literal("lost"),
);
const wrappedKeyTypeValidator = v.union(
  v.literal("user-vault"),
  v.literal("repo-content"),
  v.literal("owner-private"),
  v.literal("git-internals"),
  v.literal("secret-group"),
  v.literal("file-dek"),
);
const wrappedKeyRecipientTypeValidator = v.union(
  v.literal("device"),
  v.literal("user"),
  v.literal("recovery"),
);
const wrappedKeyStatusValidator = v.union(
  v.literal("active"),
  v.literal("revoked"),
  v.literal("expired"),
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

export const getGraphHead = query({
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
    const codebase = await readCodebaseById(ctx, args.codebaseId);
    if (!codebase) return null;
    return summarizeCodebaseHead(codebase, access.kind === "service" ? null : access.access);
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
      const normalizedFile = normalizeFileEntryForStorage(filePath, file, graph.revision, now);
      const content = normalizedFile.content;
      const hash = normalizedFile.hash ?? null;
      if (hash && normalizedFile.kind !== "directory" && normalizedFile.contentStorage !== "object-blob") {
        await upsertFileBlob(ctx, codebaseId, hash, content, normalizedFile.encoding, normalizedFile.size, now);
      }
      const fileValue: any = {
        codebaseId,
        path: filePath,
        ...normalizedFile,
        privacyZone: privacyZoneForPath(filePath),
        zoneId: zoneIdForPath(codebaseId, filePath),
      };
      if (hash && normalizedFile.kind !== "directory") {
        fileValue.hash = hash;
        fileValue.blobHash = hash;
        fileValue.contentStorage = normalizedFile.contentStorage === "object-blob"
          ? "object-blob"
          : normalizedFile.encoding === "base64"
            ? "convex-file-blob-base64"
            : "convex-file-blob";
        if (normalizedFile.contentStorage === "object-blob") {
          fileValue.blobProvider = normalizedFile.blobProvider;
          fileValue.blobKey = normalizedFile.blobKey;
          fileValue.blobHash = normalizedFile.blobHash ?? hash;
          fileValue.blobSize = normalizedFile.blobSize ?? normalizedFile.size ?? null;
          fileValue.clientEncryption = normalizedFile.clientEncryption ?? null;
          fileValue.encryption = normalizedFile.encryption ?? null;
        }
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
    kind: v.optional(fileEntryKindValidator),
    content: v.optional(v.string()),
    encoding: v.optional(fileEntryEncodingValidator),
    target: v.optional(v.union(v.string(), v.null())),
    contentStorage: v.optional(v.string()),
    blobProvider: v.optional(v.union(v.string(), v.null())),
    blobKey: v.optional(v.union(v.string(), v.null())),
    blobHash: v.optional(v.string()),
    blobSize: v.optional(v.union(v.number(), v.null())),
    clientEncryption: v.optional(v.union(v.any(), v.null())),
    encryption: v.optional(v.union(v.any(), v.null())),
    privacyZone: v.optional(privacyZoneKindValidator),
    zoneId: v.optional(v.union(v.string(), v.null())),
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
      const nextFile = normalizeFileEntryForStorage(args.path, {
        kind: args.kind ?? "file",
        content: args.content,
        encoding: args.encoding,
        target: args.target,
        contentStorage: args.contentStorage,
        blobProvider: args.blobProvider,
        blobKey: args.blobKey,
        blobHash: args.blobHash,
        blobSize: args.blobSize,
        clientEncryption: args.clientEncryption,
        encryption: args.encryption,
        privacyZone: args.privacyZone,
        zoneId: args.zoneId,
        hash: args.hash,
        size: args.size,
      }, previousRevision + 1, now);
      if (!nextFile.hash) {
        throw new Error(`File ${args.type} requires a content hash.`);
      }

      const scope = scopeForPath(args.path) as "shared" | "owner-private";
      const changed =
        !existingFile ||
        (existingFile.kind ?? "file") !== nextFile.kind ||
        existingFile.hash !== nextFile.hash ||
        existingFile.scope !== scope ||
        existingFile.content !== nextFile.content ||
        existingFile.contentStorage !== nextFile.contentStorage ||
        (existingFile.blobProvider ?? null) !== (nextFile.blobProvider ?? null) ||
        (existingFile.blobKey ?? null) !== (nextFile.blobKey ?? null) ||
        (existingFile.target ?? null) !== (nextFile.target ?? null);

      if (changed) {
        nextRevision += 1;
        if (nextFile.kind !== "directory" && nextFile.contentStorage !== "object-blob") {
          await upsertFileBlob(ctx, args.codebaseId, nextFile.hash, nextFile.content, nextFile.encoding, nextFile.size, now);
        }
        const fileValue: any = {
          codebaseId: args.codebaseId,
          path: args.path,
          kind: nextFile.kind,
          content: nextFile.content,
          encoding: nextFile.encoding,
          target: nextFile.target,
          contentStorage: nextFile.contentStorage,
          blobProvider: nextFile.blobProvider,
          blobKey: nextFile.blobKey,
          hash: nextFile.hash,
          size: nextFile.size,
          scope,
          privacyZone: privacyZoneForPath(args.path),
          zoneId: zoneIdForPath(args.codebaseId, args.path),
          revision: nextRevision,
          updatedAt: now,
        };
        if (nextFile.kind !== "directory") {
          fileValue.blobHash = nextFile.hash;
          fileValue.contentStorage = nextFile.contentStorage === "object-blob"
            ? "object-blob"
            : nextFile.encoding === "base64" ? "convex-file-blob-base64" : "convex-file-blob";
          if (nextFile.contentStorage === "object-blob") {
            fileValue.blobProvider = nextFile.blobProvider;
            fileValue.blobKey = nextFile.blobKey;
            fileValue.blobHash = (nextFile as any).blobHash ?? nextFile.hash;
            fileValue.blobSize = (nextFile as any).blobSize ?? nextFile.size ?? null;
            fileValue.clientEncryption = (nextFile as any).clientEncryption ?? null;
            fileValue.encryption = (nextFile as any).encryption ?? null;
          }
        }

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

export const registerDeviceKey = mutation({
  args: {
    codebaseId: v.string(),
    deviceId: v.string(),
    displayName: v.optional(v.string()),
    platform: v.optional(v.string()),
    encryptionPublicKey: v.string(),
    encryptionPublicKeyAlgorithm: v.string(),
    encryptionPublicKeyEncoding: v.string(),
    signingPublicKey: v.optional(v.string()),
    signingPublicKeyAlgorithm: v.optional(v.string()),
    signingPublicKeyEncoding: v.optional(v.string()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "read");
    const now = new Date().toISOString();
    const deviceId = normalizeKeyEntityId(args.deviceId, "Device id");
    assertDevicePublicKeyDescriptor(args);

    const existing = await ctx.db
      .query("deviceKeys")
      .withIndex("by_device_id", (q: any) => q.eq("deviceId", deviceId))
      .unique();

    if (existing) {
      if (existing.userId !== actor.userId) {
        throw new Error(`Device key ${deviceId} already belongs to another user.`);
      }
      if (existing.status === "revoked" || existing.status === "lost") {
        throw new Error(`Device key ${deviceId} is ${existing.status} and cannot be reused.`);
      }
      assertSameDevicePublicKeys(existing, args);
      await ctx.db.patch(existing._id, {
        displayName: optionalText(args.displayName) ?? existing.displayName,
        platform: optionalText(args.platform) ?? existing.platform,
        status: "trusted",
        trustedAt: existing.trustedAt ?? now,
        lastSeenAt: now,
      });
      const current = await ctx.db.get(existing._id);
      return summarizeDeviceKey(current);
    }

    const deviceKeyId = await ctx.db.insert("deviceKeys", {
      deviceId,
      userId: actor.userId,
      displayName: optionalText(args.displayName) ?? undefined,
      platform: optionalText(args.platform) ?? undefined,
      encryptionPublicKey: args.encryptionPublicKey,
      encryptionPublicKeyAlgorithm: args.encryptionPublicKeyAlgorithm,
      encryptionPublicKeyEncoding: args.encryptionPublicKeyEncoding,
      signingPublicKey: optionalText(args.signingPublicKey) ?? undefined,
      signingPublicKeyAlgorithm: optionalText(args.signingPublicKeyAlgorithm) ?? undefined,
      signingPublicKeyEncoding: optionalText(args.signingPublicKeyEncoding) ?? undefined,
      status: "trusted",
      createdAt: now,
      trustedAt: now,
      lastSeenAt: now,
    });
    await appendKeyAuditEvent(ctx, {
      codebaseId: args.codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: "device_key.trusted",
      targetUserId: actor.userId,
      targetDeviceId: deviceId,
    });

    return summarizeDeviceKey(await ctx.db.get(deviceKeyId));
  },
});

export const listDeviceKeys = query({
  args: {
    codebaseId: v.string(),
    userId: v.optional(v.string()),
    status: v.optional(deviceKeyStatusValidator),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "read");
    const targetUserId = optionalText(args.userId) ?? actor.userId;
    if (targetUserId !== actor.userId && actor.kind !== "service") {
      await requireKeyActorCapability(ctx, args.codebaseId, actor, "manage_members");
    }

    const devices = await ctx.db
      .query("deviceKeys")
      .withIndex("by_user", (q: any) => q.eq("userId", targetUserId))
      .collect();

    return devices
      .filter((device) => !args.status || device.status === args.status)
      .sort((a, b) => String(b.lastSeenAt ?? b.createdAt).localeCompare(String(a.lastSeenAt ?? a.createdAt)))
      .map(summarizeDeviceKey);
  },
});

export const ensureUserKeyring = mutation({
  args: {
    codebaseId: v.string(),
    vaultKeyId: v.string(),
    currentVersion: v.optional(v.number()),
    recoveryConfigured: v.optional(v.boolean()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "read");
    const now = new Date().toISOString();
    const vaultKeyId = normalizeKeyEntityId(args.vaultKeyId, "User vault key id");
    const currentVersion = normalizePositiveInteger(args.currentVersion ?? 1, "User vault key version");
    const existing = await ctx.db
      .query("userKeyrings")
      .withIndex("by_user", (q: any) => q.eq("userId", actor.userId))
      .unique();

    if (existing) {
      if (existing.vaultKeyId !== vaultKeyId) {
        throw new Error(`User ${actor.userId} already has a different vault key.`);
      }
      await ctx.db.patch(existing._id, {
        currentVersion: Math.max(existing.currentVersion ?? 1, currentVersion),
        recoveryConfigured: existing.recoveryConfigured || args.recoveryConfigured === true,
        status: "active",
        updatedAt: now,
      });
      return summarizeUserKeyring(await ctx.db.get(existing._id));
    }

    const id = await ctx.db.insert("userKeyrings", {
      userId: actor.userId,
      vaultKeyId,
      currentVersion,
      status: "active",
      recoveryConfigured: args.recoveryConfigured === true,
      createdAt: now,
      updatedAt: now,
    });
    await appendKeyAuditEvent(ctx, {
      codebaseId: args.codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: "user_keyring.created",
      targetUserId: actor.userId,
      keyId: vaultKeyId,
    });

    return summarizeUserKeyring(await ctx.db.get(id));
  },
});

export const ensureCodebaseKeyring = mutation({
  args: {
    codebaseId: v.string(),
    repoContentKeyId: v.string(),
    ownerPrivateKeyId: v.string(),
    gitInternalsKeyId: v.string(),
    defaultSecretKeyId: v.string(),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "manage_members");
    const now = new Date().toISOString();
    const next = {
      repoContentKeyId: normalizeKeyEntityId(args.repoContentKeyId, "Repo content key id"),
      ownerPrivateKeyId: normalizeKeyEntityId(args.ownerPrivateKeyId, "Owner private key id"),
      gitInternalsKeyId: normalizeKeyEntityId(args.gitInternalsKeyId, "Git internals key id"),
      defaultSecretKeyId: normalizeKeyEntityId(args.defaultSecretKeyId, "Default secret key id"),
    };
    const existing = await ctx.db
      .query("codebaseKeyrings")
      .withIndex("by_codebase", (q: any) => q.eq("codebaseId", args.codebaseId))
      .unique();

    if (existing) {
      assertSameCodebaseKeyring(existing, next);
      await ctx.db.patch(existing._id, { updatedAt: now });
      return summarizeCodebaseKeyring(await ctx.db.get(existing._id));
    }

    const id = await ctx.db.insert("codebaseKeyrings", {
      codebaseId: args.codebaseId,
      ...next,
      createdAt: now,
      updatedAt: now,
    });
    await appendKeyAuditEvent(ctx, {
      codebaseId: args.codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: "codebase_keyring.created",
    });

    return summarizeCodebaseKeyring(await ctx.db.get(id));
  },
});

export const createWrappedKey = mutation({
  args: {
    codebaseId: v.string(),
    wrapId: v.optional(v.string()),
    wrappedKeyId: v.string(),
    wrappedKeyType: wrappedKeyTypeValidator,
    keyVersion: v.number(),
    recipientType: wrappedKeyRecipientTypeValidator,
    recipientId: v.string(),
    zoneId: v.optional(v.string()),
    wrappingKeyId: v.optional(v.string()),
    wrappingPublicKeyId: v.optional(v.string()),
    algorithm: v.string(),
    ciphertext: v.string(),
    createdByDeviceId: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const capability = capabilityForWrappedKey(args);
    const actor = await resolveKeyActor(ctx, args, capability);
    const now = new Date().toISOString();
    const wrapId = normalizeKeyEntityId(args.wrapId ?? createWrappedKeyId(), "Wrapped key id");
    const wrappedKeyId = normalizeKeyEntityId(args.wrappedKeyId, "Wrapped key id");
    const keyVersion = normalizePositiveInteger(args.keyVersion, "Wrapped key version");
    const recipientId = normalizeKeyEntityId(args.recipientId, "Wrapped key recipient id");
    const expiresAt = normalizeFutureTimestamp(args.expiresAt, "Wrapped key expiry");
    assertWrappedKeyEnvelope(args);
    const recipientDevice = await requireTrustedRecipientDevice(ctx, {
      recipientType: args.recipientType,
      recipientId,
    });
    if (args.wrappedKeyType === "user-vault" && recipientDevice?.userId !== actor.userId) {
      throw new Error("User vault keys can only be wrapped to the owner's trusted devices.");
    }
    if (
      recipientDevice &&
      recipientDevice.userId !== actor.userId &&
      actor.kind !== "service"
    ) {
      await requireKeyActorCapability(ctx, args.codebaseId, actor, "manage_members");
    }

    const existing = await ctx.db
      .query("wrappedKeys")
      .withIndex("by_wrap_id", (q: any) => q.eq("wrapId", wrapId))
      .unique();
    const value: any = {
      wrapId,
      wrappedKeyId,
      wrappedKeyType: args.wrappedKeyType,
      keyVersion,
      recipientType: args.recipientType,
      recipientId,
      codebaseId: args.codebaseId,
      zoneId: optionalText(args.zoneId) ?? undefined,
      wrappingKeyId: optionalText(args.wrappingKeyId) ?? undefined,
      wrappingPublicKeyId: optionalText(args.wrappingPublicKeyId) ?? undefined,
      algorithm: args.algorithm,
      ciphertext: args.ciphertext,
      createdByUserId: actor.userId,
      createdByDeviceId: optionalText(args.createdByDeviceId) ?? actor.deviceId ?? undefined,
      createdAt: now,
      expiresAt,
      status: "active" as const,
    };

    if (existing) {
      assertSameWrappedKey(existing, value);
      return summarizeWrappedKey(existing);
    }
    await assertNoDuplicateActiveWrappedKey(ctx, value);

    const id = await ctx.db.insert("wrappedKeys", value);
    await appendKeyAuditEvent(ctx, {
      codebaseId: args.codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: "wrapped_key.created",
      targetUserId: recipientDevice?.userId,
      targetDeviceId: recipientDevice?.deviceId,
      zoneId: value.zoneId,
      keyId: wrappedKeyId,
      wrapId,
    });

    return summarizeWrappedKey(await ctx.db.get(id));
  },
});

export const listWrappedKeys = query({
  args: {
    codebaseId: v.string(),
    recipientType: v.optional(wrappedKeyRecipientTypeValidator),
    recipientId: v.optional(v.string()),
    wrappedKeyId: v.optional(v.string()),
    zoneId: v.optional(v.string()),
    status: v.optional(wrappedKeyStatusValidator),
    includeExpired: v.optional(v.boolean()),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "read");
    const actorDeviceIds = actor.kind === "service"
      ? new Set<string>()
      : new Set((await ctx.db
        .query("deviceKeys")
        .withIndex("by_user", (q: any) => q.eq("userId", actor.userId))
        .collect()).map((device: any) => device.deviceId));
    const rows = await ctx.db
      .query("wrappedKeys")
      .withIndex("by_codebase", (q: any) => q.eq("codebaseId", args.codebaseId))
      .collect();
    const now = Date.now();

    return rows
      .filter((row) => !args.recipientType || row.recipientType === args.recipientType)
      .filter((row) => !args.recipientId || row.recipientId === args.recipientId)
      .filter((row) => !args.wrappedKeyId || row.wrappedKeyId === args.wrappedKeyId)
      .filter((row) => !args.zoneId || row.zoneId === args.zoneId)
      .filter((row) => !args.status || effectiveWrappedKeyStatus(row, now) === args.status)
      .filter((row) => args.includeExpired || effectiveWrappedKeyStatus(row, now) !== "expired")
      .filter((row) => canActorReadWrappedKey(row, actor, actorDeviceIds))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((row) => summarizeWrappedKey({
        ...row,
        status: effectiveWrappedKeyStatus(row, now),
      }));
  },
});

export const revokeWrappedKey = mutation({
  args: {
    codebaseId: v.string(),
    wrapId: v.string(),
    token: v.optional(v.string()),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await resolveKeyActor(ctx, args, "manage_members");
    const wrapId = normalizeKeyEntityId(args.wrapId, "Wrapped key id");
    const existing = await ctx.db
      .query("wrappedKeys")
      .withIndex("by_wrap_id", (q: any) => q.eq("wrapId", wrapId))
      .unique();
    if (!existing || existing.codebaseId !== args.codebaseId) {
      throw new Error(`Wrapped key ${wrapId} was not found.`);
    }
    const now = new Date().toISOString();
    await ctx.db.patch(existing._id, {
      status: "revoked",
      revokedAt: now,
    });
    await appendKeyAuditEvent(ctx, {
      codebaseId: args.codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: "wrapped_key.revoked",
      targetDeviceId: existing.recipientType === "device" ? existing.recipientId : undefined,
      zoneId: existing.zoneId,
      keyId: existing.wrappedKeyId,
      wrapId,
    });

    return summarizeWrappedKey(await ctx.db.get(existing._id));
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

async function resolveKeyActor(ctx: any, args: any, capability: Capability) {
  if (args.sessionToken && args.token === undefined) {
    const agentCapability = agentCapabilityForCodebaseCapability(capability);
    const access = await requireAgentAccess(ctx, args.codebaseId, {
      sessionToken: args.sessionToken,
    }, agentCapability, { touch: true });
    return {
      kind: "agent-session" as const,
      userId: access.userId,
      deviceId: access.session?.sessionId,
      sessionToken: args.sessionToken,
    };
  }

  const actor = await resolveReadActor(ctx, args.token);
  const { codebase } = await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, capability);
  return {
    kind: actor.kind,
    userId: actor.kind === "service" ? (codebase.ownerId ?? actor.userId) : actor.userId,
    deviceId: undefined,
  };
}

async function requireKeyActorCapability(ctx: any, codebaseId: string, actor: any, capability: Capability) {
  if (actor.kind === "agent-session") {
    await requireAgentAccess(ctx, codebaseId, {
      sessionToken: actor.sessionToken,
    }, agentCapabilityForCodebaseCapability(capability), { touch: true });
    return;
  }
  await requireCodebaseCapabilityForActor(ctx, codebaseId, {
    kind: actor.kind,
    userId: actor.userId,
  }, capability);
}

function agentCapabilityForCodebaseCapability(capability: Capability) {
  if (capability === "manage_members") return "admin";
  return capability;
}

function capabilityForWrappedKey(args: any): Capability {
  if (args.wrappedKeyType === "user-vault") return "read";
  if (args.wrappedKeyType === "repo-content") return "write";
  if (args.wrappedKeyType === "file-dek" && isPrivateZoneId(optionalText(args.zoneId) ?? null)) {
    return "manage_members";
  }
  if (args.wrappedKeyType === "file-dek") return "write";
  return "manage_members";
}

function isPrivateZoneId(zoneId: string | null) {
  if (!zoneId) return false;
  return (
    zoneId.endsWith(":owner-private") ||
    zoneId.endsWith(":secrets") ||
    zoneId.endsWith(":git-internals") ||
    zoneId.includes("owner-private") ||
    zoneId.includes("secrets") ||
    zoneId.includes("git-internals")
  );
}

function normalizeKeyEntityId(value: string, label: string) {
  const id = optionalText(value);
  if (!id) throw new Error(`${label} is required.`);
  if (!/^[A-Za-z0-9_.:-]{3,180}$/.test(id)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, colons, and dashes.`);
  }
  return id;
}

function normalizePositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function assertDevicePublicKeyDescriptor(args: any) {
  if (args.encryptionPublicKeyAlgorithm !== "x25519") {
    throw new Error("Device encryption public key algorithm must be x25519.");
  }
  if (args.encryptionPublicKeyEncoding !== "spki-pem") {
    throw new Error("Device encryption public key encoding must be spki-pem.");
  }
  if (!looksLikePem(args.encryptionPublicKey, "PUBLIC KEY")) {
    throw new Error("Device encryption public key must be a PEM public key.");
  }
  if (args.signingPublicKey !== undefined) {
    if (args.signingPublicKeyAlgorithm !== "ed25519") {
      throw new Error("Device signing public key algorithm must be ed25519.");
    }
    if (args.signingPublicKeyEncoding !== "spki-pem") {
      throw new Error("Device signing public key encoding must be spki-pem.");
    }
    if (!looksLikePem(args.signingPublicKey, "PUBLIC KEY")) {
      throw new Error("Device signing public key must be a PEM public key.");
    }
  }
}

function looksLikePem(value: unknown, block: string) {
  const text = typeof value === "string" ? optionalText(value) : null;
  return Boolean(text && text.includes(`-----BEGIN ${block}-----`) && text.includes(`-----END ${block}-----`));
}

function assertSameDevicePublicKeys(existing: any, args: any) {
  const checks = [
    ["encryptionPublicKey", args.encryptionPublicKey],
    ["encryptionPublicKeyAlgorithm", args.encryptionPublicKeyAlgorithm],
    ["encryptionPublicKeyEncoding", args.encryptionPublicKeyEncoding],
    ["signingPublicKey", optionalText(args.signingPublicKey) ?? undefined],
    ["signingPublicKeyAlgorithm", optionalText(args.signingPublicKeyAlgorithm) ?? undefined],
    ["signingPublicKeyEncoding", optionalText(args.signingPublicKeyEncoding) ?? undefined],
  ];
  for (const [field, value] of checks) {
    if ((existing[field] ?? undefined) !== value) {
      throw new Error(`Device key ${existing.deviceId} already exists with different public key material.`);
    }
  }
}

function assertSameCodebaseKeyring(existing: any, next: any) {
  for (const field of ["repoContentKeyId", "ownerPrivateKeyId", "gitInternalsKeyId", "defaultSecretKeyId"]) {
    if (existing[field] !== next[field]) {
      throw new Error("Codebase keyring already exists with different key ids. Use a rotation flow instead.");
    }
  }
}

function assertWrappedKeyEnvelope(args: any) {
  if (args.algorithm !== "x25519-aes-256-gcm" && args.algorithm !== "pbkdf2-sha256-aes-256-gcm") {
    throw new Error("Wrapped key algorithm is not supported.");
  }
  const ciphertext = optionalText(args.ciphertext);
  if (!ciphertext || ciphertext.length > 256_000) {
    throw new Error("Wrapped key ciphertext must be a non-empty bounded string.");
  }

  let envelope: any = null;
  try {
    envelope = JSON.parse(ciphertext);
  } catch {
    throw new Error("Wrapped key ciphertext must be a serialized JSON envelope.");
  }
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Wrapped key envelope must be an object.");
  }
  if (envelope.algorithm !== args.algorithm) {
    throw new Error("Wrapped key envelope algorithm must match the stored algorithm.");
  }
  if (typeof envelope.context === "string") {
    if (!envelope.context.includes(args.wrappedKeyId) || !envelope.context.includes(args.recipientId)) {
      throw new Error("Wrapped key envelope context must bind the wrapped key and recipient.");
    }
  }
}

async function requireTrustedRecipientDevice(ctx: any, args: { recipientType: string; recipientId: string }) {
  if (args.recipientType !== "device") return null;
  const device = await ctx.db
    .query("deviceKeys")
    .withIndex("by_device_id", (q: any) => q.eq("deviceId", args.recipientId))
    .unique();
  if (!device) throw new Error(`Recipient device ${args.recipientId} was not found.`);
  if (device.status !== "trusted") {
    throw new Error(`Recipient device ${args.recipientId} is not trusted.`);
  }
  return device;
}

async function assertNoDuplicateActiveWrappedKey(ctx: any, value: any) {
  const existing = await ctx.db
    .query("wrappedKeys")
    .withIndex("by_wrapped_key", (q: any) => q.eq("wrappedKeyId", value.wrappedKeyId))
    .collect();
  const duplicate = existing.find((row: any) => (
    row.codebaseId === value.codebaseId &&
    row.wrappedKeyType === value.wrappedKeyType &&
    row.keyVersion === value.keyVersion &&
    row.recipientType === value.recipientType &&
    row.recipientId === value.recipientId &&
    effectiveWrappedKeyStatus(row, Date.now()) === "active"
  ));
  if (duplicate) {
    throw new Error(`An active wrapped key already exists for ${value.wrappedKeyId} and recipient ${value.recipientId}.`);
  }
}

function assertSameWrappedKey(existing: any, value: any) {
  if (effectiveWrappedKeyStatus(existing, Date.now()) !== "active") {
    throw new Error(`Wrapped key ${existing.wrapId} is not active and cannot be reused.`);
  }
  for (const field of [
    "wrappedKeyId",
    "wrappedKeyType",
    "keyVersion",
    "recipientType",
    "recipientId",
    "codebaseId",
    "zoneId",
    "wrappingKeyId",
    "wrappingPublicKeyId",
    "algorithm",
    "ciphertext",
  ]) {
    if ((existing[field] ?? undefined) !== (value[field] ?? undefined)) {
      throw new Error(`Wrapped key ${existing.wrapId} already exists with different metadata.`);
    }
  }
}

function effectiveWrappedKeyStatus(row: any, now: number) {
  if (row.status !== "active") return row.status;
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return "expired";
  return "active";
}

function canActorReadWrappedKey(row: any, actor: any, actorDeviceIds: Set<string>) {
  if (actor.kind === "service") return true;
  if (row.createdByUserId === actor.userId) return true;
  if (row.recipientType === "user" && row.recipientId === actor.userId) return true;
  if (row.recipientType === "device" && actorDeviceIds.has(row.recipientId)) return true;
  return false;
}

async function appendKeyAuditEvent(ctx: any, event: any) {
  await ctx.db.insert("keyAuditEvents", {
    eventId: `kae_${randomBase64Url(12)}`,
    codebaseId: event.codebaseId,
    actorUserId: event.actorUserId,
    actorDeviceId: event.actorDeviceId,
    eventType: event.eventType,
    targetUserId: event.targetUserId,
    targetDeviceId: event.targetDeviceId,
    zoneId: event.zoneId,
    keyId: event.keyId,
    wrapId: event.wrapId,
    createdAt: new Date().toISOString(),
  });
}

function summarizeDeviceKey(device: any) {
  if (!device) return null;
  return {
    deviceId: device.deviceId,
    userId: device.userId,
    displayName: device.displayName ?? null,
    platform: device.platform ?? null,
    encryptionPublicKeyAlgorithm: device.encryptionPublicKeyAlgorithm,
    encryptionPublicKeyEncoding: device.encryptionPublicKeyEncoding,
    signingPublicKeyAlgorithm: device.signingPublicKeyAlgorithm ?? null,
    signingPublicKeyEncoding: device.signingPublicKeyEncoding ?? null,
    status: device.status,
    createdAt: device.createdAt,
    trustedAt: device.trustedAt ?? null,
    revokedAt: device.revokedAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
  };
}

function summarizeUserKeyring(keyring: any) {
  if (!keyring) return null;
  return {
    userId: keyring.userId,
    vaultKeyId: keyring.vaultKeyId,
    currentVersion: keyring.currentVersion,
    status: keyring.status,
    recoveryConfigured: keyring.recoveryConfigured,
    createdAt: keyring.createdAt,
    updatedAt: keyring.updatedAt,
  };
}

function summarizeCodebaseKeyring(keyring: any) {
  if (!keyring) return null;
  return {
    codebaseId: keyring.codebaseId,
    repoContentKeyId: keyring.repoContentKeyId,
    ownerPrivateKeyId: keyring.ownerPrivateKeyId,
    gitInternalsKeyId: keyring.gitInternalsKeyId,
    defaultSecretKeyId: keyring.defaultSecretKeyId,
    rotationState: keyring.rotationState ?? null,
    createdAt: keyring.createdAt,
    updatedAt: keyring.updatedAt,
  };
}

function summarizeWrappedKey(wrappedKey: any) {
  if (!wrappedKey) return null;
  return {
    wrapId: wrappedKey.wrapId,
    wrappedKeyId: wrappedKey.wrappedKeyId,
    wrappedKeyType: wrappedKey.wrappedKeyType,
    keyVersion: wrappedKey.keyVersion,
    recipientType: wrappedKey.recipientType,
    recipientId: wrappedKey.recipientId,
    codebaseId: wrappedKey.codebaseId ?? null,
    zoneId: wrappedKey.zoneId ?? null,
    wrappingKeyId: wrappedKey.wrappingKeyId ?? null,
    wrappingPublicKeyId: wrappedKey.wrappingPublicKeyId ?? null,
    algorithm: wrappedKey.algorithm,
    ciphertext: wrappedKey.ciphertext,
    createdByUserId: wrappedKey.createdByUserId ?? null,
    createdByDeviceId: wrappedKey.createdByDeviceId ?? null,
    createdAt: wrappedKey.createdAt,
    expiresAt: wrappedKey.expiresAt ?? null,
    revokedAt: wrappedKey.revokedAt ?? null,
    status: wrappedKey.status,
  };
}

function createWrappedKeyId() {
  return `wrap_${randomBase64Url(18)}`;
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
        kind: file.kind ?? "file",
        content: file.content,
        encoding: file.encoding ?? "utf8",
        target: file.target ?? null,
        blobHash: file.blobHash ?? file.hash ?? null,
        blobProvider: file.blobProvider ?? null,
        blobKey: file.blobKey ?? null,
        blobSize: file.blobSize ?? null,
        clientEncryption: (file as any).clientEncryption ?? null,
        encryption: (file as any).encryption ?? null,
        privacyZone: (file as any).privacyZone ?? privacyZoneForPath(file.path),
        zoneId: (file as any).zoneId ?? zoneIdForPath(codebaseId, file.path),
        contentStorage: file.contentStorage ?? "inline",
        hash: file.hash ?? null,
        size: file.size ?? byteLength(file.content),
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

function summarizeCodebaseHead(codebase: any, access: AccessContext | null = null) {
  const main = codebase.main && typeof codebase.main === "object" ? codebase.main : {};
  const selectedState = codebase.selectedState && typeof codebase.selectedState === "object"
    ? codebase.selectedState
    : null;
  const ownerId = stringOrNull(codebase.ownerId) ?? stringOrNull(codebase.owner?.id);

  return {
    exists: true,
    schemaVersion: Number.isInteger(codebase.schemaVersion) ? codebase.schemaVersion : null,
    codebase: {
      id: codebase.codebaseId,
      name: stringOrNull(codebase.name) ?? codebase.codebaseId,
      ownerId,
    },
    main: {
      id: stringOrNull(main.id) ?? null,
      revision: Number.isInteger(main.revision) ? main.revision : null,
    },
    selectedState: selectedState
      ? {
          type: stringOrNull(selectedState.type) ?? null,
          id: stringOrNull(selectedState.id) ?? null,
          ownerId: stringOrNull(selectedState.ownerId) ?? null,
          baseMainId: stringOrNull(selectedState.baseMainId) ?? null,
          baseRevision: Number.isInteger(selectedState.baseRevision) ? selectedState.baseRevision : null,
          revision: Number.isInteger(selectedState.revision) ? selectedState.revision : null,
          visibility: stringOrNull(selectedState.visibility) ?? null,
          effectiveVisibility: stringOrNull(selectedState.effectiveVisibility) ?? null,
          reviewState: stringOrNull(selectedState.reviewState) ?? null,
          mergeState: stringOrNull(selectedState.mergeState) ?? null,
          conflictState: stringOrNull(selectedState.conflictState) ?? null,
        }
      : null,
    owner: ownerId ? { id: ownerId } : null,
    session: codebase.session
      ? {
          id: stringOrNull(codebase.session.id) ?? null,
          deviceName: stringOrNull(codebase.session.deviceName) ?? null,
        }
      : null,
    visibility: codebase.visibility ?? null,
    access: access ? summarizeAccessContext(access) : null,
    revision: Number.isInteger(codebase.revision) ? codebase.revision : null,
    updatedAt: stringOrNull(codebase.updatedAt) ?? null,
  };
}

async function readFileByPath(ctx: any, codebaseId: string, filePath: string) {
  return await ctx.db
    .query("files")
    .withIndex("by_codebase_path", (q: any) => q.eq("codebaseId", codebaseId).eq("path", filePath))
    .unique();
}

async function upsertFileBlob(
  ctx: any,
  codebaseId: string,
  hash: string,
  content: string,
  encoding: "utf8" | "base64",
  size: number,
  now: string,
) {
  const existingBlob = await ctx.db
    .query("fileBlobs")
    .withIndex("by_codebase_hash", (q: any) => q.eq("codebaseId", codebaseId).eq("hash", hash))
    .unique();

  if (existingBlob) {
    if (existingBlob.content !== content || existingBlob.size !== size || (existingBlob.encoding ?? "utf8") !== encoding) {
      throw new Error(`content_hash_collision: existing blob content differs for ${hash}.`);
    }
    return existingBlob._id;
  }

  return await ctx.db.insert("fileBlobs", {
    codebaseId,
    hash,
    content,
    encoding,
    size,
    createdAt: now,
  });
}

function normalizeFileEntryForStorage(
  filePath: string,
  file: unknown,
  revision: number,
  now: string,
) {
  const value = file && typeof file === "object" ? { ...(file as Record<string, any>) } : {};
  const kind = value.kind === "symlink" || value.kind === "directory" ? value.kind : "file";
  const scope = scopeForPath(filePath) as "shared" | "owner-private";
  const privacyZone = privacyZoneForPath(filePath);

  if (kind === "directory") {
    return {
      kind,
      content: "",
      encoding: "utf8" as const,
      target: null,
      hash: typeof value.hash === "string" ? value.hash : hashText(`directory\0${filePath}`),
      size: 0,
      scope,
      privacyZone,
      zoneId: typeof value.zoneId === "string" ? value.zoneId : null,
      revision: typeof value.revision === "number" ? value.revision : revision,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    };
  }

  if (kind === "symlink") {
    const target = typeof value.target === "string" ? value.target : String(value.content ?? "");
    return {
      kind,
      content: target,
      encoding: "utf8" as const,
      target,
      hash: typeof value.hash === "string" ? value.hash : hashText(`symlink\0${target}`),
      size: typeof value.size === "number" ? value.size : byteLength(target),
      scope,
      privacyZone,
      zoneId: typeof value.zoneId === "string" ? value.zoneId : null,
      revision: typeof value.revision === "number" ? value.revision : revision,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    };
  }

  const content = typeof value.content === "string" ? value.content : "";
  const encoding = value.encoding === "base64" ? "base64" as const : "utf8" as const;
  const contentStorage = value.contentStorage === "object-blob" ? "object-blob" : "inline";
  const hash = typeof value.hash === "string"
    ? value.hash
    : typeof value.blobHash === "string"
      ? value.blobHash
      : hashText(content);
  const blobHash = typeof value.blobHash === "string" ? value.blobHash : hash;
  return {
    kind,
    content,
    encoding,
    target: null,
    contentStorage,
    blobProvider: contentStorage === "object-blob" && typeof value.blobProvider === "string" ? value.blobProvider : null,
    blobKey: contentStorage === "object-blob" && typeof value.blobKey === "string" ? value.blobKey : null,
    blobHash,
    blobSize: contentStorage === "object-blob" && typeof value.blobSize === "number" ? value.blobSize : null,
    clientEncryption: contentStorage === "object-blob" && value.clientEncryption && typeof value.clientEncryption === "object" ? value.clientEncryption : null,
    encryption: contentStorage === "object-blob" && value.encryption && typeof value.encryption === "object" ? value.encryption : null,
    hash,
    size: typeof value.size === "number" ? value.size : byteLength(content),
    scope,
    privacyZone,
    zoneId: typeof value.zoneId === "string" ? value.zoneId : null,
    revision: typeof value.revision === "number" ? value.revision : revision,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function hashText(value: string) {
  let hash = 0;
  // Convex runtime does not expose Node crypto in queries/mutations, so this is
  // only a deterministic fallback for legacy graphs missing agent-supplied hashes.
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return `legacy-${Math.abs(hash)}`;
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
  for (const [filePath, file] of Object.entries(value.files)) {
    value.files[filePath] = normalizeFileEntryForStorage(filePath, file, value.revision, new Date().toISOString());
  }

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
    const privacyZone = (file as { privacyZone?: unknown })?.privacyZone;
    if (typeof privacyZone === "string" && privacyZone !== privacyZoneForPath(filePath)) {
      throw new Error(`HopIt graph privacy zone mismatch for ${filePath}: expected ${privacyZoneForPath(filePath)}, got ${privacyZone}.`);
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
    const kind = value.kind ?? "file";
    if (kind !== "file" && kind !== "symlink" && kind !== "directory") errors.push(`${filePath}.kind is invalid.`);
    if (kind === "file" && value.encoding !== "utf8" && value.encoding !== "base64") {
      errors.push(`${filePath}.encoding is invalid.`);
    }
    if (
      kind === "file" &&
      value.contentStorage !== undefined &&
      value.contentStorage !== "inline" &&
      value.contentStorage !== "convex-file-blob" &&
      value.contentStorage !== "convex-file-blob-base64" &&
      value.contentStorage !== "object-blob"
    ) {
      errors.push(`${filePath}.contentStorage is invalid.`);
    }
    if (kind === "file" && value.contentStorage === "object-blob") {
      if (!isNonEmptyString(value.blobProvider)) errors.push(`${filePath}.blobProvider is required for object-backed files.`);
      if (!isNonEmptyString(value.blobKey)) errors.push(`${filePath}.blobKey is required for object-backed files.`);
      if (!isNonEmptyString(value.blobHash ?? value.hash)) errors.push(`${filePath}.blobHash is required for object-backed files.`);
      errors.push(...validateLegacyClientEncryptionMetadata(value.clientEncryption, `${filePath}.clientEncryption`, value.blobHash, value.blobSize));
      errors.push(...validateCanonicalEncryptionMetadata(value.encryption, `${filePath}.encryption`, value.blobHash, value.blobSize));
    }
    if (kind === "file" && privacyZoneForPath(filePath) === "secrets" && !hasValidEncryptedPayload(value)) {
      errors.push(`${filePath} must be stored as encrypted object-backed content because it is in the secrets privacy zone.`);
    }
    if (kind === "symlink" && typeof value.target !== "string") errors.push(`${filePath}.target must be a string.`);
    if (kind === "directory" && value.content !== "") errors.push(`${filePath}.content must be empty for directories.`);
    if (value.scope !== scopeForPath(filePath)) errors.push(`${filePath}.scope must be ${scopeForPath(filePath)}.`);
    if (value.privacyZone !== privacyZoneForPath(filePath)) {
      errors.push(`${filePath}.privacyZone must be ${privacyZoneForPath(filePath)}.`);
    }
    if (value.zoneId !== null && value.zoneId !== zoneIdForPath(graph.codebase.id, filePath)) {
      errors.push(`${filePath}.zoneId must be ${zoneIdForPath(graph.codebase.id, filePath)}.`);
    }
    if (!Number.isInteger(value.revision)) errors.push(`${filePath}.revision must be an integer.`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid HopIt cloud graph: ${errors.join(" ")}`);
  }
}

function privacyZoneForPath(filePath: string) {
  if (filePath === ".private/env" || filePath.startsWith(".private/env/")) return "secrets";
  if (filePath === ".git" || filePath.startsWith(".git/")) return "git-internals";
  if (filePath === ".private" || filePath.startsWith(".private/")) return "owner-private";
  return "repo-content";
}

function zoneIdForPath(codebaseId: string, filePath: string) {
  return `${codebaseId}:${privacyZoneForPath(filePath)}`;
}

function hasValidEncryptedPayload(value: any) {
  if (value?.contentStorage !== "object-blob") return false;
  const hasLegacyEnvelope = value.clientEncryption?.state === "client-encrypted";
  const hasCanonicalEnvelope = Boolean(value.encryption);
  return (
    (hasLegacyEnvelope && validateLegacyClientEncryptionMetadata(value.clientEncryption, "clientEncryption", value.blobHash, value.blobSize).length === 0) ||
    (hasCanonicalEnvelope && validateCanonicalEncryptionMetadata(value.encryption, "encryption", value.blobHash, value.blobSize).length === 0)
  );
}

function validateLegacyClientEncryptionMetadata(
  metadata: any,
  label: string,
  blobHash: unknown,
  blobSize: unknown,
) {
  const errors: string[] = [];
  if (!metadata || metadata.state !== "client-encrypted") {
    return errors;
  }
  if (metadata.version !== undefined && metadata.version !== 1) errors.push(`${label}.version is invalid.`);
  if (metadata.algorithm !== "aes-256-gcm") errors.push(`${label}.algorithm is invalid.`);
  if (metadata.aadVersion !== undefined && metadata.aadVersion !== "hopit-file-v1") errors.push(`${label}.aadVersion is invalid.`);
  if (!isNonEmptyString(metadata.keyId)) errors.push(`${label}.keyId is required.`);
  if (!isNonEmptyString(metadata.nonce)) errors.push(`${label}.nonce is required.`);
  if (!isNonEmptyString(metadata.authTag)) errors.push(`${label}.authTag is required.`);
  if (!isNonEmptyString(metadata.plaintextHash)) errors.push(`${label}.plaintextHash is required.`);
  if (typeof metadata.plaintextSize !== "number") errors.push(`${label}.plaintextSize is required.`);
  if (metadata.zone !== undefined && !isKnownPrivacyZone(metadata.zone)) errors.push(`${label}.zone is invalid.`);
  if (metadata.ciphertextHash !== undefined && metadata.ciphertextHash !== blobHash) errors.push(`${label}.ciphertextHash must match blobHash.`);
  if (metadata.ciphertextSize !== undefined && metadata.ciphertextSize !== blobSize) errors.push(`${label}.ciphertextSize must match blobSize.`);
  return errors;
}

function validateCanonicalEncryptionMetadata(
  metadata: any,
  label: string,
  blobHash: unknown,
  blobSize: unknown,
) {
  const errors: string[] = [];
  if (metadata === null || metadata === undefined) return errors;
  if (!metadata || typeof metadata !== "object") {
    return [`${label} must be an object.`];
  }
  if (metadata.version !== 2) errors.push(`${label}.version must be 2.`);
  if (metadata.state !== "client-encrypted") errors.push(`${label}.state is invalid.`);
  if (metadata.algorithm !== "aes-256-gcm" && metadata.algorithm !== "xchacha20-poly1305") errors.push(`${label}.algorithm is invalid.`);
  if (!isNonEmptyString(metadata.keyId)) errors.push(`${label}.keyId is required.`);
  if (!isNonEmptyString(metadata.zoneId)) errors.push(`${label}.zoneId is required.`);
  if (!isNonEmptyString(metadata.fileDekWrapId)) errors.push(`${label}.fileDekWrapId is required.`);
  if (!isNonEmptyString(metadata.nonce)) errors.push(`${label}.nonce is required.`);
  if (!isNonEmptyString(metadata.authTag)) errors.push(`${label}.authTag is required.`);
  if (!isNonEmptyString(metadata.aadVersion)) errors.push(`${label}.aadVersion is required.`);
  if (!isNonEmptyString(metadata.ciphertextHash)) errors.push(`${label}.ciphertextHash is required.`);
  if (!Number.isFinite(metadata.ciphertextSize)) errors.push(`${label}.ciphertextSize is required.`);
  if (!isNonEmptyString(metadata.plaintextFingerprint)) errors.push(`${label}.plaintextFingerprint is required.`);
  if (!isNonEmptyString(metadata.createdByDeviceId)) errors.push(`${label}.createdByDeviceId is required.`);
  if (!isNonEmptyString(metadata.createdAt)) errors.push(`${label}.createdAt is required.`);
  if (metadata.ciphertextHash !== undefined && metadata.ciphertextHash !== blobHash) errors.push(`${label}.ciphertextHash must match blobHash.`);
  if (metadata.ciphertextSize !== undefined && metadata.ciphertextSize !== blobSize) errors.push(`${label}.ciphertextSize must match blobSize.`);
  return errors;
}

function isKnownPrivacyZone(value: unknown) {
  return (
    value === "repo-content" ||
    value === "owner-private" ||
    value === "secrets" ||
    value === "git-internals" ||
    value === "public-snapshot"
  );
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
