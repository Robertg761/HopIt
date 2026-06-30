import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const changeSetVisibility = v.union(
  v.literal("private"),
  v.literal("team-visible"),
  v.literal("review-visible"),
);

const codebaseRole = v.union(
  v.literal("owner"),
  v.literal("maintainer"),
  v.literal("member"),
  v.literal("viewer"),
);

const memberStatus = v.union(v.literal("active"), v.literal("suspended"));
const invitationStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("revoked"),
  v.literal("expired"),
);
const privacyZoneKind = v.union(
  v.literal("repo-content"),
  v.literal("owner-private"),
  v.literal("secrets"),
  v.literal("git-internals"),
  v.literal("public-snapshot"),
);
const privacyZoneStatus = v.union(v.literal("active"), v.literal("rotating"), v.literal("retired"));
const deviceKeyStatus = v.union(
  v.literal("pending"),
  v.literal("trusted"),
  v.literal("revoked"),
  v.literal("lost"),
);
const keyringStatus = v.union(v.literal("active"), v.literal("disabled"));
const wrappedKeyType = v.union(
  v.literal("user-vault"),
  v.literal("repo-content"),
  v.literal("owner-private"),
  v.literal("git-internals"),
  v.literal("secret-group"),
  v.literal("file-dek"),
);
const wrappedKeyRecipientType = v.union(
  v.literal("device"),
  v.literal("user"),
  v.literal("recovery"),
);
const wrappedKeyStatus = v.union(v.literal("active"), v.literal("revoked"), v.literal("expired"));
const actionJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export default defineSchema({
  users: defineTable({
    userId: v.string(),
    primaryEmail: v.optional(v.string()),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    globalDefaultChangeSetVisibility: v.optional(changeSetVisibility),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_user_id", ["userId"])
    .index("by_primary_email", ["primaryEmail"]),

  authIdentities: defineTable({
    userId: v.string(),
    tokenIdentifier: v.string(),
    issuer: v.string(),
    subject: v.string(),
    email: v.optional(v.string()),
    emailVerified: v.optional(v.boolean()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_token_identifier", ["tokenIdentifier"])
    .index("by_issuer_subject", ["issuer", "subject"])
    .index("by_user", ["userId"]),

  codebases: defineTable({
    codebaseId: v.string(),
    name: v.string(),
    ownerId: v.string(),
    schemaVersion: v.number(),
    revision: v.number(),
    main: v.any(),
    selectedState: v.any(),
    owner: v.any(),
    collaborators: v.array(v.any()),
    session: v.any(),
    visibility: v.any(),
    fileCount: v.optional(v.number()),
    privateFileCount: v.optional(v.number()),
    memberCount: v.optional(v.number()),
    updatedAt: v.string(),
  })
    .index("by_codebase_id", ["codebaseId"])
    .index("by_owner", ["ownerId"]),

  codebaseMembers: defineTable({
    codebaseId: v.string(),
    userId: v.string(),
    role: codebaseRole,
    status: memberStatus,
    invitedByUserId: v.optional(v.string()),
    source: v.optional(v.string()),
    joinedAt: v.optional(v.string()),
    suspendedByUserId: v.optional(v.string()),
    suspendedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_user", ["codebaseId", "userId"])
    .index("by_user", ["userId"]),

  codebaseInvitations: defineTable({
    codebaseId: v.string(),
    normalizedEmail: v.string(),
    role: codebaseRole,
    tokenHash: v.string(),
    status: invitationStatus,
    invitedByUserId: v.string(),
    acceptedByUserId: v.optional(v.string()),
    revokedByUserId: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
    acceptedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_email", ["codebaseId", "normalizedEmail"])
    .index("by_email_status", ["normalizedEmail", "status"])
    .index("by_token_hash", ["tokenHash"]),

  agentSessions: defineTable({
    userId: v.string(),
    sessionId: v.string(),
    codebaseId: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    tokenPrefix: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
    expiresAt: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.string(),
    lastSeenAt: v.string(),
    updatedAt: v.optional(v.string()),
    revokedByUserId: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
  })
    .index("by_session_id", ["sessionId"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_user", ["userId"])
    .index("by_codebase", ["codebaseId"]),

  privacyZones: defineTable({
    zoneId: v.string(),
    codebaseId: v.string(),
    kind: privacyZoneKind,
    pathPrefix: v.string(),
    matchPriority: v.number(),
    defaultGrantPolicy: v.string(),
    currentKeyId: v.optional(v.union(v.string(), v.null())),
    currentKeyVersion: v.optional(v.union(v.number(), v.null())),
    status: privacyZoneStatus,
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_zone_id", ["zoneId"])
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_kind", ["codebaseId", "kind"]),

  deviceKeys: defineTable({
    deviceId: v.string(),
    userId: v.string(),
    displayName: v.optional(v.string()),
    platform: v.optional(v.string()),
    encryptionPublicKey: v.string(),
    encryptionPublicKeyAlgorithm: v.string(),
    encryptionPublicKeyEncoding: v.string(),
    signingPublicKey: v.optional(v.string()),
    signingPublicKeyAlgorithm: v.optional(v.string()),
    signingPublicKeyEncoding: v.optional(v.string()),
    status: deviceKeyStatus,
    createdAt: v.string(),
    trustedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    lastSeenAt: v.optional(v.string()),
  })
    .index("by_device_id", ["deviceId"])
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  userKeyrings: defineTable({
    userId: v.string(),
    vaultKeyId: v.string(),
    currentVersion: v.number(),
    status: keyringStatus,
    recoveryConfigured: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_user", ["userId"]),

  codebaseKeyrings: defineTable({
    codebaseId: v.string(),
    repoContentKeyId: v.string(),
    ownerPrivateKeyId: v.string(),
    gitInternalsKeyId: v.string(),
    defaultSecretKeyId: v.string(),
    rotationState: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_codebase", ["codebaseId"]),

  wrappedKeys: defineTable({
    wrapId: v.string(),
    wrappedKeyId: v.string(),
    wrappedKeyType,
    keyVersion: v.number(),
    recipientType: wrappedKeyRecipientType,
    recipientId: v.string(),
    codebaseId: v.optional(v.string()),
    zoneId: v.optional(v.string()),
    wrappingKeyId: v.optional(v.string()),
    wrappingPublicKeyId: v.optional(v.string()),
    algorithm: v.string(),
    ciphertext: v.string(),
    createdByUserId: v.optional(v.string()),
    createdByDeviceId: v.optional(v.string()),
    createdAt: v.string(),
    expiresAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    status: wrappedKeyStatus,
  })
    .index("by_wrap_id", ["wrapId"])
    .index("by_wrapped_key", ["wrappedKeyId"])
    .index("by_recipient", ["recipientType", "recipientId"])
    .index("by_codebase", ["codebaseId"])
    .index("by_zone", ["zoneId"]),

  keyAuditEvents: defineTable({
    eventId: v.string(),
    codebaseId: v.optional(v.string()),
    actorUserId: v.optional(v.string()),
    actorDeviceId: v.optional(v.string()),
    eventType: v.string(),
    targetUserId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    zoneId: v.optional(v.string()),
    keyId: v.optional(v.string()),
    wrapId: v.optional(v.string()),
    createdAt: v.string(),
    signature: v.optional(v.string()),
    signatureAlgorithm: v.optional(v.string()),
  })
    .index("by_event_id", ["eventId"])
    .index("by_codebase", ["codebaseId"])
    .index("by_actor_user", ["actorUserId"])
    .index("by_zone", ["zoneId"]),

  files: defineTable({
    codebaseId: v.string(),
    path: v.string(),
    kind: v.optional(v.union(v.literal("file"), v.literal("symlink"), v.literal("directory"))),
    content: v.string(),
    encoding: v.optional(v.union(v.literal("utf8"), v.literal("base64"))),
    target: v.optional(v.union(v.string(), v.null())),
    blobHash: v.optional(v.string()),
    blobProvider: v.optional(v.union(v.string(), v.null())),
    blobKey: v.optional(v.union(v.string(), v.null())),
    blobSize: v.optional(v.union(v.number(), v.null())),
    clientEncryption: v.optional(v.union(v.any(), v.null())),
    encryption: v.optional(v.union(v.any(), v.null())),
    privacyZone: v.optional(privacyZoneKind),
    zoneId: v.optional(v.union(v.string(), v.null())),
    contentStorage: v.optional(v.string()),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
    scope: v.union(v.literal("shared"), v.literal("owner-private")),
    revision: v.number(),
    updatedAt: v.string(),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_path", ["codebaseId", "path"]),

  fileBlobs: defineTable({
    codebaseId: v.string(),
    hash: v.string(),
    content: v.string(),
    encoding: v.optional(v.union(v.literal("utf8"), v.literal("base64"))),
    size: v.number(),
    createdAt: v.string(),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_hash", ["codebaseId", "hash"]),

  agentEvents: defineTable({
    codebaseId: v.string(),
    event: v.string(),
    detail: v.any(),
    at: v.string(),
    source: v.optional(v.string()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_at", ["codebaseId", "at"]),

  actionJobs: defineTable({
    jobId: v.string(),
    codebaseId: v.string(),
    kind: v.string(),
    command: v.string(),
    args: v.optional(v.array(v.string())),
    status: actionJobStatus,
    requestedByUserId: v.string(),
    runnerId: v.optional(v.string()),
    exitCode: v.optional(v.union(v.number(), v.null())),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    summary: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    claimedAt: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    finishedAt: v.optional(v.string()),
  })
    .index("by_job_id", ["jobId"])
    .index("by_status_created", ["status", "createdAt"])
    .index("by_codebase_created", ["codebaseId", "createdAt"])
    .index("by_codebase_status", ["codebaseId", "status"]),

  collaborationCounters: defineTable({
    codebaseId: v.string(),
    scope: v.union(
      v.literal("issue"),
      v.literal("project"),
      v.literal("discussion"),
      v.literal("release"),
    ),
    nextNumber: v.number(),
    updatedAt: v.string(),
  }).index("by_codebase_scope", ["codebaseId", "scope"]),

  issues: defineTable({
    codebaseId: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("closed")),
    priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"))),
    labels: v.array(v.string()),
    assigneeIds: v.array(v.string()),
    linkedChangeSetId: v.optional(v.string()),
    linkedReleaseId: v.optional(v.string()),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    closedAt: v.optional(v.string()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_status", ["codebaseId", "status"])
    .index("by_codebase_number", ["codebaseId", "number"]),

  issueComments: defineTable({
    codebaseId: v.string(),
    issueId: v.id("issues"),
    body: v.string(),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_issue", ["issueId"])
    .index("by_codebase", ["codebaseId"]),

  projects: defineTable({
    codebaseId: v.string(),
    number: v.number(),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("active"), v.literal("archived")),
    columns: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
        position: v.number(),
      }),
    ),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    archivedAt: v.optional(v.string()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_status", ["codebaseId", "status"])
    .index("by_codebase_number", ["codebaseId", "number"]),

  discussions: defineTable({
    codebaseId: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    category: v.union(
      v.literal("general"),
      v.literal("ideas"),
      v.literal("q-and-a"),
      v.literal("announcements"),
    ),
    status: v.union(v.literal("open"), v.literal("answered"), v.literal("locked"), v.literal("closed")),
    labels: v.array(v.string()),
    linkedIssueIds: v.array(v.id("issues")),
    linkedChangeSetId: v.optional(v.string()),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    closedAt: v.optional(v.string()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_status", ["codebaseId", "status"])
    .index("by_codebase_number", ["codebaseId", "number"]),

  discussionComments: defineTable({
    codebaseId: v.string(),
    discussionId: v.id("discussions"),
    body: v.string(),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_discussion", ["discussionId"])
    .index("by_codebase", ["codebaseId"]),

  releases: defineTable({
    codebaseId: v.string(),
    number: v.number(),
    version: v.string(),
    title: v.string(),
    notes: v.string(),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("archived")),
    target: v.object({
      type: v.union(v.literal("main"), v.literal("snapshot"), v.literal("change-set"), v.literal("git")),
      id: v.string(),
      revision: v.optional(v.number()),
    }),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
    publishedAt: v.optional(v.string()),
    provenance: v.optional(v.any()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_status", ["codebaseId", "status"])
    .index("by_codebase_version", ["codebaseId", "version"])
    .index("by_codebase_number", ["codebaseId", "number"]),

  releaseAssets: defineTable({
    codebaseId: v.string(),
    releaseId: v.id("releases"),
    name: v.string(),
    kind: v.union(v.literal("artifact"), v.literal("source-archive"), v.literal("note")),
    url: v.optional(v.string()),
    size: v.optional(v.number()),
    checksum: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.string(),
  })
    .index("by_release", ["releaseId"])
    .index("by_codebase", ["codebaseId"]),

  projectItems: defineTable({
    codebaseId: v.string(),
    projectId: v.id("projects"),
    item: v.union(
      v.object({ type: v.literal("issue"), id: v.id("issues") }),
      v.object({ type: v.literal("discussion"), id: v.id("discussions") }),
      v.object({ type: v.literal("release"), id: v.id("releases") }),
      v.object({
        type: v.literal("note"),
        title: v.string(),
        body: v.optional(v.string()),
      }),
    ),
    columnId: v.string(),
    position: v.number(),
    createdBy: v.string(),
    updatedBy: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_project", ["projectId"])
    .index("by_codebase", ["codebaseId"]),
});
