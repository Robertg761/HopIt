const baseUrl = new URL(process.argv[2] ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://hopit.dev')
const failures = []
const checks = []

await checkPage('/', 200, [
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
])
await checkText('/robots.txt', 'Sitemap:')
await checkText('/sitemap.xml', '<urlset')
await checkStatus('/does-not-exist', 404)
await checkDownload('/api/download/macos?format=dmg')
await checkDownload('/api/download/linux-x64')
await checkDownload('/api/download/linux-arm64')

const result = { ok: failures.length === 0, baseUrl: baseUrl.origin, checks, failures }
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1

async function request(path, init = {}) {
  return fetch(new URL(path, baseUrl), { redirect: 'manual', ...init })
}

async function checkStatus(path, expected) {
  const response = await request(path)
  checks.push({ path, status: response.status })
  if (response.status !== expected) failures.push(`${path} returned ${response.status}; expected ${expected}.`)
}

async function checkPage(path, expected, requiredHeaders) {
  const response = await request(path)
  checks.push({ path, status: response.status })
  if (response.status !== expected) failures.push(`${path} returned ${response.status}; expected ${expected}.`)
  for (const header of requiredHeaders) {
    if (!response.headers.get(header)) failures.push(`${path} is missing ${header}.`)
  }
}

async function checkText(path, marker) {
  const response = await request(path)
  const body = await response.text()
  checks.push({ path, status: response.status })
  if (response.status !== 200) failures.push(`${path} returned ${response.status}; expected 200.`)
  if (!body.includes(marker)) failures.push(`${path} does not include ${marker}.`)
}

async function checkDownload(path) {
  const response = await request(path, { method: 'HEAD' })
  const location = response.headers.get('location')
  checks.push({ path, status: response.status, location })
  if (location && new URL(location, baseUrl).pathname.startsWith('/sign-in')) {
    failures.push(`${path} redirects to sign-in.`)
  }
  if (![200, 204, 307].includes(response.status)) {
    failures.push(`${path} returned ${response.status}; expected an available download response.`)
  }
}
