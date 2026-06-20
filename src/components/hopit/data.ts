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

export const codebases: Codebase[] = []

export const driveFolders: DriveFile[] = []

export const driveFiles: DriveFile[] = []

export const activityFeed: ActivityItem[] = []

export const collaborators: Collaborator[] = []

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
