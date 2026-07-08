# WS7a Push Remote-Update Delivery Design

This document completes the design-first WS7a gate from [HopIt Remediation Plan July 2026](remediation-plan-2026-07.md). Implementation should start only after owner approval. The goal is to replace activity-gated cooldown polling with push delivery while preserving the current journal-clean and manifest-clean safety gates from [Local Agent Architecture](agent-architecture.md).

## Goal

Same-owner devices should see acknowledged changes within seconds when they are safe to apply. A device with pending journal entries, failed recovery, partial materialization, metadata-only state, or unjournaled local drift must not be overwritten by a pushed update. Push is an acceleration path, not a new authority: D1 remains the graph source of truth, R2 remains the object body store, and the local safety journal remains the source of truth for unacknowledged local work.

The first implementation should ship behind `HOPIT_REMOTE_PUSH=1`. If push setup fails or the socket is disconnected, the agent falls back to the existing `remote-pull` decision path and emits status that distinguishes `push-connected`, `push-disconnected`, `push-fallback-polling`, `push-skipped`, and `push-applied`.

## Options Considered

### Option 1: Durable Object fan-out hub with hibernating WebSockets

Use one Durable Object per codebase as the update hub. The agent opens a WebSocket to the Worker with its codebase id, selected state id, device/session identity, and last seen event cursor. Mutating D1 APIs notify the codebase Durable Object after commit. The Durable Object broadcasts a small event envelope to connected devices:

```json
{
  "type": "codebase.remote_update",
  "codebaseId": "hopit-core",
  "selectedStateId": "cs_demo_active",
  "revision": 42,
  "eventId": "evt_...",
  "changedPaths": ["README.md"],
  "scopeCounts": { "shared": 1, "private": 0 }
}
```

The local agent treats the message as a hint. It reads the graph head, runs the existing `remoteRefreshDecision`, and only calls the safe refresh path when the workspace is fully materialized, journal-clean, and manifest-clean.

This is the preferred path. It has near-zero idle compute when hibernation works, gives direct fan-out for same-owner handoff, and lets the server avoid per-device polling. Cloudflare currently documents Durable Objects on the Workers Free plan with the SQLite backend, and documents that hibernating WebSockets do not incur duration while idle when the object qualifies for hibernation.

### Option 2: Server-Sent Events from a Worker

Expose `/api/codebases/:id/events` as an SSE stream from a Worker. Agents reconnect with `Last-Event-ID`; the server reads D1 events after that cursor and holds the request open for a short window.

SSE is simpler for clients but worse for Cloudflare economics and lifecycle behavior. A long-lived Worker request can keep compute active, and fan-out usually becomes either many held requests or a second coordination primitive. It also has weaker bidirectional health semantics than WebSockets.

SSE should remain a possible fallback for environments where WebSockets are blocked, but not the primary v1 route.

### Option 3: Smarter head-cursor long polling

Keep the current poll design but make it less activity-gated: use a low-frequency head cursor request when idle, faster backoff after recent local activity, and jitter per device. The agent still reads only codebase-level revision metadata before deciding whether a full refresh is needed.

This is the safest fallback because it exists conceptually today. It does not satisfy the "within seconds" handoff requirement without increasing idle requests. It should remain the fallback path when `HOPIT_REMOTE_PUSH` is unset, when the socket cannot connect, or when push has been unhealthy for a bounded interval.

## Recommended Design

Add a `remote-push` transport next to the existing `remote-pull` scheduler.

1. D1 mutation routes commit metadata and object references.
2. After a successful commit, the route sends a codebase event to the Durable Object hub.
3. The hub stores a compact last-event cursor and broadcasts the event envelope to connected devices that have visibility for that codebase.
4. The agent receives the envelope and calls the same decision code that backs `remote-pull`.
5. If the decision says refresh, the agent calls the existing safe refresh path.
6. If the decision says skip, the agent records the skip reason in status and keeps the pushed revision as "known remote" without materializing it.
7. If the socket disconnects, the agent reconnects with exponential backoff and runs one fallback head-cursor pull after reconnect to catch missed events.

The WebSocket message must never include file bytes. It can include revision ids, selected-state ids, changed path summaries, scope counts, and opaque event ids.

## Free-Tier Cost Math

Cloudflare pricing checked on 2026-07-03:

- Workers Free includes limited Workers usage and D1 is available on Free.
- D1 Free includes 5 million rows read per day, 100,000 rows written per day, and 5 GB total storage.
- R2 Standard free tier includes 10 GB-month storage, 1 million Class A operations per month, 10 million Class B operations per month, and free internet egress.
- Durable Objects are available on Workers Free only with SQLite storage. Durable Objects pricing examples show WebSocket hibernation can avoid idle duration; duration is charged when executing JavaScript or when idle without hibernation.

References:

- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>
- <https://developers.cloudflare.com/durable-objects/platform/pricing/>

Personal dogfood estimate:

- 1 user, 1 codebase, 2 devices, 200 file saves per day.
- D1 writes: each sync currently writes file metadata, journal/event rows, and selected-state metadata. Budget at 5 D1 written rows per save = 1,000 rows/day, 1 percent of the D1 Free daily write cap.
- D1 reads: pushed hints cause one graph-head read per remote event on the other device. Budget at 20 rows read per event = 4,000 rows/day, less than 0.1 percent of the D1 Free daily read cap.
- Worker requests: each connected WebSocket setup plus message handling stays small. 2 connection setups/day plus 200 notify requests/day is below normal Free limits.
- Durable Object duration: idle cost should be effectively zero when hibernation is respected. Budget active handling at 200 events/day * 50 ms = 10 seconds/day, before platform granularity.
- R2: unchanged from current sync. 200 object writes/day = about 6,000 Class A ops/month, far under 1 million/month, assuming one object per save.

Small-team estimate:

- 5 users, 3 codebases, 3 devices each, 2,000 file saves per day.
- D1 writes: 10,000 rows/day at 5 rows/save, 10 percent of Free daily writes.
- D1 reads: 2 receiving devices per save * 20 rows = 80,000 rows/day, 1.6 percent of Free daily reads.
- R2 Class A: 60,000 writes/month, 6 percent of Free monthly Class A.
- WebSocket events: 2,000 server notifications plus fan-out messages/day. Still modest; the key risk is not request count, it is accidentally preventing Durable Object hibernation.

Cost guardrails:

- Do not send heartbeat messages more often than necessary. Prefer application-level reconnect/backoff plus periodic lightweight health only when the socket has been quiet for a long interval.
- Use a single Durable Object per codebase, not per device.
- Keep pushed event bodies compact.
- Preserve head-only fallback reads before graph reads.
- Emit counters for pushed events, skipped events, fallback polls, and reconnects so billing regressions are visible.

## Failure Modes

- Socket disconnected: reconnect with exponential backoff, run one fallback `remote-pull` head check, expose `push-disconnected`.
- Durable Object unavailable: stay on poll fallback; do not block local sync.
- Missed event cursor: reconnect sends last seen event id; if the hub cannot replay, agent reads the graph head and catches up through safe refresh.
- Local pending journal: pushed event is recorded as skipped with reason `journal_has_unresolved_entries`.
- Local dirty manifest: pushed event is skipped with reason `workspace_has_unjournaled_changes`.
- Metadata-only or partial workspace: pushed event is skipped unless the implementation explicitly supports path-level materialization for that hydration state.
- Permission or visibility change: pushed event contains no private bytes; refresh reads a visibility-filtered graph as the requester.
- Reordered push events: agent compares graph revisions and only materializes the newest visible graph state.
- Duplicate push events: idempotent because refresh decision compares cursor/materialized revision.
- R2 object not yet visible after D1 metadata commit: safe refresh fails the materialization attempt, emits `remote-push.failed`, and retries through fallback.

## Fixture-Testable Acceptance Plan

Add a local fake push hub to the test suite before binding to Cloudflare:

1. A clean device B receives a pushed revision after device A syncs and applies it within the test wait window.
2. Device B with a pending journal receives a push and emits `remote-push.skipped` without changing disk files.
3. Device B with manifest drift receives a push and emits `remote-push.skipped` without changing disk files.
4. Duplicate push events for the same revision do not rehydrate or duplicate status events.
5. Out-of-order revision hints converge to the newest graph state.
6. Push disconnect followed by fallback head-poll catches up to the missed revision.
7. Metadata-only device B records the remote revision but does not hydrate file bodies.
8. Same-owner `.private/` file changes are applied for the owner and hidden from a collaborator requester.

Production acceptance:

- `HOPIT_REMOTE_PUSH=1` starts the push client in service mode.
- The status API exposes push connection state, last event id, last pushed revision, last applied revision, fallback poll state, and last skip/failure reason.
- The poll path remains available and unchanged when push is disabled.
- Same-owner dogfood handoff applies acknowledged changes within seconds when both devices are clean.
