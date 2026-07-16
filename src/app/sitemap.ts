import type { MetadataRoute } from 'next'

const siteUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://hopit.dev'
const publicPaths = ['/', '/download', '/privacy', '/terms'] as const

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.map((path) => ({
    url: new URL(path, siteUrl).toString(),
    changeFrequency: path === '/' || path === '/download' ? 'weekly' : 'yearly',
    priority: path === '/' ? 1 : path === '/download' ? 0.8 : 0.4,
  }))
}
