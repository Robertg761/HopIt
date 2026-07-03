'use client'

import * as React from 'react'
import Link from 'next/link'
import { FolderGit2, Plus } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import type { CollaborationActionCapability, CollaborationRelease } from '@/lib/collaboration'
import { DiscussionsTab } from './discussions-tab'
import { IssuesTab } from './issues-tab'
import { ProjectsTab } from './projects-tab'
import { ReleasesTab } from './releases-tab'
import { ListSkeleton, WorkItemsUnavailable, capabilityProps, useWorkItemsController } from './work-common'

type WorkTab = 'issues' | 'discussions' | 'projects' | 'releases'

const NEW_LABEL: Record<WorkTab, string> = {
  issues: 'New issue',
  discussions: 'New discussion',
  projects: 'New project',
  releases: 'New release',
}

const UNSET_MAIN_IDS = new Set(['None', 'No Main state', 'Unavailable'])

export function WorkItemsPage() {
  const { selectedCodebaseId, status, actorId } = useWorkspace()
  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const { data, loading, busyKey, runMutation } = useWorkItemsController(codebaseId)
  const [tab, setTab] = React.useState<WorkTab>('issues')
  const [createTab, setCreateTab] = React.useState<WorkTab | null>(null)

  const releaseTarget = React.useMemo<CollaborationRelease['target'] | undefined>(() => {
    const mainId = status.mainId
    if (!mainId || UNSET_MAIN_IDS.has(mainId)) return undefined
    const match = /(\d+)\s*$/.exec(status.mainRevision)
    return { type: 'main', id: mainId, revision: match ? Number.parseInt(match[1], 10) : null }
  }, [status.mainId, status.mainRevision])

  if (!codebaseId) {
    return (
      <PageScaffold title="Work items" description="Issues, discussions, projects, and releases.">
        <EmptyState
          icon={FolderGit2}
          title="No codebase selected"
          description="Pick a codebase to see its issues, discussions, projects, and releases."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/codebases">Browse codebases</Link>
            </Button>
          }
        />
      </PageScaffold>
    )
  }

  const createCapability: CollaborationActionCapability | undefined = data
    ? {
        issues: data.capabilities.createIssue,
        discussions: data.capabilities.createDiscussion,
        projects: data.capabilities.createProject,
        releases: data.capabilities.createRelease,
      }[tab]
    : undefined
  const createProps = capabilityProps(createCapability)

  const tabProps = data
    ? {
        codebaseId,
        actorId,
        data,
        busyKey,
        runMutation,
      }
    : null

  return (
    <PageScaffold
      title="Work items"
      description={`Issues, discussions, projects, and releases for ${status.codebaseName}.`}
      actions={
        <Button
          size="sm"
          disabled={loading || !data?.ok || createProps.disabled}
          title={createProps.title}
          onClick={() => setCreateTab(tab)}
        >
          <Plus className="size-3.5" />
          {NEW_LABEL[tab]}
        </Button>
      }
    >
      {loading ? (
        <ListSkeleton rows={6} />
      ) : data && !data.ok ? (
        <WorkItemsUnavailable response={data} />
      ) : tabProps && data ? (
        <Tabs value={tab} onValueChange={(next) => setTab(next as WorkTab)}>
          <TabsList>
            <TabsTrigger value="issues" count={data.issues.length}>
              Issues
            </TabsTrigger>
            <TabsTrigger value="discussions" count={data.discussions.length}>
              Discussions
            </TabsTrigger>
            <TabsTrigger value="projects" count={data.projects.length}>
              Projects
            </TabsTrigger>
            <TabsTrigger value="releases" count={data.releases.length}>
              Releases
            </TabsTrigger>
          </TabsList>
          <TabsContent value="issues">
            <IssuesTab
              {...tabProps}
              createOpen={createTab === 'issues'}
              onCreateOpenChange={(open) => setCreateTab(open ? 'issues' : null)}
            />
          </TabsContent>
          <TabsContent value="discussions">
            <DiscussionsTab
              {...tabProps}
              createOpen={createTab === 'discussions'}
              onCreateOpenChange={(open) => setCreateTab(open ? 'discussions' : null)}
            />
          </TabsContent>
          <TabsContent value="projects">
            <ProjectsTab
              {...tabProps}
              createOpen={createTab === 'projects'}
              onCreateOpenChange={(open) => setCreateTab(open ? 'projects' : null)}
            />
          </TabsContent>
          <TabsContent value="releases">
            <ReleasesTab
              {...tabProps}
              createOpen={createTab === 'releases'}
              onCreateOpenChange={(open) => setCreateTab(open ? 'releases' : null)}
              releaseTarget={releaseTarget}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <EmptyState
          icon={FolderGit2}
          title="Work items unavailable"
          description="The collaboration backend did not return work items for this codebase."
        />
      )}
    </PageScaffold>
  )
}
