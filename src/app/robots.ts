import type { MetadataRoute } from 'next'

const siteUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://hopit.dev'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/download', '/privacy', '/terms'],
      disallow: [
        '/api/',
        '/activity',
        '/admin',
        '/codebases',
        '/device',
        '/files',
        '/members',
        '/overview',
        '/pricing',
        '/review',
        '/settings',
        '/sign-in',
        '/sign-up',
        '/status',
        '/team',
      ],
    },
    sitemap: new URL('/sitemap.xml', siteUrl).toString(),
  }
}
