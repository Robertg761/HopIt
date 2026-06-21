'use client'

import * as React from 'react'
import { ClerkProvider } from '@clerk/nextjs'
import { signInPath, signUpPath } from '@/lib/auth-config'

type ClerkAuthProviderProps = {
  enabled: boolean
  children: React.ReactNode
}

export function ClerkAuthProvider({ enabled, children }: ClerkAuthProviderProps) {
  if (!enabled) return <>{children}</>

  return (
    <ClerkProvider signInUrl={signInPath} signUpUrl={signUpPath}>
      {children}
    </ClerkProvider>
  )
}
