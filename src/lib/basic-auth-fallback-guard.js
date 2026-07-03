let warningLogged = false

export function warnBasicAuthFallbackEnabledOnce(logger = console) {
  if (warningLogged) return false
  warningLogged = true
  logger.warn(
    '[HopIt security] HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1 is enabled. Basic Auth fallback bypasses Clerk and should only be used for temporary emergency recovery.',
  )
  return true
}

export function resetBasicAuthFallbackWarningForTests() {
  warningLogged = false
}
