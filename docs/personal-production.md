# Personal Production Runbook

This runbook is the first real-use path for one-person HopIt dogfooding. It keeps the local JSON graph as a development fallback, but treats Convex as the canonical cloud graph and Vercel as a protected, read-only dashboard.

## Current Deployment

- Vercel production dashboard: `https://hopit-ten.vercel.app`
- Vercel project: `robertg761s-projects/hopit`
- Convex project: `robertgordon761/hopit`
- Convex dev URL: `https://vibrant-ermine-445.convex.cloud`
- Convex production URL: `https://sincere-jaguar-17.convex.cloud`
- Seeded codebase id: `hopit`
- Production workspace: `/Users/robert/HopIt Workspaces/hopit`

## Required Configuration

Use long random secrets. Do not commit `.env.local`.

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_AGENT_TOKEN=<long-random-agent-token>
HOPIT_CONVEX_URL=https://<deployment>.convex.cloud
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
HOPIT_DASHBOARD_USERNAME=hopit
HOPIT_DASHBOARD_PASSWORD=<long-random-dashboard-password>
HOPIT_AGENT_STATE_ROOT="$HOME/Library/Application Support/HopIt/Agent"
HOPIT_WORKSPACE_ROOT="$HOME/HopIt Workspaces"
```

Validate local configuration without printing secrets:

```bash
npm run check:production-config
```

## Convex Backend

Deploy or update the Convex functions, then make the agent token mandatory in Convex:

```bash
npm run convex:dev
npx convex env set HOPIT_AGENT_TOKEN "$HOPIT_AGENT_TOKEN"
```

Convex functions now fail closed when `HOPIT_AGENT_TOKEN` is missing. `HOPIT_ALLOW_UNAUTHENTICATED_AGENT=1` exists only as a deliberate local-development escape hatch.

## Vercel Dashboard

Set these Vercel environment variables for Production, Preview, and Development unless a narrower scope is intentional:

```text
HOPIT_CODEBASE_ID
HOPIT_AGENT_TOKEN
HOPIT_CONVEX_URL
NEXT_PUBLIC_CONVEX_URL
HOPIT_DASHBOARD_USERNAME
HOPIT_DASHBOARD_PASSWORD
```

Hosted HopIt requires Convex-backed status. The `/api/agent/command` route refuses local workspace commands on Vercel, and `src/proxy.ts` requires Basic authentication when deployed on Vercel. Vercel Deployment Protection can be enabled as an additional account-level guard.

Pull Vercel envs locally only after the project is linked:

```bash
vercel link
vercel env pull .env.local --yes --environment=production
```

## Local Agent Service

Import one real project into Convex and hydrate a production-profile managed workspace:

```bash
npm exec -- hop import \
  --profile production \
  --source /path/to/project \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --force
```

Start the local agent service. It runs the watcher and local status server from one background process, writes a pid file under the agent state root, and binds status to `127.0.0.1:4785` by default.

```bash
npm exec -- hop service start \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN"

npm exec -- hop service status --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm exec -- hop service stop --profile production --codebase-id "$HOPIT_CODEBASE_ID"
```

Production-profile defaults keep state and workspaces out of the source checkout:

- macOS state: `~/Library/Application Support/HopIt/Agent`
- Linux state: `${XDG_STATE_HOME:-~/.local/state}/hopit/agent`
- workspace root: `~/HopIt Workspaces`

## Git Escape Hatch

Before trusting HopIt with valuable work, keep Git export/publish available.

```bash
npm exec -- hop validate --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm exec -- hop export --profile production --codebase-id "$HOPIT_CODEBASE_ID" --output /path/to/export --force
```

`export` omits `.private/` by default. Use `--include-private` only for an owner-private backup. `publish` is stricter: it requires a reviewed and merged active change set and always omits `.private/`.

```bash
npm exec -- hop review --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm exec -- hop merge --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm exec -- hop publish --profile production --codebase-id "$HOPIT_CODEBASE_ID" --output /path/to/publish --force
```

## Current Limits

- Hosted dashboard commands are intentionally disabled; local workspace commands run through the local agent.
- Basic Auth is only the current deployment guard. The repo now has Clerk-backed product auth, durable users, memberships, invitations, and first server-side permission checks, but the production deployment still needs real Clerk env vars before Basic Auth can be retired.
- Convex stores prototype file content and metadata, not a split database/blob-storage production architecture yet.
- Git export/publish creates a clean local Git repo; it does not push to a remote.
- The dashboard now has a first read-only code browser plus issue, discussion, release, and member/invite surfaces. Real diffs, inline review comments, durable merge records, project boards, richer release artifacts, and push-style live updates remain future work.
