import { useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Code2,
  Command,
  FileCode2,
  Folder,
  GitBranch,
  GitPullRequest,
  HardDrive,
  History,
  Laptop,
  LayoutDashboard,
  Lock,
  Monitor,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UploadCloud,
  Users,
  Zap,
} from "lucide-react";

type Repository = {
  id: string;
  name: string;
  owner: string;
  privacy: "Private" | "Team";
  branch: string;
  files: number;
  devices: number;
  collaborators: string[];
  syncState: "Synced" | "Syncing" | "Review";
  updated: string;
  changes: string;
  accent: string;
};

type ActivityItem = {
  repoId: string;
  file: string;
  path: string;
  actor: string;
  device: string;
  event: string;
  time: string;
  state: "synced" | "pending" | "review";
};

const repositories: Repository[] = [
  {
    id: "atlas",
    name: "atlas-web",
    owner: "Northstar Labs",
    privacy: "Team",
    branch: "main",
    files: 1248,
    devices: 4,
    collaborators: ["RG", "AK", "JM"],
    syncState: "Syncing",
    updated: "8 sec ago",
    changes: "14 file edits streaming",
    accent: "#0f766e",
  },
  {
    id: "recipe",
    name: "recipe-engine",
    owner: "Personal",
    privacy: "Private",
    branch: "feature/importer",
    files: 682,
    devices: 2,
    collaborators: ["RG"],
    syncState: "Synced",
    updated: "2 min ago",
    changes: "Clean cloud snapshot",
    accent: "#166534",
  },
  {
    id: "mobile",
    name: "mobile-shell",
    owner: "Northstar Labs",
    privacy: "Team",
    branch: "sync-agent",
    files: 932,
    devices: 3,
    collaborators: ["RG", "NS"],
    syncState: "Review",
    updated: "12 min ago",
    changes: "Conflict preview ready",
    accent: "#b45309",
  },
];

const activity: ActivityItem[] = [
  {
    repoId: "atlas",
    file: "RepoTimeline.tsx",
    path: "apps/web/src/features/repo",
    actor: "Robert",
    device: "MacBook Pro",
    event: "saved and cloud-indexed",
    time: "just now",
    state: "synced",
  },
  {
    repoId: "atlas",
    file: "sync-worker.ts",
    path: "services/sync-agent/src",
    actor: "Avery",
    device: "iPad",
    event: "streaming 6 edits",
    time: "8 sec ago",
    state: "pending",
  },
  {
    repoId: "atlas",
    file: "schema.sql",
    path: "infra/postgres",
    actor: "Mina",
    device: "Workstation",
    event: "requested review",
    time: "2 min ago",
    state: "review",
  },
  {
    repoId: "recipe",
    file: "ingredient-parser.ts",
    path: "packages/parsing/src",
    actor: "Robert",
    device: "Mac mini",
    event: "synced snapshot",
    time: "4 min ago",
    state: "synced",
  },
  {
    repoId: "mobile",
    file: "DevicePresence.tsx",
    path: "apps/mobile/components",
    actor: "Nora",
    device: "Pixel",
    event: "opened conflict view",
    time: "11 min ago",
    state: "review",
  },
];

const tree = [
  { name: "apps", type: "folder", status: "syncing" },
  { name: "packages", type: "folder", status: "synced" },
  { name: "services", type: "folder", status: "syncing" },
  { name: "infra", type: "folder", status: "review" },
  { name: "README.md", type: "file", status: "synced" },
  { name: "hopit.config.ts", type: "file", status: "synced" },
];

const devices = [
  { name: "MacBook Pro", icon: Laptop, state: "Writing", pulse: true },
  { name: "iPad", icon: Monitor, state: "Streaming edits", pulse: true },
  { name: "Pixel", icon: Smartphone, state: "Idle", pulse: false },
  { name: "Cloud runner", icon: Cloud, state: "Indexing", pulse: true },
];

function App() {
  const [selectedRepoId, setSelectedRepoId] = useState(repositories[0].id);
  const [activityFilter, setActivityFilter] = useState<"all" | "synced" | "review">("all");
  const selectedRepo = repositories.find((repo) => repo.id === selectedRepoId)!;

  const visibleActivity = useMemo(() => {
    return activity.filter((item) => {
      if (activityFilter === "all") {
        return item.repoId === selectedRepo.id;
      }
      if (activityFilter === "review") {
        return item.repoId === selectedRepo.id && item.state === "review";
      }
      return item.repoId === selectedRepo.id && item.state === "synced";
    });
  }, [activityFilter, selectedRepo.id]);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand-row">
          <div className="brand-mark">
            <Zap size={18} strokeWidth={2.4} />
          </div>
          <div>
            <strong>HopIt</strong>
            <span>Cloud codebase</span>
          </div>
        </div>

        <button className="create-button" type="button">
          <Plus size={16} />
          New codebase
        </button>

        <nav className="nav-list">
          <a className="nav-item active" href="#workspace">
            <LayoutDashboard size={17} />
            Workspace
          </a>
          <a className="nav-item" href="#repos">
            <Code2 size={17} />
            Codebases
          </a>
          <a className="nav-item" href="#activity">
            <Activity size={17} />
            Activity
          </a>
          <a className="nav-item" href="#reviews">
            <GitPullRequest size={17} />
            Reviews
          </a>
          <a className="nav-item" href="#settings">
            <Settings size={17} />
            Settings
          </a>
        </nav>

        <div className="storage-meter">
          <div className="storage-title">
            <HardDrive size={16} />
            Cloud volume
          </div>
          <div className="meter">
            <span />
          </div>
          <p>48.6 GB synced across 9 codebases</p>
        </div>
      </aside>

      <section className="workspace" id="workspace">
        <header className="topbar">
          <div className="search-box">
            <Search size={17} />
            <input aria-label="Search codebases" placeholder="Search codebases, files, people" />
            <kbd>⌘K</kbd>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Command palette">
              <Command size={17} />
            </button>
            <button className="icon-button" type="button" aria-label="Notifications">
              <Bell size={17} />
            </button>
            <button className="profile-button" type="button" aria-label="Profile">
              RG
            </button>
          </div>
        </header>

        <div className="workspace-grid">
          <section className="main-panel" aria-labelledby="repo-list-title">
            <div className="section-heading">
              <div>
                <h1 id="repo-list-title">Codebases</h1>
                <p>Every save becomes a cloud snapshot, ready on every device.</p>
              </div>
              <button className="secondary-button" type="button">
                <UploadCloud size={16} />
                Import repo
              </button>
            </div>

            <div className="repo-list" role="list">
              {repositories.map((repo) => (
                <button
                  className={`repo-row ${repo.id === selectedRepo.id ? "selected" : ""}`}
                  key={repo.id}
                  onClick={() => setSelectedRepoId(repo.id)}
                  role="listitem"
                  style={{ "--repo-accent": repo.accent } as React.CSSProperties}
                  type="button"
                >
                  <span className="repo-icon">
                    <Braces size={19} />
                  </span>
                  <span className="repo-copy">
                    <strong>{repo.name}</strong>
                    <span>{repo.owner}</span>
                  </span>
                  <span className="repo-meta">
                    <GitBranch size={15} />
                    {repo.branch}
                  </span>
                  <span className={`status ${repo.syncState.toLowerCase()}`}>
                    <CircleDot size={13} />
                    {repo.syncState}
                  </span>
                  <span className="repo-updated">{repo.updated}</span>
                </button>
              ))}
            </div>

            <section className="repo-detail" aria-labelledby="selected-repo-title">
              <div className="detail-header">
                <div>
                  <h2 id="selected-repo-title">{selectedRepo.name}</h2>
                  <p>{selectedRepo.changes}</p>
                </div>
                <div className="detail-actions">
                  <button className="secondary-button compact" type="button">
                    <Share2 size={15} />
                    Share
                  </button>
                  <button className="primary-button compact" type="button">
                    Open cloud IDE
                  </button>
                </div>
              </div>

              <div className="repo-metrics">
                <Metric icon={FileCode2} label="Tracked files" value={selectedRepo.files.toLocaleString()} />
                <Metric icon={Laptop} label="Devices" value={String(selectedRepo.devices)} />
                <Metric icon={Users} label="People" value={String(selectedRepo.collaborators.length)} />
                <Metric icon={ShieldCheck} label="Access" value={selectedRepo.privacy} />
              </div>

              <div className="split-detail">
                <div className="file-tree" aria-label="Repository file tree">
                  <div className="panel-title">
                    <span>Files</span>
                    <button className="icon-button small" type="button" aria-label="File actions">
                      <MoreHorizontal size={15} />
                    </button>
                  </div>
                  {tree.map((item) => (
                    <div className="tree-row" key={item.name}>
                      {item.type === "folder" ? <Folder size={16} /> : <FileCode2 size={16} />}
                      <span>{item.name}</span>
                      <span className={`dot ${item.status}`} />
                    </div>
                  ))}
                </div>

                <div className="activity-panel" id="activity">
                  <div className="panel-title stacked">
                    <span>Recent sync activity</span>
                    <div className="segmented" aria-label="Activity filter">
                      {(["all", "synced", "review"] as const).map((filter) => (
                        <button
                          className={activityFilter === filter ? "active" : ""}
                          key={filter}
                          onClick={() => setActivityFilter(filter)}
                          type="button"
                        >
                          {filter}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="activity-list">
                    {visibleActivity.length === 0 ? (
                      <div className="empty-state">
                        <Check size={18} />
                        Nothing waiting in this view.
                      </div>
                    ) : (
                      visibleActivity.map((item) => <ActivityRow item={item} key={`${item.file}-${item.time}`} />)
                    )}
                  </div>
                </div>
              </div>
            </section>
          </section>

          <aside className="sync-panel" aria-label="Live sync status">
            <div className="sync-header">
              <div className="cloud-ring">
                <Cloud size={24} />
              </div>
              <h2>Live sync</h2>
              <p>Cloud head is 8 seconds ahead of the last local checkout.</p>
            </div>

            <div className="sync-card active-sync">
              <div>
                <span className="eyeless-label">Current stream</span>
                <strong>{selectedRepo.name}</strong>
              </div>
              <button className="icon-button small" type="button" aria-label="Expand sync stream">
                <ChevronDown size={15} />
              </button>
            </div>

            <div className="device-list">
              {devices.map((device) => {
                const Icon = device.icon;
                return (
                  <div className="device-row" key={device.name}>
                    <span className={device.pulse ? "device-icon pulse" : "device-icon"}>
                      <Icon size={16} />
                    </span>
                    <span>
                      <strong>{device.name}</strong>
                      <small>{device.state}</small>
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="sync-queue">
              <div className="panel-title">
                <span>Snapshot queue</span>
                <History size={15} />
              </div>
              <ol>
                <li>
                  <span />
                  Indexed file graph
                </li>
                <li>
                  <span />
                  Packed branch delta
                </li>
                <li className="pending">
                  <span />
                  Publishing workspace state
                </li>
              </ol>
            </div>

            <div className="security-strip">
              <Lock size={16} />
              End-to-end workspace keys are stored per device.
            </div>

            <button className="primary-button full" type="button">
              <Sparkles size={16} />
              Resolve next sync
            </button>
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof FileCode2; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className="activity-row">
      <span className={`activity-state ${item.state}`} />
      <div>
        <strong>{item.file}</strong>
        <p>
          {item.actor} on {item.device} {item.event}
        </p>
        <small>{item.path}</small>
      </div>
      <time>{item.time}</time>
    </div>
  );
}

export default App;
