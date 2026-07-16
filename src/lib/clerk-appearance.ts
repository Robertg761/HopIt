export const clerkAppearance = {
  variables: {
    colorPrimary: '#1f8a3b',
    colorText: '#20242a',
    colorTextSecondary: '#65707d',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorInputText: '#20242a',
    borderRadius: '0.5rem',
  },
  elements: {
    cardBox: 'shadow-none',
    card: 'border border-border shadow-lg',
    formButtonPrimary: 'bg-hop text-white hover:bg-hop/90',
    footerActionLink: 'text-hop hover:text-hop/80',
    identityPreviewEditButton: 'text-hop',
    userButtonAvatarBox: 'size-8',
  },
} as const

export const clerkLocalization = {
  signIn: {
    start: {
      title: 'Sign in to HopIt',
      subtitle: 'Welcome back. Sign in to continue to your workspace.',
    },
  },
  signUp: {
    start: {
      title: 'Create your HopIt account',
      subtitle: 'Create a workspace and connect your first device.',
    },
  },
} as const
