import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
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
    updatedAt: v.string(),
  }).index("by_codebase_id", ["codebaseId"]),

  files: defineTable({
    codebaseId: v.string(),
    path: v.string(),
    content: v.string(),
    hash: v.optional(v.string()),
    size: v.optional(v.number()),
    scope: v.union(v.literal("shared"), v.literal("owner-private")),
    revision: v.number(),
    updatedAt: v.string(),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_path", ["codebaseId", "path"]),

  agentEvents: defineTable({
    codebaseId: v.string(),
    event: v.string(),
    detail: v.any(),
    at: v.string(),
    source: v.optional(v.string()),
  })
    .index("by_codebase", ["codebaseId"])
    .index("by_codebase_at", ["codebaseId", "at"]),
});
