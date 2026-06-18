import {
  Activity,
  Archive,
  Audio,
  Code,
  Comment,
  FileBox,
  FileText,
  Image,
  Presentation,
  Sheet,
  Upload,
  Video,
} from '@/components/hopit/icons'

export type Codebase = {
  id: string
  name: string
  owner: string
  description: string
  language: string
  languageColor: string
  snapshots: number
  syncedFiles: number
  pendingSyncs: number
  latestSnapshot: { id: string; message: string; author: string; when: string }
  tags: string[]
  visibility: 'public' | 'private'
}

export type DriveFile = {
  id: string
  name: string
  kind: 'folder' | 'file'
  type?: 'pdf' | 'sheet' | 'image' | 'video' | 'audio' | 'doc' | 'slide' | 'archive' | 'code' | 'design'
  size?: string
  modified: string
  modifiedBy: string
  sharedWith: number
  color?: string
}

export type ActivityItem = {
  id: string
  who: { name: string; handle: string; color: string }
  what: 'snapshot' | 'sync' | 'upload' | 'comment'
  target: string
  detail: string
  when: string
}

export type Collaborator = {
  id: string
  name: string
  handle: string
  color: string
  status: 'active' | 'idle' | 'viewing'
  location?: string
  cursor?: { x: number; y: number; label: string }
}

export const codebases: Codebase[] = [
  {
    id: 'r1',
    name: 'hopit-core',
    owner: 'hopit',
    description: 'The HopIt engine — snapshot-backed object store with real-time presence channels.',
    language: 'TypeScript',
    languageColor: '#3178c6',
    snapshots: 1284,
    syncedFiles: 184,
    pendingSyncs: 2,
    latestSnapshot: { id: 'snap-a3f9c12', message: 'Updated presence channels for shared cursor positions', author: 'Mira Tanaka', when: '12 min ago' },
    tags: ['core', 'engine', 'v2'],
    visibility: 'public',
  },
  {
    id: 'r2',
    name: 'web-ui',
    owner: 'hopit',
    description: 'Frontend workspace: synced file grid, codebase browser, design system.',
    language: 'TypeScript',
    languageColor: '#3178c6',
    snapshots: 642,
    syncedFiles: 132,
    pendingSyncs: 1,
    latestSnapshot: { id: 'snap-b71e0d4', message: 'Preserved scroll position after file rename', author: 'Devin Cole', when: '47 min ago' },
    tags: ['frontend', 'design-system'],
    visibility: 'public',
  },
  {
    id: 'r3',
    name: 'design-system',
    owner: 'hopit',
    description: 'Tokens, primitives, and Figma → code sync for the HopIt visual language.',
    language: 'CSS',
    languageColor: '#663399',
    snapshots: 318,
    syncedFiles: 88,
    pendingSyncs: 0,
    latestSnapshot: { id: 'snap-c0a2241', message: 'Added hop-green-600 ramp and grape-500 tokens', author: 'Priya Shah', when: '2 hours ago' },
    tags: ['design', 'tokens'],
    visibility: 'public',
  },
  {
    id: 'r4',
    name: 'hopit-cli',
    owner: 'hopit',
    description: 'Terminal-first access: `hop push`, `hop share`, and `hop sync` for any file or codebase.',
    language: 'Rust',
    languageColor: '#dea584',
    snapshots: 489,
    syncedFiles: 76,
    pendingSyncs: 3,
    latestSnapshot: { id: 'snap-d92f8a0', message: 'Streamed large files during sync instead of buffering', author: 'Lukas Berg', when: '5 hours ago' },
    tags: ['cli', 'rust'],
    visibility: 'public',
  },
  {
    id: 'r5',
    name: 'docs-site',
    owner: 'hopit',
    description: 'Public docs, guides, and API reference for the shared workspace.',
    language: 'MDX',
    languageColor: '#fcb32c',
    snapshots: 156,
    syncedFiles: 54,
    pendingSyncs: 0,
    latestSnapshot: { id: 'snap-e5c1b78', message: 'Documented the /v2/presence endpoint', author: 'Ana Ruiz', when: '1 day ago' },
    tags: ['docs'],
    visibility: 'public',
  },
  {
    id: 'r6',
    name: 'mobile-companion',
    owner: 'hopit',
    description: 'Private-scope mobile workspace for browsing codebases and uploading files on the go.',
    language: 'Swift',
    languageColor: '#fa7343',
    snapshots: 92,
    syncedFiles: 41,
    pendingSyncs: 0,
    latestSnapshot: { id: 'snap-f8d3a55', message: 'Added offline comment drafts for mobile review', author: 'Mira Tanaka', when: '2 days ago' },
    tags: ['mobile', '.private/'],
    visibility: 'private',
  },
]

export const driveFolders: DriveFile[] = [
  { id: 'f1', name: 'Brand assets', kind: 'folder', modified: '2 hours ago', modifiedBy: 'Priya Shah', sharedWith: 6, color: 'grape' },
  { id: 'f2', name: 'Roadmap 2026', kind: 'folder', modified: 'Yesterday', modifiedBy: 'Mira Tanaka', sharedWith: 12, color: 'hop' },
  { id: 'f3', name: 'Customer interviews', kind: 'folder', modified: '3 days ago', modifiedBy: 'Devin Cole', sharedWith: 4, color: 'amber' },
  { id: 'f4', name: 'Releases', kind: 'folder', modified: '1 week ago', modifiedBy: 'Ana Ruiz', sharedWith: 24, color: 'sky' },
]

export const driveFiles: DriveFile[] = [
  { id: 'd1', name: 'HopIt-pitch-deck.pdf', kind: 'file', type: 'pdf', size: '8.4 MB', modified: '12 min ago', modifiedBy: 'Mira Tanaka', sharedWith: 5 },
  { id: 'd2', name: 'architecture-v3.png', kind: 'file', type: 'image', size: '2.1 MB', modified: '1 hour ago', modifiedBy: 'Devin Cole', sharedWith: 8 },
  { id: 'd3', name: 'team-retro-notes.md', kind: 'file', type: 'doc', size: '24 KB', modified: '3 hours ago', modifiedBy: 'Ana Ruiz', sharedWith: 11 },
  { id: 'd4', name: 'Q4-metrics.xlsx', kind: 'file', type: 'sheet', size: '512 KB', modified: '5 hours ago', modifiedBy: 'Lukas Berg', sharedWith: 6 },
  { id: 'd5', name: 'onboarding-walkthrough.mp4', kind: 'file', type: 'video', size: '64 MB', modified: 'Yesterday', modifiedBy: 'Priya Shah', sharedWith: 18 },
  { id: 'd6', name: 'icon-pack.zip', kind: 'file', type: 'archive', size: '4.2 MB', modified: '2 days ago', modifiedBy: 'Priya Shah', sharedWith: 3 },
  { id: 'd7', name: 'api-spec.yaml', kind: 'file', type: 'code', size: '88 KB', modified: '2 days ago', modifiedBy: 'Devin Cole', sharedWith: 9 },
  { id: 'd8', name: 'design-tokens.json', kind: 'file', type: 'code', size: '12 KB', modified: '3 days ago', modifiedBy: 'Priya Shah', sharedWith: 14 },
  { id: 'd9', name: 'all-hands-june.pptx', kind: 'file', type: 'slide', size: '18 MB', modified: '4 days ago', modifiedBy: 'Mira Tanaka', sharedWith: 22 },
  { id: 'd10', name: 'logo-variants.fig', kind: 'file', type: 'design', size: '6.7 MB', modified: '5 days ago', modifiedBy: 'Priya Shah', sharedWith: 4 },
  { id: 'd11', name: 'theme-song-demo.mp3', kind: 'file', type: 'audio', size: '3.9 MB', modified: '1 week ago', modifiedBy: 'Lukas Berg', sharedWith: 2 },
  { id: 'd12', name: 'user-survey-2026.pdf', kind: 'file', type: 'pdf', size: '1.2 MB', modified: '1 week ago', modifiedBy: 'Ana Ruiz', sharedWith: 7 },
]

export const activityFeed: ActivityItem[] = [
  {
    id: 'a1',
    who: { name: 'Mira Tanaka', handle: 'mira', color: '#10b981' },
    what: 'snapshot',
    target: 'hopit-core / snap-a3f9c12',
    detail: 'Saved shared cursor positions to the latest workspace snapshot',
    when: '12 min ago',
  },
  {
    id: 'a2',
    who: { name: 'Devin Cole', handle: 'devin', color: '#8b5cf6' },
    what: 'upload',
    target: 'HopIt-pitch-deck.pdf',
    detail: 'Uploaded to /Brand assets — shared with 5 collaborators',
    when: '12 min ago',
  },
  {
    id: 'a3',
    who: { name: 'Priya Shah', handle: 'priya', color: '#f59e0b' },
    what: 'comment',
    target: 'web-ui snapshot',
    detail: '"Can we use the hop-soft variant for hover states instead?"',
    when: '34 min ago',
  },
  {
    id: 'a4',
    who: { name: 'Lukas Berg', handle: 'lukas', color: '#0ea5e9' },
    what: 'sync',
    target: 'hopit-cli',
    detail: 'Streamed large files into the workspace sync queue',
    when: '1 hour ago',
  },
  {
    id: 'a6',
    who: { name: 'Devin Cole', handle: 'devin', color: '#8b5cf6' },
    what: 'snapshot',
    target: 'web-ui / snap-b71e0d4',
    detail: 'Preserved scroll position after file rename',
    when: '47 min ago',
  },
  {
    id: 'a8',
    who: { name: 'Mira Tanaka', handle: 'mira', color: '#10b981' },
    what: 'sync',
    target: 'hopit-core',
    detail: 'Queued presence updates for the next workspace sync',
    when: '4 hours ago',
  },
  {
    id: 'a10',
    who: { name: 'Ana Ruiz', handle: 'ana', color: '#ef4444' },
    what: 'upload',
    target: 'team-retro-notes.md',
    detail: 'Uploaded to / retrospectives — shared with 11 collaborators',
    when: '3 hours ago',
  },
]

export const collaborators: Collaborator[] = [
  { id: 'c1', name: 'Mira Tanaka', handle: 'mira', color: '#10b981', status: 'active', location: 'hopit-core / src/presence', cursor: { x: 62, y: 38, label: 'presence.ts:128' } },
  { id: 'c2', name: 'Devin Cole', handle: 'devin', color: '#8b5cf6', status: 'viewing', location: 'Files / Brand assets' },
  { id: 'c3', name: 'Priya Shah', handle: 'priya', color: '#f59e0b', status: 'active', location: 'design-system / tokens.css', cursor: { x: 30, y: 72, label: 'tokens.css:42' } },
  { id: 'c4', name: 'Lukas Berg', handle: 'lukas', color: '#0ea5e9', status: 'idle', location: 'hopit-cli / src/sync.rs' },
  { id: 'c5', name: 'Ana Ruiz', handle: 'ana', color: '#ef4444', status: 'viewing', location: 'hopit-core / docs/api.md' },
]

export const activityIconMap = {
  snapshot: Activity,
  sync: Activity,
  upload: Upload,
  comment: Comment,
} as const

export const fileTypeIconMap = {
  pdf: FileText,
  sheet: Sheet,
  image: Image,
  video: Video,
  audio: Audio,
  doc: FileText,
  slide: Presentation,
  archive: Archive,
  code: Code,
  design: FileBox,
} as const

export const fileTypeColorMap: Record<string, string> = {
  pdf: '#ef4444',
  sheet: '#10b981',
  image: '#8b5cf6',
  video: '#f59e0b',
  audio: '#ec4899',
  doc: '#3b82f6',
  slide: '#f97316',
  archive: '#64748b',
  code: '#0ea5e9',
  design: '#a855f7',
}

// end of mock data
