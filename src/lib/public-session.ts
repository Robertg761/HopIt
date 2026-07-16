import 'server-only'

import { auth } from '@clerk/nextjs/server'

import { shouldEnableClerkUi } from '@/lib/auth-config'

export async function publicSessionSignedIn() {
  if (!shouldEnableClerkUi()) return false
  return Boolean((await auth()).userId)
}
