'use client'

import * as React from 'react'
import { Download, MonitorSmartphone } from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'

type DownloadTarget = 'linux-arm64' | 'linux-x64'

type DeviceChoice =
  | { state: 'loading' }
  | { state: 'download'; label: string; href: string; filename: string }
  | { state: 'web'; label: string; detail: string }

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>
  }
}

export function SmartDownloadButton() {
  const [choice, setChoice] = React.useState<DeviceChoice>({ state: 'loading' })

  React.useEffect(() => {
    let active = true
    void detectDevice().then((result) => {
      if (active) setChoice(result)
    })
    return () => {
      active = false
    }
  }, [])

  if (choice.state === 'loading') {
    return (
      <div className="mt-8">
        <Button size="lg" disabled className="h-11 bg-[#238636] px-5 text-white">
          Checking this device
        </Button>
      </div>
    )
  }

  if (choice.state === 'web') {
    return (
      <div className="mt-8">
        <Button asChild size="lg" className="h-11 bg-[#238636] px-5 text-white hover:bg-[#2ea043]">
          <Link href="/overview">Use HopIt in your browser <MonitorSmartphone /></Link>
        </Button>
        <p className="mt-3 text-sm text-[#8b949e]">{choice.detail}</p>
      </div>
    )
  }

  return (
    <div className="mt-8">
      <Button asChild size="lg" className="h-11 bg-[#238636] px-5 text-white hover:bg-[#2ea043]">
        <a href={choice.href} download={choice.filename}>
          {choice.label}
          <Download />
        </a>
      </Button>
    </div>
  )
}

async function detectDevice(): Promise<DeviceChoice> {
  const navigatorWithData = navigator as NavigatorWithUserAgentData
  const platform = `${navigatorWithData.userAgentData?.platform ?? ''} ${navigator.platform} ${navigator.userAgent}`

  if (/Android|iPhone|iPad|iPod/i.test(platform)) {
    return {
      state: 'web',
      label: 'Mobile',
      detail: 'The web dashboard works here. Local filesystem sync currently requires macOS or Linux.',
    }
  }

  if (/Windows|Win32|Win64/i.test(platform)) {
    return {
      state: 'web',
      label: 'Windows',
      detail: 'The web dashboard works on Windows. A Windows filesystem agent is not available yet.',
    }
  }

  if (/Mac|macOS/i.test(platform)) {
    const dmgAvailable = await isAvailable('/api/download/macos?format=dmg')
    return {
      state: 'download',
      label: dmgAvailable ? 'Download for macOS' : 'Install on macOS',
      href: dmgAvailable ? '/api/download/macos?format=dmg' : '/install.sh',
      filename: dmgAvailable ? 'HopIt-macOS.dmg' : 'hopit-install.sh',
    }
  }

  if (/Linux/i.test(platform)) {
    const architecture = await detectArchitecture(navigatorWithData)
    if (architecture) return archiveChoice(`linux-${architecture}`, 'Linux')
    return {
      state: 'download',
      label: 'Download for Linux',
      href: '/install.sh',
      filename: 'hopit-install.sh',
    }
  }

  return {
    state: 'web',
    label: 'this device',
    detail: 'HopIt could not identify a supported local agent for this device.',
  }
}

async function isAvailable(href: string) {
  try {
    return (await fetch(href, { method: 'HEAD' })).ok
  } catch {
    return false
  }
}

async function detectArchitecture(navigatorWithData: NavigatorWithUserAgentData): Promise<'arm64' | 'x64' | null> {
  try {
    const values = await navigatorWithData.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness'])
    const architecture = values?.architecture?.toLowerCase() ?? ''
    if (architecture.includes('arm')) return 'arm64'
    if (architecture.includes('x86')) return 'x64'
  } catch {
    // Privacy-restricted browsers may refuse high-entropy client hints.
  }

  const browserIdentity = `${navigator.platform} ${navigator.userAgent}`
  if (/aarch64|arm64/i.test(browserIdentity)) return 'arm64'
  if (/x86_64|x64|amd64/i.test(browserIdentity)) return 'x64'

  return webGlArchitecture()
}

function webGlArchitecture(): 'arm64' | 'x64' | null {
  try {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('webgl')
    if (!context) return null
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(context.getParameter(context.RENDERER))
    if (/Apple (?:M\d|GPU)/i.test(renderer)) return 'arm64'
    if (/Intel/i.test(renderer)) return 'x64'
  } catch {
    // Fall through to the architecture-safe installer.
  }
  return null
}

function archiveChoice(target: DownloadTarget, platform: string): DeviceChoice {
  return {
    state: 'download',
    label: `Download for ${platform}`,
    href: `/api/download/${target}`,
    filename: `hop-${target}.tar.gz`,
  }
}
