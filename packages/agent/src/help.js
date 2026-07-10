// @ts-check

export function printHelp() {
  console.log(`hop - HopIt local workspace agent

Commands:
  setup       Interactive first-run onboarding: choose the workspace root and bootstrap local agent config
  init        Seed a local cloud file graph
  import      Import a real local folder into the HopIt graph and hydrate it
  import-git  Production-safe literal Git checkout conversion into HopIt
  import-git-url Clone a remote Git URL, then production-safe import the checkout
  mirror      Literal-copy a local folder into the managed workspace with safety checks
  hydrate     Materialize cloud files into the managed workspace
  refresh     Update the managed workspace from cloud when journal and disk are safe
  remote-pull Run one safe remote refresh decision, matching activity-gated watch/service refresh
  sync        Scan managed-folder writes, journal them, and acknowledge to cloud
  recover     Replay unacknowledged journal entries into the cloud graph
  review      Open the selected active change set for review
  merge       Merge the reviewed selected change set into Main
  export      Export the selected graph state to a clean Git repo
  publish     Export a reviewed and merged change set to a clean Git repo
  validate    Validate the configured cloud graph contract
  doctor      Run a production-oriented local health check
  backup      Write a restorable cloud/status/event backup folder
  install     Prepare production state, workspace, env, and optional launch agent
  workspace   Manage/list/discover/attach the configured HopIt workspace root and codebase
  session     Manage this device/session registration (alias: device)
  keys        Manage local encryption device keys and recovery exports
  storage     Inspect object storage usage and dry-run or execute blob GC
  compare     Compare retained graph revisions as JSON
  service     Manage the local agent service: start, stop, restart, status, run
  watch       Hydrate and watch the workspace for edits
  status      Print read-only local agent status JSON
  serve       Serve read-only local agent status JSON over HTTP
  demo        Run init, hydrate, edit, sync, and verify

Compatibility aliases:
  import-local, import-remote-git, git-url-import, mirror-local, sync-once, review-open, status-server, workspaces, device, devices, sessions, key, keyring

Options:
  --source <path>     Source folder for import
  --url <git-url>     Remote Git URL for import-git-url or import-git --url
  --branch <name>     Branch or tag to clone for remote Git import
  --depth <n>         Optional clone depth for remote Git import
  --git-timeout-ms <n> Remote Git clone timeout, default 600000
  --storage-budget-bytes <n> mirror: maximum encoded bytes before cloud sync is skipped
  --blob-provider <provider> Object blob provider: r2, b2, s3, or filesystem
  --blob-free-only <1|0> Keep provider uploads under the configured free-only budget
  --blob-storage-budget-bytes <n> Maximum existing+new object bytes before upload fails
  --client-encryption-key <key> Local-only 32-byte base64:/hex: key for encrypted secret sync
  --client-encryption-scope <scope> Encrypt secrets, owner-private, all, or off
  --device-keys <path> Override local per-codebase device keyring path
  --recovery-passphrase <secret> One-shot passphrase for keys export-recovery
  --production-safe import-git/mirror: skip cloud sync if routed secrets are not encrypted
  --execute          storage gc/workspace prune: perform planned local removals; default is dry-run
  --launch-agent-label <label> mirror: macOS LaunchAgent label to stop/restart
  --output <path>     Output folder for Git export/publish
  --path <cloud-path> Cloud file/folder path for workspace hydrate-file, hydrate-path, prune, pin, or unpin
  --from <revision>   compare: left retained graph revision
  --to <revision>     compare: right retained graph revision
  --recursive        workspace hydrate-path/pin/unpin/prune: include visible files under a folder prefix
  --with-siblings    workspace hydrate-file: also hydrate nearby source-root siblings within budget
  --open-max-files <n> workspace open: maximum files for open-time hydration, default 64
  --open-max-bytes <n> workspace open: maximum bytes for open-time hydration, default 1048576
  --sibling-max-files <n> workspace hydrate-file --with-siblings: sibling file budget, default 8
  --sibling-max-bytes <n> workspace hydrate-file --with-siblings: sibling byte budget, default 128000
  --inactive-ms <n>  workspace prune: only prune clean cached files inactive for this many ms
  --codebase-id <id>  Codebase id for import
  --codebase-name <name> Codebase display name for import
  --profile <name>    development or production path profile
  --state-root <path> Agent state root for production profile
  --workspace-root <path> Root that contains managed HopIt codebase folders
  --workspace-index <path> Optional workspace root index path
  --cloud <path>      Cloud graph JSON path
  --cloud-backend <name> d1 or local. Defaults to D1 when HOPIT_D1_* is configured
  --d1-account-id <id> Cloudflare account id for D1
  --d1-database-id <id> Cloudflare D1 database id
  --d1-api-token <token> Cloudflare API token with D1 edit/read access
  --d1-api-base-url <url> Override Cloudflare API base URL for tests/proxies
  --session-token <token> D1 scoped per-device session token
  --workspace <path>  Managed workspace folder path
  --journal <path>    Pending write journal path
  --events <path>     Event log path
  --pid <path>        Service pid file path
  --requester-id <id> Requester identity for visibility-filtered reads
  --session-id <id>   Requester session id for visibility-filtered reads
  --device-name <name> Device name for session registration
  --capabilities <csv> Session capabilities, default read,write,sync,watch
  --host <host>        Status server host, defaults to 127.0.0.1
  --port <port>        Status server port, defaults to 4785
  --remote-pull        Opt into activity-gated safe cloud refresh in watch/service mode
  --remote-push        Opt into push-delivered safe cloud refresh hints in watch/service mode
  --remote-push-url <url> Push hub NDJSON stream URL, or HOPIT_REMOTE_PUSH_URL
  --remote-pull-cooldown-ms <ms> Minimum delay between activity-triggered remote pulls, default 300000
  --remote-refresh-interval-ms <ms> Legacy alias for --remote-pull-cooldown-ms
  --start-service      install: start the production service after preparing paths
  --write-env          install: write hopit.env.example under the agent state root
  --launch-agent       install: write a macOS LaunchAgent for start-on-login
  --yes                setup: accept all defaults with no prompts (non-interactive)
  --advanced           setup: also prompt for the agent state root
  --env-path <path>    setup: production env file path, default ~/.config/hopit/production.env (--env-file is reserved by Node)
  --no-write-env       setup: do not write the production env file
  --force-env          setup: overwrite an existing production env file
  --no-launch-agent    setup: skip the macOS start-on-login agent prompt/step
  --interactive        setup: force interactive prompts even when stdin is not a TTY (testing/advanced; env HOPIT_SETUP_ASSUME_TTY=1)
  --skip-service-control mirror: do not stop or restart the macOS LaunchAgent
  --json              Accepted for scripting; commands already emit JSON where applicable
  --message <text>    Git commit message for export/publish
  --include-private   Include .private files in export only; publish always omits them
  --allow-unsafe-workspace Override workspace path safety checks
  --allow-local-cloud Allow production profile to use local JSON cloud for dry runs
  --force             Overwrite the cloud graph on init
`)
}
