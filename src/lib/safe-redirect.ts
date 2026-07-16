const MAX_REDIRECT_LENGTH = 2048
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

export function safeRelativeRedirect(candidate: string | null | undefined, fallback: string) {
  if (!candidate || candidate.length > MAX_REDIRECT_LENGTH) return fallback
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) return fallback
  if (candidate.includes('://') || CONTROL_CHARACTERS.test(candidate)) return fallback
  return candidate
}

export function signInUrlForRequest(requestUrl: string, signInPath: string) {
  const request = new URL(requestUrl)
  const signInUrl = new URL(signInPath, request)
  signInUrl.searchParams.set('redirect_url', `${request.pathname}${request.search}`)
  return signInUrl
}

export function authPathWithRedirect(authPath: string, destination: string) {
  const search = new URLSearchParams({ redirect_url: destination })
  return `${authPath}?${search.toString()}`
}
