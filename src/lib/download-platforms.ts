export const downloadPlatforms = [
  { name: 'Apple silicon', target: 'macOS · M1 or newer', architecture: 'darwin-arm64', href: '/api/download/macos?format=dmg' },
  { name: 'Intel Mac', target: 'macOS · Intel processor', architecture: 'darwin-x64', href: '/api/download/macos?format=dmg' },
  { name: 'Linux x64', target: 'Most Intel and AMD PCs', architecture: 'linux-x64', href: '/api/download/linux-x64' },
  { name: 'Linux ARM', target: 'ARM64 workstations and servers', architecture: 'linux-arm64', href: '/api/download/linux-arm64' },
] as const
