import type { Metadata } from 'next'

import { LegalPage } from '@/components/marketing/legal-page'
import { PublicShell } from '@/components/marketing/public-shell'

export const metadata: Metadata = {
  title: 'Terms of Service — HopIt',
  description: 'The terms governing HopIt accounts, synchronized workspaces, subscriptions, acceptable use, and exports.',
}

export default function TermsPage() {
  return (
    <PublicShell>
      <LegalPage
        title="Terms of Service"
        summary="These terms describe the agreement between you and HopIt when you create an account, synchronize code, or purchase a subscription."
        updated="July 13, 2026"
      >
        <p>HopIt is operated by Robert Gordon in Newfoundland and Labrador, Canada. By accessing or using HopIt, you agree to these Terms of Service and the <a href="/privacy">Privacy Policy</a>. If you use HopIt for an organization, you represent that you can bind that organization to these terms.</p>

        <h2>1. Eligibility and accounts</h2>
        <p>You must be legally able to enter this agreement where you live. You are responsible for accurate account information, the security of your devices and credentials, and activity performed through your account. Tell us promptly if you suspect unauthorized access.</p>

        <h2>2. The service</h2>
        <p>HopIt provides cloud-hosted code workspaces, synchronization, local journaling, collaboration, history, and export features. Features may evolve, and some capabilities may be identified as preview, beta, or experimental. We may modify the service to improve security, reliability, legal compliance, or product functionality.</p>

        <h2>3. Your content</h2>
        <p>You retain ownership of source code and other content you submit to HopIt. You grant HopIt a limited, non-exclusive license to host, copy, transmit, process, and display that content only as necessary to provide, secure, support, and improve the service. You are responsible for having the rights needed to upload and share your content.</p>
        <p>Do not place regulated, highly sensitive, or safety-critical information in HopIt unless you have independently confirmed that the service and your configuration meet the applicable requirements.</p>

        <h2>4. Acceptable use</h2>
        <p>You may not use HopIt to:</p>
        <ul>
          <li>violate law, intellectual-property rights, privacy rights, or contractual obligations;</li>
          <li>distribute malware, facilitate unauthorized access, abuse credentials, or attack systems;</li>
          <li>harass, exploit, or harm another person;</li>
          <li>bypass quotas, access controls, security boundaries, or account restrictions;</li>
          <li>interfere with the service or impose unreasonable load on shared infrastructure; or</li>
          <li>resell or provide the service to third parties without written permission.</li>
        </ul>
        <p>Security research must be performed in good faith, against accounts and projects you control, and without accessing another user’s data or disrupting the service.</p>

        <h2>5. Plans, quotas, and billing</h2>
        <p>The Free plan and paid-plan limits shown on the pricing page form part of these terms. Storage and write limits are hard service limits, not usage-based overage charges. At a limit, HopIt may pause writes while keeping reads, exports, and your local journal available. You are responsible for upgrading, deleting unneeded cloud content, or waiting for a daily limit to reset.</p>
        <p>Paid plans are monthly subscriptions priced in U.S. dollars and renew automatically until canceled. Stripe Managed Payments and Link act as the merchant of record for eligible transactions and calculate applicable sales tax, VAT, or GST at checkout. You authorize recurring charges for the selected plan. You may manage or cancel a subscription through the customer portal; cancellation normally takes effect at the end of the current billing period unless the checkout or portal says otherwise.</p>

        <h2>6. Refunds</h2>
        <p>Payments are generally non-refundable except where required by law or approved by the merchant of record. Stripe or Link may issue a refund under its transaction-support policies, and we may approve a refund when appropriate. Cancel before renewal to avoid the next recurring charge. A refund, dispute, chargeback, fraud decision, or canceled subscription may remove paid entitlement without deleting existing project data.</p>

        <h2>7. Availability and changes</h2>
        <p>We aim to keep HopIt available and reliable, but do not promise uninterrupted or error-free operation. Maintenance, provider outages, security events, legal requirements, and product changes may affect availability. Keep independent backups or exports of valuable work.</p>

        <h2>8. Suspension and termination</h2>
        <p>You may stop using HopIt at any time and may request account deletion. We may limit, suspend, or terminate access when reasonably necessary to address a security risk, unlawful conduct, non-payment, material breach, provider requirement, or harm to the service or others. Where practical, we will provide notice and an opportunity to export accessible content.</p>

        <h2>9. Intellectual property</h2>
        <p>HopIt, its software, branding, and service design are protected by applicable intellectual-property laws. These terms do not transfer ownership of HopIt technology or branding to you. Any open-source components remain governed by their respective licenses.</p>

        <h2>10. Disclaimers</h2>
        <p>To the maximum extent permitted by law, HopIt is provided “as is” and “as available,” without warranties of merchantability, fitness for a particular purpose, non-infringement, uninterrupted availability, or loss-free synchronization. Nothing in these terms excludes a warranty or consumer right that cannot legally be excluded.</p>

        <h2>11. Limitation of liability</h2>
        <p>To the maximum extent permitted by law, HopIt and its operator will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, goodwill, data, or business interruption. HopIt’s aggregate liability relating to the service will not exceed the greater of US$100 or the amount you paid HopIt during the 12 months before the event giving rise to the claim. These limits do not apply where prohibited by law.</p>

        <h2>12. Indemnity</h2>
        <p>To the extent permitted by law, you will defend and indemnify HopIt and its operator against third-party claims arising from your content, your unlawful use of the service, or your material breach of these terms. This obligation does not apply to the extent a claim results from HopIt’s own unlawful conduct.</p>

        <h2>13. Governing law</h2>
        <p>These terms are governed by the laws of Newfoundland and Labrador and the federal laws of Canada applicable there, without regard to conflict-of-law rules. Courts located in Newfoundland and Labrador will have exclusive jurisdiction, except where mandatory consumer law provides otherwise.</p>

        <h2>14. Changes and general terms</h2>
        <p>We may update these terms as HopIt changes. We will provide reasonable notice of material changes when required. If any provision is unenforceable, the remaining provisions continue in effect. Failure to enforce a provision is not a waiver. You may not assign this agreement without consent; HopIt may assign it as part of a reorganization, financing, or transfer of the service.</p>

        <h2>15. Contact</h2>
        <p>Questions about these terms, billing, or refunds can be sent to <a href="mailto:support@hopit.dev">support@hopit.dev</a>. HopIt is operated in Newfoundland and Labrador, Canada.</p>
      </LegalPage>
    </PublicShell>
  )
}
