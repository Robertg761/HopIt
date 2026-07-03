'use client'

import * as React from 'react'
import { ClerkProvider } from '@clerk/nextjs'
import { signInPath, signUpPath } from '@/lib/auth-config'

const ClerkAuthEnabledContext = React.createContext(false)

type ClerkAuthProviderProps = {
  enabled: boolean
  children: React.ReactNode
}

export function ClerkAuthProvider({ enabled, children }: ClerkAuthProviderProps) {
  if (!enabled) {
    return (
      <ClerkAuthEnabledContext.Provider value={false}>
        {children}
      </ClerkAuthEnabledContext.Provider>
    )
  }

  return (
    <ClerkAuthEnabledContext.Provider value>
      <ClerkProvider signInUrl={signInPath} signUpUrl={signUpPath}>
        {children}
      </ClerkProvider>
    </ClerkAuthEnabledContext.Provider>
  )
}

export function useClerkAuthEnabled() {
  return React.useContext(ClerkAuthEnabledContext)
}
