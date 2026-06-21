import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  actorAuditId,
  optionalText,
  requireCodebaseCapabilityForActor,
  requireText,
  resolveReadActor,
  resolveWriteActor,
  uniqueStrings,
} from "./access";

const tokenArg = v.optional(v.string());
const issueStatus = v.union(v.literal("open"), v.literal("closed"));
const issuePriority = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));
const projectStatus = v.union(v.literal("active"), v.literal("archived"));
const discussionCategory = v.union(
  v.literal("general"),
  v.literal("ideas"),
  v.literal("q-and-a"),
  v.literal("announcements"),
);
const discussionStatus = v.union(
  v.literal("open"),
  v.literal("answered"),
  v.literal("locked"),
  v.literal("closed"),
);
const releaseStatus = v.union(v.literal("draft"), v.literal("published"), v.literal("archived"));
const releaseTarget = v.object({
  type: v.union(v.literal("main"), v.literal("snapshot"), v.literal("change-set"), v.literal("git")),
  id: v.string(),
  revision: v.optional(v.number()),
});
const projectItem = v.union(
  v.object({ type: v.literal("issue"), id: v.id("issues") }),
  v.object({ type: v.literal("discussion"), id: v.id("discussions") }),
  v.object({ type: v.literal("release"), id: v.id("releases") }),
  v.object({
    type: v.literal("note"),
    title: v.string(),
    body: v.optional(v.string()),
  }),
);

type CollaborationScope = "issue" | "project" | "discussion" | "release";

export const listIssues = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(issueStatus),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "read");

    const status = args.status;
    const rows =
      status === undefined
        ? await ctx.db
            .query("issues")
            .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
            .collect()
        : await ctx.db
            .query("issues")
            .withIndex("by_codebase_status", (q) => q.eq("codebaseId", args.codebaseId).eq("status", status))
            .collect();

    return newestFirst(rows);
  },
});

export const createIssue = mutation({
  args: {
    codebaseId: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    priority: v.optional(issuePriority),
    labels: v.optional(v.array(v.string())),
    assigneeIds: v.optional(v.array(v.string())),
    linkedChangeSetId: v.optional(v.string()),
    linkedReleaseId: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "write");

    const now = new Date().toISOString();
    const number = await allocateNumber(ctx, args.codebaseId, "issue", now);
    const id = await ctx.db.insert("issues", {
      codebaseId: args.codebaseId,
      number,
      title: requireText(args.title, "Issue title"),
      body: optionalText(args.body),
      status: "open",
      priority: args.priority,
      labels: uniqueStrings(args.labels ?? []),
      assigneeIds: uniqueStrings(args.assigneeIds ?? []),
      linkedChangeSetId: optionalText(args.linkedChangeSetId),
      linkedReleaseId: optionalText(args.linkedReleaseId),
      createdBy: actorAuditId(actor, args.createdBy, "Issue creator"),
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(id);
  },
});

export const setIssueStatus = mutation({
  args: {
    issueId: v.id("issues"),
    status: issueStatus,
    updatedBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const issue = await requireDoc(ctx, args.issueId, "Issue");
    await requireCodebaseCapabilityForActor(ctx, issue.codebaseId, actor, "write");
    const now = new Date().toISOString();
    await ctx.db.patch(args.issueId, {
      status: args.status,
      updatedBy: actorAuditId(actor, args.updatedBy, "Issue updater"),
      updatedAt: now,
      closedAt: args.status === "closed" ? now : undefined,
    });

    return await ctx.db.get(args.issueId);
  },
});

export const listIssueComments = query({
  args: {
    issueId: v.id("issues"),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    const issue = await requireDoc(ctx, args.issueId, "Issue");
    await requireCodebaseCapabilityForActor(ctx, issue.codebaseId, actor, "read");

    return await ctx.db
      .query("issueComments")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .collect();
  },
});

export const addIssueComment = mutation({
  args: {
    issueId: v.id("issues"),
    body: v.string(),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const issue = await requireDoc(ctx, args.issueId, "Issue");
    await requireCodebaseCapabilityForActor(ctx, issue.codebaseId, actor, "write");
    const now = new Date().toISOString();
    const id = await ctx.db.insert("issueComments", {
      codebaseId: issue.codebaseId,
      issueId: args.issueId,
      body: requireText(args.body, "Issue comment"),
      createdBy: actorAuditId(actor, args.createdBy, "Issue comment creator"),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.issueId, { updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const listProjects = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(projectStatus),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "read");

    const status = args.status;
    const rows =
      status === undefined
        ? await ctx.db
            .query("projects")
            .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
            .collect()
        : await ctx.db
            .query("projects")
            .withIndex("by_codebase_status", (q) => q.eq("codebaseId", args.codebaseId).eq("status", status))
            .collect();

    return newestFirst(rows);
  },
});

export const createProject = mutation({
  args: {
    codebaseId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    columns: v.optional(v.array(v.string())),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "write");

    const now = new Date().toISOString();
    const number = await allocateNumber(ctx, args.codebaseId, "project", now);
    const id = await ctx.db.insert("projects", {
      codebaseId: args.codebaseId,
      number,
      name: requireText(args.name, "Project name"),
      description: optionalText(args.description),
      status: "active",
      columns: buildColumns(args.columns),
      createdBy: actorAuditId(actor, args.createdBy, "Project creator"),
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(id);
  },
});

export const setProjectStatus = mutation({
  args: {
    projectId: v.id("projects"),
    status: projectStatus,
    updatedBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const project = await requireDoc(ctx, args.projectId, "Project");
    await requireCodebaseCapabilityForActor(ctx, project.codebaseId, actor, "write");
    const now = new Date().toISOString();
    await ctx.db.patch(args.projectId, {
      status: args.status,
      updatedBy: actorAuditId(actor, args.updatedBy, "Project updater"),
      updatedAt: now,
      archivedAt: args.status === "archived" ? now : undefined,
    });

    return await ctx.db.get(args.projectId);
  },
});

export const listProjectItems = query({
  args: {
    projectId: v.id("projects"),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    const project = await requireDoc(ctx, args.projectId, "Project");
    await requireCodebaseCapabilityForActor(ctx, project.codebaseId, actor, "read");

    const rows = await ctx.db
      .query("projectItems")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    return rows.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  },
});

export const addProjectItem = mutation({
  args: {
    projectId: v.id("projects"),
    item: projectItem,
    columnId: v.string(),
    position: v.optional(v.number()),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const project = await requireDoc(ctx, args.projectId, "Project");
    await requireCodebaseCapabilityForActor(ctx, project.codebaseId, actor, "write");
    ensureProjectColumn(project, args.columnId);
    await ensureProjectItemBelongsToCodebase(ctx, project.codebaseId, args.item);

    const now = new Date().toISOString();
    const id = await ctx.db.insert("projectItems", {
      codebaseId: project.codebaseId,
      projectId: args.projectId,
      item: normalizeProjectItem(args.item),
      columnId: args.columnId,
      position: args.position ?? Date.now(),
      createdBy: actorAuditId(actor, args.createdBy, "Project item creator"),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.projectId, { updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const listDiscussions = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(discussionStatus),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "read");

    const status = args.status;
    const rows =
      status === undefined
        ? await ctx.db
            .query("discussions")
            .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
            .collect()
        : await ctx.db
            .query("discussions")
            .withIndex("by_codebase_status", (q) => q.eq("codebaseId", args.codebaseId).eq("status", status))
            .collect();

    return newestFirst(rows);
  },
});

export const createDiscussion = mutation({
  args: {
    codebaseId: v.string(),
    title: v.string(),
    body: v.string(),
    category: v.optional(discussionCategory),
    labels: v.optional(v.array(v.string())),
    linkedIssueIds: v.optional(v.array(v.id("issues"))),
    linkedChangeSetId: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "write");
    await ensureIssuesBelongToCodebase(ctx, args.codebaseId, args.linkedIssueIds ?? []);

    const now = new Date().toISOString();
    const number = await allocateNumber(ctx, args.codebaseId, "discussion", now);
    const id = await ctx.db.insert("discussions", {
      codebaseId: args.codebaseId,
      number,
      title: requireText(args.title, "Discussion title"),
      body: requireText(args.body, "Discussion body"),
      category: args.category ?? "general",
      status: "open",
      labels: uniqueStrings(args.labels ?? []),
      linkedIssueIds: args.linkedIssueIds ?? [],
      linkedChangeSetId: optionalText(args.linkedChangeSetId),
      createdBy: actorAuditId(actor, args.createdBy, "Discussion creator"),
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(id);
  },
});

export const setDiscussionStatus = mutation({
  args: {
    discussionId: v.id("discussions"),
    status: discussionStatus,
    updatedBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const discussion = await requireDoc(ctx, args.discussionId, "Discussion");
    await requireCodebaseCapabilityForActor(ctx, discussion.codebaseId, actor, "write");
    const now = new Date().toISOString();
    await ctx.db.patch(args.discussionId, {
      status: args.status,
      updatedBy: actorAuditId(actor, args.updatedBy, "Discussion updater"),
      updatedAt: now,
      closedAt: args.status === "closed" ? now : undefined,
    });

    return await ctx.db.get(args.discussionId);
  },
});

export const listDiscussionComments = query({
  args: {
    discussionId: v.id("discussions"),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    const discussion = await requireDoc(ctx, args.discussionId, "Discussion");
    await requireCodebaseCapabilityForActor(ctx, discussion.codebaseId, actor, "read");

    return await ctx.db
      .query("discussionComments")
      .withIndex("by_discussion", (q) => q.eq("discussionId", args.discussionId))
      .collect();
  },
});

export const addDiscussionComment = mutation({
  args: {
    discussionId: v.id("discussions"),
    body: v.string(),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const discussion = await requireDoc(ctx, args.discussionId, "Discussion");
    await requireCodebaseCapabilityForActor(ctx, discussion.codebaseId, actor, "write");
    if (discussion.status === "locked") {
      throw new Error("Discussion is locked.");
    }

    const now = new Date().toISOString();
    const id = await ctx.db.insert("discussionComments", {
      codebaseId: discussion.codebaseId,
      discussionId: args.discussionId,
      body: requireText(args.body, "Discussion comment"),
      createdBy: actorAuditId(actor, args.createdBy, "Discussion comment creator"),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.discussionId, { updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const listReleases = query({
  args: {
    codebaseId: v.string(),
    status: v.optional(releaseStatus),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "read");

    const status = args.status;
    const rows =
      status === undefined
        ? await ctx.db
            .query("releases")
            .withIndex("by_codebase", (q) => q.eq("codebaseId", args.codebaseId))
            .collect()
        : await ctx.db
            .query("releases")
            .withIndex("by_codebase_status", (q) => q.eq("codebaseId", args.codebaseId).eq("status", status))
            .collect();

    return newestFirst(rows);
  },
});

export const createRelease = mutation({
  args: {
    codebaseId: v.string(),
    version: v.string(),
    title: v.string(),
    notes: v.string(),
    status: v.optional(releaseStatus),
    target: v.optional(releaseTarget),
    provenance: v.optional(v.any()),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);
    await requireCodebaseCapabilityForActor(ctx, args.codebaseId, actor, "release");

    const version = requireText(args.version, "Release version");
    const existing = await ctx.db
      .query("releases")
      .withIndex("by_codebase_version", (q) => q.eq("codebaseId", args.codebaseId).eq("version", version))
      .unique();
    if (existing) {
      throw new Error(`Release ${version} already exists for ${args.codebaseId}.`);
    }

    const now = new Date().toISOString();
    const status = args.status ?? "draft";
    const number = await allocateNumber(ctx, args.codebaseId, "release", now);
    const id = await ctx.db.insert("releases", {
      codebaseId: args.codebaseId,
      number,
      version,
      title: requireText(args.title, "Release title"),
      notes: requireText(args.notes, "Release notes"),
      status,
      target: args.target ?? { type: "main", id: "main" },
      provenance: args.provenance,
      createdBy: actorAuditId(actor, args.createdBy, "Release creator"),
      createdAt: now,
      updatedAt: now,
      publishedAt: status === "published" ? now : undefined,
    });

    return await ctx.db.get(id);
  },
});

export const publishRelease = mutation({
  args: {
    releaseId: v.id("releases"),
    updatedBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const release = await requireDoc(ctx, args.releaseId, "Release");
    await requireCodebaseCapabilityForActor(ctx, release.codebaseId, actor, "release");
    const now = new Date().toISOString();
    await ctx.db.patch(args.releaseId, {
      status: "published",
      updatedBy: actorAuditId(actor, args.updatedBy, "Release publisher"),
      updatedAt: now,
      publishedAt: now,
    });

    return await ctx.db.get(args.releaseId);
  },
});

export const listReleaseAssets = query({
  args: {
    releaseId: v.id("releases"),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveReadActor(ctx, args.token);
    const release = await requireDoc(ctx, args.releaseId, "Release");
    await requireCodebaseCapabilityForActor(ctx, release.codebaseId, actor, "read");

    return await ctx.db
      .query("releaseAssets")
      .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId))
      .collect();
  },
});

export const addReleaseAsset = mutation({
  args: {
    releaseId: v.id("releases"),
    name: v.string(),
    kind: v.union(v.literal("artifact"), v.literal("source-archive"), v.literal("note")),
    url: v.optional(v.string()),
    size: v.optional(v.number()),
    checksum: v.optional(v.string()),
    createdBy: v.optional(v.string()),
    token: tokenArg,
  },
  handler: async (ctx, args) => {
    const actor = await resolveWriteActor(ctx, args.token);

    const release = await requireDoc(ctx, args.releaseId, "Release");
    await requireCodebaseCapabilityForActor(ctx, release.codebaseId, actor, "release");
    const id = await ctx.db.insert("releaseAssets", {
      codebaseId: release.codebaseId,
      releaseId: args.releaseId,
      name: requireText(args.name, "Release asset name"),
      kind: args.kind,
      url: optionalText(args.url),
      size: args.size,
      checksum: optionalText(args.checksum),
      createdBy: actorAuditId(actor, args.createdBy, "Release asset creator"),
      createdAt: new Date().toISOString(),
    });

    return await ctx.db.get(id);
  },
});

async function allocateNumber(ctx: any, codebaseId: string, scope: CollaborationScope, now: string) {
  const existing = await ctx.db
    .query("collaborationCounters")
    .withIndex("by_codebase_scope", (q: any) => q.eq("codebaseId", codebaseId).eq("scope", scope))
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      nextNumber: existing.nextNumber + 1,
      updatedAt: now,
    });
    return existing.nextNumber;
  }

  await ctx.db.insert("collaborationCounters", {
    codebaseId,
    scope,
    nextNumber: 2,
    updatedAt: now,
  });
  return 1;
}

async function requireDoc(ctx: any, id: string, label: string) {
  const doc = await ctx.db.get(id);
  if (!doc) {
    throw new Error(`${label} not found.`);
  }
  return doc;
}

function newestFirst<T extends { updatedAt: string; number?: number }>(rows: T[]) {
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.number ?? 0) - (a.number ?? 0));
}

function buildColumns(columnNames: string[] | undefined) {
  const names = columnNames?.length ? columnNames : ["Todo", "In progress", "Done"];
  return names.map((name, index) => ({
    id: `column-${index + 1}`,
    name: requireText(name, "Project column name"),
    position: index,
  }));
}

function ensureProjectColumn(project: { columns: Array<{ id: string }> }, columnId: string) {
  if (!project.columns.some((column) => column.id === columnId)) {
    throw new Error(`Project column ${columnId} not found.`);
  }
}

async function ensureProjectItemBelongsToCodebase(ctx: any, codebaseId: string, item: any) {
  if (item.type === "note") return;

  const doc = await requireDoc(ctx, item.id, "Project item target");
  if (doc.codebaseId !== codebaseId) {
    throw new Error("Project item target belongs to a different codebase.");
  }
}

function normalizeProjectItem(item: any) {
  if (item.type !== "note") return item;
  return {
    type: "note",
    title: requireText(item.title, "Project note title"),
    body: optionalText(item.body),
  };
}

async function ensureIssuesBelongToCodebase(ctx: any, codebaseId: string, issueIds: string[]) {
  for (const issueId of issueIds) {
    const issue = await requireDoc(ctx, issueId, "Linked issue");
    if (issue.codebaseId !== codebaseId) {
      throw new Error("Linked issue belongs to a different codebase.");
    }
  }
}
