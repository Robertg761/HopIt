import type { Metadata } from 'next'
import {
  Check,
  Cloud,
  Download,
  ExternalLink,
  Laptop,
  LockKeyhole,
  ShieldCheck,
  Terminal,
} from 'lucide-react'

import { DownloadDashboardButton } from '@/components/marketing/download-auth-actions'
import { SmartDownloadButton } from '@/components/marketing/smart-download-button'
import { PublicShell } from '@/components/marketing/public-shell'

export const metadata: Metadata = {
  title: 'Download HopIt | macOS and Linux',
  description: 'Install the HopIt sync agent on macOS or Linux and connect this device to your cloud workspace.',
}

const installCommand = 'curl -fsSL https://hopit.dev/install | sh'

const platforms = [
  { name: 'Apple silicon', target: 'macOS · M1 or newer', architecture: 'darwin-arm64' },
  { name: 'Intel Mac', target: 'macOS · Intel processor', architecture: 'darwin-x64' },
  { name: 'Linux x64', target: 'Most Intel and AMD PCs', architecture: 'linux-x64' },
  { name: 'Linux ARM', target: 'ARM64 workstations and servers', architecture: 'linux-arm64' },
] as const

export default function DownloadPage() {
  return (
    <PublicShell>
      <section className="relative isolate overflow-hidden border-b border-border bg-[#0d1117] text-[#f0f6fc]">
        <div className="absolute inset-0 -z-20 bg-[radial-gradient(circle_at_78%_16%,rgba(47,129,247,.22),transparent_30%),radial-gradient(circle_at_18%_90%,rgba(63,185,80,.15),transparent_34%)]" />
        <div className="absolute inset-0 -z-10 opacity-25 [background-image:linear-gradient(to_right,#30363d_1px,transparent_1px),linear-gradient(to_bottom,#30363d_1px,transparent_1px)] [background-size:48px_48px] [mask-image:linear-gradient(to_bottom,black,transparent_92%)]" />
        <div className="mx-auto grid w-full max-w-[1180px] gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[.9fr_1.1fr] lg:items-center lg:px-8 lg:py-28">
          <div>
            <h1 className="text-balance text-5xl font-semibold tracking-[-0.055em] sm:text-6xl">
              Bring your workspace<br /><span className="text-[#58a6ff]">to this device.</span>
            </h1>
            <p className="mt-6 max-w-xl text-pretty text-lg leading-8 text-[#a1a9b3]">
              Install the lightweight HopIt agent, approve this device in your browser, and continue from the same cloud workspace.
            </p>
            <SmartDownloadButton />
          </div>

          <div className="overflow-hidden rounded-2xl border border-[#30363d] bg-[#010409] shadow-[0_28px_90px_rgba(0,0,0,.38)]">
            <div className="flex items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-4 py-3">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-2 font-mono text-[11px] text-[#8b949e]">Terminal</span>
            </div>
            <div className="p-5 sm:p-7">
              <p className="font-mono text-xs text-[#8b949e]"># Install the correct build for this machine</p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-[#30363d] bg-[#0d1117] p-4 font-mono text-sm leading-6 text-[#e6edf3]"><code><span className="select-none text-[#3fb950]">$ </span>{installCommand}</code></pre>
              <p className="mt-5 font-mono text-xs text-[#8b949e]"># Connect it to your account</p>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-[#30363d] bg-[#0d1117] p-4 font-mono text-sm leading-6 text-[#e6edf3]"><code><span className="select-none text-[#3fb950]">$ </span>hop setup</code></pre>
              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#8b949e]">
                <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-[#3fb950]" /> Checksum verified</span>
                <span className="inline-flex items-center gap-1.5"><Download className="size-3.5 text-[#58a6ff]" /> Runtime included</span>
                <a className="inline-flex items-center gap-1.5 text-[#58a6ff] hover:underline" href="/install" target="_blank" rel="noreferrer">Review installer <ExternalLink className="size-3" /></a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-[.7fr_1.3fr] lg:gap-20">
          <div>
            <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">The right build, automatically.</h2>
            <p className="mt-5 leading-7 text-muted-foreground">The macOS disk image includes Apple silicon and Intel runtimes, then installs only the correct one. The terminal installer provides the same automatic selection for Linux.</p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
            {platforms.map((platform) => (
              <article key={platform.architecture} className="bg-card p-5 sm:p-6">
                <span className="grid size-10 place-items-center rounded-lg border border-border bg-muted/55"><Laptop className="size-5 text-hop" /></span>
                <h3 className="mt-6 font-semibold">{platform.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{platform.target}</p>
                <p className="mt-4 font-mono text-[11px] text-muted-foreground">{platform.architecture}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-muted/35">
        <div className="mx-auto grid w-full max-w-[1180px] gap-px px-4 py-16 sm:px-6 lg:grid-cols-3 lg:px-8 lg:py-20">
          <SetupStep icon={Terminal} title="Install" detail="Open the disk image and double-click Install HopIt. Node and npm are not required." />
          <SetupStep icon={LockKeyhole} title="Approve" detail="Sign in when your browser opens and grant this device a scoped session." />
          <SetupStep icon={Cloud} title="Attach" detail="Choose your cloud project and local workspace folder. Sync starts in the background." />
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
        <div className="grid overflow-hidden rounded-2xl border border-border lg:grid-cols-[1.15fr_.85fr]">
          <div className="p-6 sm:p-9">
            <h2 className="text-2xl font-semibold tracking-[-0.025em]">Windows and mobile agents are not available yet.</h2>
            <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">You can use the HopIt web dashboard from Windows, iPhone, iPad, or Android today. Local filesystem sync currently requires macOS or Linux.</p>
            <DownloadDashboardButton />
          </div>
          <div className="border-t border-border bg-[#0d1117] p-6 text-[#f0f6fc] sm:p-9 lg:border-l lg:border-t-0">
            <h3 className="font-semibold">Before you install</h3>
            <ul className="mt-5 space-y-3 text-sm text-[#a1a9b3]">
              <li className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-[#3fb950]" /> Use the same HopIt account on every device.</li>
              <li className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-[#3fb950]" /> Each device is approved separately.</li>
              <li className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-[#3fb950]" /> Reads and exports remain available at quota limits.</li>
            </ul>
          </div>
        </div>
      </section>
    </PublicShell>
  )
}

function SetupStep({ icon: Icon, title, detail }: { icon: typeof Terminal; title: string; detail: string }) {
  return (
    <article className="relative border-border px-1 py-6 lg:border-r lg:px-8 lg:py-2 last:lg:border-r-0">
      <span className="grid size-10 place-items-center rounded-lg border border-border bg-background"><Icon className="size-5 text-hop" /></span>
      <h3 className="mt-8 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
    </article>
  )
}
