import type { DatabaseReader } from "./_generated/server";

declare const process: {
  env: {
    HOPIT_AGENT_TOKEN?: string;
    HOPIT_ALLOW_UNAUTHENTICATED_AGENT?: string;
    HOPIT_OWNER_EMAIL?: string;
  };
};

export type CodebaseRole = "owner" | "maintainer" | "member" | "viewer";
export type AccessRole = CodebaseRole | "guest";
export type Capability = "read" | "write" | "invite" | "manage_members" | "review" | "merge" | "release";

export type AuthIdentity = {
  tokenIdentifier?: string;
  issuer?: string;
  subject?: string;
  email?: string;
  name?: string;
  nickname?: string;
  pictureUrl?: string;
  emailVerified?: boolean;
};

export type AccessActor = {
  kind: "user" | "service";
  userId: string;
  displayName?: string | null;
  primaryEmail?: string | null;
  currentAuthEmailVerified?: boolean;
};

export type AccessContext = {
  id: string | null;
  sessionId: string | null;
  ownerId: string | null;
  role: AccessRole;
  isOwner: boolean;
  isCollaborator: boolean;
  isService: boolean;
  membershipSource: string;
  selectedStateType: string | null;
  selectedStateId: string | null;
  effectiveChangeSetVisibility: string | null;
  permissions: Capability[];
  visibleFileCount?: number;
  hiddenFileCount?: number;
  hiddenScopeCounts?: { shared: number; private: number };
};

export type AccessSource = {
  codebaseId: string;
  ownerId: string | null;
  collaborators?: unknown[];
  selectedState?: unknown;
  visibility?: unknown;
  session?: unknown;
};

const serviceActor: AccessActor = {
  kind: "service",
  userId: "service:hopit-agent",
  displayName: "HopIt Agent",
  primaryEmail: null,
  currentAuthEmailVerified: true,
};

export async function resolveReadActor(ctx: any, token: string | undefined): Promise<AccessActor> {
  if (token !== undefined) {
    requireAgentToken(token);
    return serviceActor;
  }

  const identity = (await ctx.auth.getUserIdentity()) as AuthIdentity | null;
  if (!identity) throw new Error("Authentication required.");

  const userId = userIdFromIdentity(identity);
  const user = await readUserById(ctx, userId);
  const primaryEmail = normalizeEmail(identity.email) || user?.primaryEmail || null;

  return {
    kind: "user",
    userId,
    primaryEmail,
    displayName: stringOrNull(identity.name) ?? stringOrNull(identity.nickname) ?? user?.displayName ?? null,
    currentAuthEmailVerified: identity.emailVerified === true,
  };
}

export async function resolveWriteActor(ctx: any, token: string | undefined): Promise<AccessActor> {
  if (token !== undefined) {
    requireAgentToken(token);
    return serviceActor;
  }

  const user = await upsertUserFromCurrentAuth(ctx);
  return {
    kind: "user",
    userId: user.userId,
    primaryEmail: user.primaryEmail ?? null,
    displayName: user.displayName ?? null,
    currentAuthEmailVerified: user.currentAuthEmailVerified === true,
  };
}

export async function requireCodebaseCapabilityForActor(
  ctx: any,
  codebaseId: string,
  actor: AccessActor,
  capability: Capability,
) {
  const codebase = await readCodebaseById(ctx, codebaseId);
  if (!codebase) throw new Error(`Codebase ${codebaseId} was not found.`);

  if (actor.kind === "service") {
    return {
      codebase,
      access: serviceAccessContext(accessSourceFromCodebase(codebase)),
    };
  }

  const access = await readCodebaseAccessContext(ctx, accessSourceFromCodebase(codebase), {
    userId: actor.userId,
  });

  if (!access.permissions.includes(capability)) {
    throw new Error(`User ${actor.userId} does not have ${capability} access to ${codebaseId}.`);
  }

  return { codebase, access };
}

export async function readCodebaseById(ctx: { db: DatabaseReader }, codebaseId: string) {
  return await ctx.db
    .query("codebases")
    .withIndex("by_codebase_id", (q) => q.eq("codebaseId", codebaseId))
    .unique();
}

export function accessSourceFromCodebase(codebase: any): AccessSource {
  return {
    codebaseId: codebase.codebaseId,
    ownerId: stringOrNull(codebase.ownerId) ?? stringOrNull(codebase.owner?.id),
    collaborators: Array.isArray(codebase.collaborators) ? codebase.collaborators : [],
    selectedState: codebase.selectedState,
    visibility: codebase.visibility,
    session: codebase.session,
  };
}

export function accessSourceFromGraph(graph: any): AccessSource {
  return {
    codebaseId: graph.codebase.id,
    ownerId: stringOrNull(graph.owner?.id) ?? stringOrNull(graph.codebase.ownerId),
    collaborators: Array.isArray(graph.collaborators) ? graph.collaborators : [],
    selectedState: graph.selectedState,
    visibility: graph.visibility,
    session: graph.session,
  };
}

export async function readCodebaseAccessContext(
  ctx: { db: DatabaseReader },
  source: AccessSource,
  request: { userId?: string; sessionId?: string; allowOwnerFallback?: boolean },
): Promise<AccessContext> {
  const ownerId = source.ownerId ?? null;
  const requesterId = request.userId ?? (request.allowOwnerFallback ? ownerId ?? undefined : undefined);
  const membership = requesterId
    ? await ctx.db
        .query("codebaseMembers")
        .withIndex("by_codebase_user", (q) =>
          q.eq("codebaseId", source.codebaseId).eq("userId", requesterId),
        )
        .unique()
    : null;
  const graphCollaborator = requesterId && !membership
    ? (source.collaborators ?? []).find((entry: any) => entry?.id === requesterId)
    : null;
  const isGraphOwner = Boolean(ownerId && requesterId === ownerId);
  const activeMembership = membership?.status === "active" ? membership : null;
  const role = isGraphOwner
    ? "owner"
    : activeMembership
      ? normalizeCodebaseRole(activeMembership.role, "member")
      : graphCollaborator
        ? normalizeCodebaseRole((graphCollaborator as any).role, "member")
        : "guest";
  const isOwner = role === "owner";
  const selectedState = source.selectedState as any;
  const visibility = effectiveChangeSetVisibilityForSource(source);

  return {
    id: requesterId ?? null,
    sessionId: request.sessionId ?? (isOwner ? ((source.session as any)?.id ?? null) : null),
    ownerId,
    role,
    isOwner,
    isCollaborator: role !== "guest" && !isOwner,
    isService: false,
    membershipSource: isGraphOwner
      ? "owner"
      : activeMembership
        ? "membership"
        : membership
          ? stringOrNull((membership as any).source) ?? "membership"
          : graphCollaborator
            ? "graph"
            : "none",
    selectedStateType: selectedState?.type ?? null,
    selectedStateId: selectedState?.id ?? null,
    effectiveChangeSetVisibility: visibility,
    permissions: permissionsForRole(role),
  };
}

export function serviceAccessContext(source: AccessSource): AccessContext {
  const selectedState = source.selectedState as any;
  return {
    id: serviceActor.userId,
    sessionId: (source.session as any)?.id ?? null,
    ownerId: source.ownerId ?? null,
    role: "owner",
    isOwner: true,
    isCollaborator: false,
    isService: true,
    membershipSource: "service-token",
    selectedStateType: selectedState?.type ?? null,
    selectedStateId: selectedState?.id ?? null,
    effectiveChangeSetVisibility: effectiveChangeSetVisibilityForSource(source),
    permissions: permissionsForRole("owner"),
  };
}

export function filterGraphForAccessContext(graph: any, access: AccessContext) {
  const files: Record<string, unknown> = {};
  const hiddenPaths: string[] = [];

  for (const [filePath, file] of Object.entries(graph.files ?? {})) {
    if (canAccessPath(access, filePath)) {
      files[filePath] = file;
    } else {
      hiddenPaths.push(filePath);
    }
  }

  return {
    ...graph,
    files,
    visibilityContext: {
      ...access,
      visibleFileCount: Object.keys(files).length,
      hiddenFileCount: hiddenPaths.length,
      hiddenScopeCounts: countPathScopes(hiddenPaths),
    },
  } as any;
}

export function canAccessPath(access: AccessContext, filePath: string) {
  if (access.isOwner || access.isService) return true;
  if (scopeForPath(filePath) === "owner-private") return false;
  if (access.role === "guest") return false;
  if (access.selectedStateType === "main") return true;

  return (
    access.effectiveChangeSetVisibility === "team-visible" ||
    access.effectiveChangeSetVisibility === "review-visible"
  );
}

export function summarizeAccessContext(access: AccessContext | null) {
  if (!access) return null;

  return {
    id: access.id,
    sessionId: access.sessionId,
    ownerId: access.ownerId,
    role: access.role,
    isOwner: access.isOwner,
    isCollaborator: access.isCollaborator,
    isService: access.isService,
    membershipSource: access.membershipSource,
    selectedStateId: access.selectedStateId,
    effectiveChangeSetVisibility: access.effectiveChangeSetVisibility,
    permissions: access.permissions,
    visibleFileCount: access.visibleFileCount ?? null,
    hiddenFileCount: access.hiddenFileCount ?? null,
    hiddenScopeCounts: access.hiddenScopeCounts ?? { shared: 0, private: 0 },
  };
}

export function summarizeAuthIdentity(identity: AuthIdentity) {
  return {
    tokenIdentifier: stringOrNull(identity.tokenIdentifier),
    issuer: stringOrNull(identity.issuer),
    subject: stringOrNull(identity.subject),
    email: normalizeEmail(identity.email) || null,
    name: stringOrNull(identity.name) ?? stringOrNull(identity.nickname),
  };
}

export async function upsertUserFromCurrentAuth(ctx: any) {
  const identity = (await ctx.auth.getUserIdentity()) as AuthIdentity | null;
  if (!identity) throw new Error("Authentication required.");

  const now = new Date().toISOString();
  const userId = userIdFromIdentity(identity);
  const primaryEmail = normalizeEmail(identity.email);
  const displayName = stringOrNull(identity.name) ?? stringOrNull(identity.nickname);
  const avatarUrl = stringOrNull(identity.pictureUrl);

  const existingUser = await readUserById(ctx, userId);
  const userValue: any = { userId, updatedAt: now };
  if (primaryEmail) userValue.primaryEmail = primaryEmail;
  if (displayName) userValue.displayName = displayName;
  if (avatarUrl) userValue.avatarUrl = avatarUrl;

  if (existingUser) {
    await ctx.db.patch(existingUser._id, userValue);
  } else {
    await ctx.db.insert("users", {
      ...userValue,
      createdAt: now,
    });
  }

  const tokenIdentifier = tokenIdentifierFromIdentity(identity);
  const existingIdentity = await ctx.db
    .query("authIdentities")
    .withIndex("by_token_identifier", (q: any) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
  const identityValue: any = {
    userId,
    tokenIdentifier,
    issuer: stringOrNull(identity.issuer) ?? "unknown",
    subject: stringOrNull(identity.subject) ?? tokenIdentifier,
    updatedAt: now,
  };
  if (primaryEmail) identityValue.email = primaryEmail;
  if (typeof identity.emailVerified === "boolean") identityValue.emailVerified = identity.emailVerified;

  if (existingIdentity) {
    await ctx.db.patch(existingIdentity._id, identityValue);
  } else {
    await ctx.db.insert("authIdentities", {
      ...identityValue,
      createdAt: now,
    });
  }

  const user = (await readUserById(ctx, userId)) ?? {
    userId,
    primaryEmail,
    displayName,
    avatarUrl,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...user,
    currentAuthEmailVerified: identity.emailVerified === true,
  };
}

export async function readUserById(ctx: any, userId: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_user_id", (q: any) => q.eq("userId", userId))
    .unique();
}

export async function syncGraphAccessRows(ctx: any, graph: any, now: string) {
  const ownerId = stringOrNull(graph.owner?.id) ?? graph.codebase.ownerId;
  await upsertCodebaseMember(ctx, {
    codebaseId: graph.codebase.id,
    userId: ownerId,
    role: "owner",
    status: "active",
    source: "graph-owner",
    joinedAt: now,
    preserveSuspended: true,
    now,
  });

  for (const collaborator of graph.collaborators ?? []) {
    const userId = stringOrNull((collaborator as any)?.id);
    if (!userId || userId === ownerId) continue;
    await upsertCodebaseMember(ctx, {
      codebaseId: graph.codebase.id,
      userId,
      role: normalizeCodebaseRole((collaborator as any)?.role, "member"),
      status: "active",
      source: "graph-collaborator",
      joinedAt: now,
      preserveSuspended: true,
      now,
    });
  }
}

export async function upsertCodebaseMember(ctx: any, value: {
  codebaseId: string;
  userId: string;
  role: CodebaseRole;
  status: "active" | "suspended";
  invitedByUserId?: string;
  source?: string;
  joinedAt?: string;
  suspendedByUserId?: string;
  suspendedAt?: string;
  preserveSuspended?: boolean;
  now: string;
}) {
  const existing = await ctx.db
    .query("codebaseMembers")
    .withIndex("by_codebase_user", (q: any) =>
      q.eq("codebaseId", value.codebaseId).eq("userId", value.userId),
    )
    .unique();
  const memberValue: any = {
    codebaseId: value.codebaseId,
    userId: value.userId,
    role: value.role,
    status: value.status,
    updatedAt: value.now,
  };
  if (value.invitedByUserId) memberValue.invitedByUserId = value.invitedByUserId;
  if (value.source) memberValue.source = value.source;
  if (value.joinedAt) memberValue.joinedAt = value.joinedAt;
  if (value.suspendedByUserId) memberValue.suspendedByUserId = value.suspendedByUserId;
  if (value.suspendedAt) memberValue.suspendedAt = value.suspendedAt;

  if (existing) {
    if (value.preserveSuspended && existing.status === "suspended" && value.status === "active") {
      await ctx.db.patch(existing._id, { updatedAt: value.now });
      return existing._id;
    }
    await ctx.db.patch(existing._id, memberValue);
    return existing._id;
  }

  return await ctx.db.insert("codebaseMembers", {
    ...memberValue,
    createdAt: value.now,
  });
}

export function requireAgentToken(token: string | undefined) {
  const expected = process.env.HOPIT_AGENT_TOKEN;
  if (!expected) {
    if (process.env.HOPIT_ALLOW_UNAUTHENTICATED_AGENT === "1") return;
    throw new Error("HOPIT_AGENT_TOKEN must be configured for Convex HopIt service access.");
  }
  if (token !== expected) {
    throw new Error("Unauthorized HopIt service token.");
  }
}

export function actorAuditId(actor: AccessActor, override: string | undefined, label: string) {
  if (actor.kind === "service") {
    return requireText(override ?? actor.userId, label);
  }
  return actor.userId;
}

export async function createInvitationToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64Url(bytes);
  return {
    token,
    tokenHash: await hashInvitationToken(token),
  };
}

export async function hashInvitationToken(token: string) {
  const normalized = normalizeInvitationToken(token);
  if (!normalized) throw new Error("Invitation token is required.");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hopit.invite.v1:${normalized}`),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

export function normalizeInvitationToken(token: string) {
  return token.trim();
}

export function requireText(value: string | undefined, label: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

export function optionalText(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

export function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

export function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function stringOrNull(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeCodebaseRole(value: unknown, fallback: CodebaseRole): CodebaseRole {
  return value === "owner" || value === "maintainer" || value === "member" || value === "viewer"
    ? value
    : fallback;
}

export function scopeForPath(filePath: string) {
  return filePath === ".private" || filePath.startsWith(".private/") ? "owner-private" : "shared";
}

export function userIdFromIdentity(identity: AuthIdentity) {
  const subject = stringOrNull(identity.subject);
  if (subject) return subject;

  return tokenIdentifierFromIdentity(identity);
}

export function requireConfiguredOwnerEmail(actor: AccessActor) {
  const expectedEmail = normalizeEmail(process.env.HOPIT_OWNER_EMAIL);
  if (!expectedEmail) {
    throw new Error("HOPIT_OWNER_EMAIL must be configured before a codebase owner can be claimed.");
  }
  if (actor.kind !== "user") {
    throw new Error("A human authenticated user is required to claim codebase ownership.");
  }
  if (actor.currentAuthEmailVerified !== true) {
    throw new Error("A verified account email is required to claim codebase ownership.");
  }
  if (normalizeEmail(actor.primaryEmail) !== expectedEmail) {
    throw new Error("Authenticated account email is not allowed to claim codebase ownership.");
  }
}

function tokenIdentifierFromIdentity(identity: AuthIdentity) {
  const tokenIdentifier = stringOrNull(identity.tokenIdentifier);
  if (tokenIdentifier) return tokenIdentifier;

  const subject = stringOrNull(identity.subject);
  if (!subject) throw new Error("Authenticated identity is missing a subject.");
  return `${stringOrNull(identity.issuer) ?? "unknown"}|${subject}`;
}

function permissionsForRole(role: AccessRole): Capability[] {
  if (role === "owner") return ["read", "write", "invite", "manage_members", "review", "merge", "release"];
  if (role === "maintainer") return ["read", "write", "invite", "review", "merge", "release"];
  if (role === "member") return ["read", "write", "review"];
  if (role === "viewer") return ["read"];
  return [];
}

function countPathScopes(paths: string[]) {
  return paths.reduce(
    (counts, filePath) => {
      if (scopeForPath(filePath) === "owner-private") counts.private += 1;
      else counts.shared += 1;
      return counts;
    },
    { shared: 0, private: 0 },
  );
}

function effectiveChangeSetVisibilityForSource(source: AccessSource) {
  const selectedState = source.selectedState as any;
  const visibility = source.visibility as any;
  return selectedState?.effectiveVisibility ?? visibility?.effective ?? "private";
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
