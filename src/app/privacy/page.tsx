import type { Metadata } from 'next'

import { LegalPage } from '@/components/marketing/legal-page'
import { PublicShell } from '@/components/marketing/public-shell'

export const metadata: Metadata = {
  title: 'Privacy Policy — HopIt',
  description: 'How HopIt collects, uses, stores, and protects account, workspace, and billing information.',
}

export default function PrivacyPage() {
  return (
    <PublicShell>
      <LegalPage
        eyebrow="LEGAL / PRIVACY"
        title="Privacy Policy"
        summary="This policy explains what HopIt receives when you create an account and synchronize a workspace, why we use it, and the controls you retain."
        updated="July 13, 2026"
      >
        <p>HopIt is operated by Robert Gordon in Newfoundland and Labrador, Canada. In this policy, “HopIt,” “we,” and “us” refer to the HopIt service and its operator.</p>

        <h2>1. Information we collect</h2>
        <ul>
          <li><strong>Account information:</strong> identifiers and profile information supplied by Clerk or your chosen sign-in provider, such as your name, email address, avatar, verification state, and account identifier.</li>
          <li><strong>Workspace content:</strong> project names, source files, file metadata, revisions, activity records, collaboration records, and object-storage references you choose to synchronize.</li>
          <li><strong>Device and security information:</strong> device names, public keys, scoped session records, authentication events, request metadata, IP addresses, and diagnostic logs used to operate and protect the service.</li>
          <li><strong>Billing information:</strong> plan, subscription status, Stripe customer and subscription references, and billing events. HopIt does not receive or store your full payment-card number.</li>
          <li><strong>Communications:</strong> information you include when requesting support or responding to service notices.</li>
        </ul>

        <h2>2. How we use information</h2>
        <p>We use information to authenticate users, provision accounts, synchronize and restore workspaces, enforce tenant boundaries and plan limits, process subscriptions, prevent abuse, diagnose failures, provide support, comply with law, and improve the reliability of HopIt.</p>

        <h2>3. Source-code and encryption boundaries</h2>
        <p>HopIt stores workspace content in cloud infrastructure so it can synchronize across your devices. Designated secret paths may be encrypted on your device before upload when you configure HopIt’s client-encryption features. Do not assume every ordinary source file is end-to-end encrypted. Account, path, revision, usage, and billing metadata remains available to the service as needed to operate it.</p>

        <h2>4. Service providers and sharing</h2>
        <p>We share information only as needed to run HopIt, complete a transaction, comply with law, or protect users and the service. Current infrastructure providers include:</p>
        <ul>
          <li><strong>Clerk</strong> for account authentication and session management.</li>
          <li><strong>Cloudflare</strong> for database, object storage, network, and Worker infrastructure.</li>
          <li><strong>Vercel</strong> for application hosting and delivery.</li>
          <li><strong>Stripe and Link</strong> for checkout, subscriptions, merchant-of-record services, tax handling, fraud prevention, transaction support, and refunds.</li>
          <li><strong>Google</strong> when you choose Sign in with Google. HopIt requests basic identity information used to authenticate your account.</li>
        </ul>
        <p>We do not sell personal information or workspace content, and we do not use workspace content for third-party advertising.</p>

        <h2>5. International processing</h2>
        <p>HopIt is operated from Canada, while service providers may process information in Canada, the United States, and other locations where they operate. Those locations may have different data-protection laws than your home jurisdiction.</p>

        <h2>6. Retention and deletion</h2>
        <p>We retain account and workspace information while your account is active and as reasonably necessary to provide the service, resolve disputes, maintain security, and meet legal or accounting requirements. Deleting a project or account may not immediately remove information from encrypted backups or provider records. Stripe or Link may retain transaction records under their own legal obligations.</p>
        <p>A downgrade or quota block does not delete your cloud data. You may export accessible project content while your account remains available. To request account deletion or assistance with an export, contact <a href="mailto:support@hopit.dev">support@hopit.dev</a>.</p>

        <h2>7. Your choices and rights</h2>
        <p>Depending on your location, you may have rights to access, correct, export, restrict, object to, or delete personal information. You may also withdraw consent where consent is the basis for processing. We may need to verify your identity before completing a request.</p>

        <h2>8. Security</h2>
        <p>HopIt uses scoped sessions, tenant-level access controls, private object storage, transport encryption, and local journaling safeguards. No system can guarantee absolute security. Keep your account and devices secure, use trusted devices, and notify us promptly if you believe your account has been compromised.</p>

        <h2>9. Children</h2>
        <p>HopIt is not directed to children under 13. You must be old enough to consent to data processing and enter a binding agreement where you live, or use HopIt with the authorization of a parent or legal guardian.</p>

        <h2>10. Changes</h2>
        <p>We may update this policy as the service or legal requirements change. We will revise the effective date and provide additional notice when a material change requires it.</p>

        <h2>11. Contact</h2>
        <p>For privacy questions or requests, email <a href="mailto:support@hopit.dev">support@hopit.dev</a>. HopIt is operated in Newfoundland and Labrador, Canada.</p>
      </LegalPage>
    </PublicShell>
  )
}
