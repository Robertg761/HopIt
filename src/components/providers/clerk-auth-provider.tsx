'use client'

import * as React from 'react'
import { ClerkProvider } from '@clerk/nextjs'
import { signedInHomePath, signInPath, signUpPath } from '@/lib/auth-config'
import { clerkAppearance, clerkLocalization } from '@/lib/clerk-appearance'

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
      <ClerkProvider
        appearance={clerkAppearance}
        localization={clerkLocalization}
        signInUrl={signInPath}
        signUpUrl={signUpPath}
        signInFallbackRedirectUrl={signedInHomePath}
        signUpFallbackRedirectUrl={signedInHomePath}
      >
        {children}
      </ClerkProvider>
    </ClerkAuthEnabledContext.Provider>
  )
}

export function useClerkAuthEnabled() {
  return React.useContext(ClerkAuthEnabledContext)
}
