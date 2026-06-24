# HopIt Privacy And Encryption Plan

Last updated: 2026-06-23

## Purpose

HopIt should let a user upload everything needed to work on a project, including
files that Git would normally ignore, while still making privacy and sharing
safer than Git hosting.

The target is not just "private means hidden in the UI." The target is:

- private repo bytes are encrypted before they leave a trusted device
- shared-private repos are decrypted only by invited users and trusted devices
- `.private/` is owner-private by default even inside a shared repo
- `.private/env/` and other secrets are separately encrypted and separately
  shareable
- cloud services can coordinate auth, permissions, realtime state, metadata,
  billing, and storage, but cannot decrypt private content by themselves

This document is the implementation plan for that privacy model. It sits beside
[MVP Plan](mvp-plan.md), [Local Agent Architecture](agent-architecture.md), and
[Auth And Collaboration Plan](auth-collaboration-plan.md).

## Current Status

Implemented today:

- `.private/` paths are classified as owner-private in the file graph.
- File entries now carry derived privacy-zone metadata for repo content,
  owner-private content, secrets, and Git internals.
- `.private/env/` is skipped by default so raw secret bytes are not uploaded.
- With object storage plus either local `HOPIT_CLIENT_ENCRYPTION_KEY` or a
  `hop keys` user-vault bridge, `.private/env/` payloads can sync as
  client-encrypted object blobs.
- Object blob metadata can carry encrypted-payload metadata.
- The agent crypto/envelope helpers are extracted into a shared module with
  focused tests for key decoding, privacy-zone classification, AAD binding,
  tamper failure, object-blob unwrap, legacy envelope compatibility, device
  key wrapping, and passphrase recovery export.
- Convex schema has the first durable tables for privacy zones, trusted device
  public keys, user/codebase keyrings, wrapped keys, and key audit events.
- Convex exposes first agent-facing device/key APIs: register/list trusted
  device public keys, ensure user/codebase keyrings, create/list/revoke wrapped
  keys, and write key audit events for device trust and key changes.
- The local CLI has `hop keys status`, `hop keys init-device`, and
  `hop keys export-recovery`. The keyring stores device private keys locally,
  stores the user vault key only as a self-wrapped payload, can register public
  device/wrapped vault metadata in Convex, and can export an encrypted recovery
  file.
- Convex and local graph validation reject plaintext `.private/env/**` file
  entries.
- The local mirror/import path routes root `.env.local` into
  `.private/env/repo-root/.env.local`.
- Requester-aware reads can hide `.private/` from non-owner requesters.
- Durable memberships, invitations, scoped agent sessions, and Clerk auth are
  started.

Not implemented yet:

- private repo-wide encryption for all normal files
- repo/private/secret zone key generation and use in file encryption
- invite acceptance that grants decryption keys
- dashboard-guided device approval, recovery import, and key rotation
- path and metadata privacy for private repos
- independent secret-sharing grants
- complete revocation/rekey flows
- dashboard and agent UX for encryption health

Until the full model below exists, the current encrypted-secret support should be
treated as a narrow personal-dogfood bridge, not as the final security contract.

## Security Goals

HopIt should protect against these cases:

- An object storage bucket, object key, or storage provider account is exposed.
- Convex or another graph/metadata store is read by an operator, bug, or
  attacker.
- A HopIt web account session is compromised, but the attacker has not approved
  a trusted device and does not have local key material.
- A collaborator is allowed to read shared project files but not owner-private
  or secret files.
- A former collaborator is removed and should stop receiving future updates.
- A new device signs in but should not decrypt existing private content until an
  existing trusted device or recovery method approves it.

HopIt cannot protect against every case:

- A compromised local device can read the data that device can decrypt.
- A collaborator can copy data they were legitimately allowed to decrypt.
- A hosted web app that is allowed to handle keys can become a key-exfiltration
  risk if the deployment itself is compromised. For high-sensitivity secrets,
  the safer default is local-agent or signed-desktop handling rather than
  hosted-browser decryption.
- Revocation cannot erase data someone already downloaded. Strong revocation
  means rotating keys and using new keys for future content.

## Product Privacy Zones

Privacy must be path-aware and grant-aware. Permissions say what the product
allows; encryption keys decide what the actor can actually read.

| Zone | Default paths | Default decryptors | Sharing behavior |
| --- | --- | --- | --- |
| Public snapshot | published files outside `.private/` | everyone | May be stored or published as plaintext after explicit publish. Never includes `.private/`. |
| Private repo content | normal files outside `.private/` in a private/shared-private repo | owner trusted devices | Shared by granting the repo content key to invited users/devices. |
| Review-visible content | selected active change-set files outside `.private/` | permitted reviewers with repo key grants | Visibility can open review, but decryption still requires a key grant. |
| Owner-private content | `.private/**` | owner trusted devices | Never shared by normal repo membership. Requires an explicit owner-private grant if a future workflow allows it. |
| Secrets | `.private/env/**`, `.private/secrets/**`, routed `.env*`, credential/key files | owner trusted devices | Never shared by default. Can be shared only through explicit secret-group grants. |
| Git internals | `.git/**` and converted Git metadata | owner trusted devices by default | Sensitive by default. History sharing needs an explicit repo-history policy. |
| System metadata | codebase ids, membership rows, key ids, encrypted blob ids, event cursors | HopIt services and permitted actors | Must not contain secret values. For strict private repos, paths and sensitive metadata should be encrypted. |

## Visibility Versus Encryption

HopIt needs both permission checks and cryptographic checks.

| Product state | Server permission | Encryption grant |
| --- | --- | --- |
| Private repo, owner | owner can read/write | owner devices have repo key |
| Private repo, collaborator not invited | denied | no repo key |
| Shared-private repo, member | role can read visible content | member devices have repo key |
| Shared-private repo, member reading `.private/` | denied | no owner-private key |
| Shared-private repo, member reading shared secrets | allowed only by explicit secret grant | member devices have secret-group key |
| Public repo visitor | can read published public snapshot | no private keys required |

Server permissions are still required because they prevent unauthorized users from
listing ciphertext, metadata, comments, issues, releases, and key wraps. But they
are not enough by themselves. Private content must remain ciphertext unless the
requester has the right wrapped key.

## Key Hierarchy

The intended hierarchy is envelope encryption:

1. **Device encryption keypair**
   - One per trusted device.
   - Public key is stored in Convex.
   - Private key stays local, preferably in Keychain, Secure Enclave-backed
     storage, Windows Credential Manager, libsecret, or a signed desktop agent.

2. **Device signing keypair**
   - One per trusted device.
   - Used to sign key-grant changes, sync mutations, and device approval events.
   - Lets HopIt audit which trusted device granted access.

3. **User vault key**
   - Random symmetric key for a HopIt user.
   - Wrapped to each trusted device.
   - Also wrapped to an explicit recovery method if the user enables recovery.

4. **Repo content key**
   - Random symmetric key for normal private/shared-private repo content.
   - Wrapped by the owner user vault key.
   - Granted to collaborators by wrapping it to the collaborator's trusted
     devices or user vault.

5. **Repo private-zone key**
   - Random symmetric key for `.private/**`.
   - Owner-only by default.
   - Separate from the repo content key so normal collaboration never grants it.

6. **Secret-zone or secret-group keys**
   - Random symmetric keys for `.private/env/**` and named secret groups.
   - Owner-only by default.
   - Shared independently from code access.

7. **File data encryption key**
   - Random key per file revision or blob.
   - Encrypts the actual file bytes.
   - Wrapped by the applicable zone key.

This hierarchy keeps collaboration cheap. Adding a collaborator usually wraps the
repo content key, not every file. Rotating access can move future writes to a new
repo or zone key without rewriting the entire repository immediately.

## Crypto Envelope

Every encrypted object should have a versioned envelope. The envelope should be
small, explicit, and validated before decrypting.

Recommended fields:

```text
encryption.version
encryption.state = client-encrypted
encryption.algorithm
encryption.keyId
encryption.zoneId
encryption.fileDekWrapId
encryption.nonce
encryption.aadVersion
encryption.ciphertextHash
encryption.ciphertextSize
encryption.plaintextFingerprint
encryption.createdByDeviceId
encryption.createdAt
```

Implementation rules:

- Do not invent cryptography. Use audited primitives through the platform crypto
  stack or a vetted library.
- Use AEAD encryption, such as XChaCha20-Poly1305 or AES-256-GCM.
- Bind the envelope with authenticated associated data. AAD should include the
  codebase id, zone id, encrypted path id, file revision id, object key,
  content type, and declared plaintext size.
- For private repos, do not store raw plaintext SHA-256 as the public content
  identity. Use ciphertext hashes for storage integrity and a keyed plaintext
  fingerprint, such as HMAC under the repo or zone key, for dedupe/change
  detection visible only to key holders.
- Public/published content may use plain SHA-256 because it is intentionally
  public.
- Decryption must fail closed if the algorithm, version, AAD, key id, size, or
  hash does not match.
- Old encryption versions must remain readable through a migration path, but new
  writes should use the newest envelope.

## Metadata Privacy

The current graph exposes paths and some metadata. That is acceptable only as a
temporary personal-dogfood posture.

The target for private repos:

- file bytes are encrypted
- file names and paths are encrypted or represented by keyed path ids
- directory listings are reconstructed client-side from an encrypted manifest
- server-side indexes use opaque ids, keyed path fingerprints, and visibility
  scopes rather than plaintext paths
- size and timing leakage is minimized where practical, but not treated as a v1
  blocker unless the user chooses a strict-private mode

Recommended staged approach:

1. **Private-content v1:** encrypt all file bytes and secret bytes while keeping
   plaintext paths for functional parity.
2. **Private-metadata v1.5:** add encrypted path manifests and keyed path ids for
   private repos.
3. **Strict-private mode:** avoid plaintext path names, plaintext content hashes,
   and sensitive file metadata in Convex and object storage.

Do not market HopIt as fully zero-knowledge until private-metadata work is
complete and verified.

## Data Model Additions

Convex should store key coordination data, but never raw private keys or
plaintext content keys.

Implemented first-pass tables:

### `deviceKeys`

- `deviceId`
- `userId`
- `displayName`
- `platform`
- `encryptionPublicKey`
- `signingPublicKey`
- `status`: `pending`, `trusted`, `revoked`, `lost`
- `createdAt`, `trustedAt`, `revokedAt`
- `lastSeenAt`

### `userKeyrings`

- `userId`
- `vaultKeyId`
- `currentVersion`
- wrapped vault keys for trusted devices or links to `wrappedKeys`
- recovery configuration status, not recovery secrets

### `codebaseKeyrings`

- `codebaseId`
- `repoContentKeyId`
- `privateZoneKeyId`
- `historyKeyId`
- current key versions
- rotation state

### `privacyZones`

- `zoneId`
- `codebaseId`
- `kind`: `repo-content`, `owner-private`, `secrets`, `git-internals`,
  `public-snapshot`
- `pathPrefix`
- `defaultGrantPolicy`
- `currentKeyId`

### `secretGroups`

- `secretGroupId`
- `codebaseId`
- `name`
- `pathPrefixes`
- `currentKeyId`
- `createdByUserId`

### `wrappedKeys`

- `wrapId`
- `wrappedKeyId`
- `wrappedKeyType`: `user-vault`, `repo-content`, `private-zone`,
  `secret-group`, `file-dek`
- `recipientType`: `device`, `user`, `recovery`
- `recipientId`
- `wrappingPublicKeyId` or `wrappingKeyId`
- `algorithm`
- `ciphertext`
- `createdByUserId`
- `createdByDeviceId`
- `createdAt`
- `expiresAt`
- `revokedAt`

### `encryptedBlobs`

- `blobId`
- `codebaseId`
- `zoneId`
- `objectProvider`
- `objectKey`
- `ciphertextHash`
- `ciphertextSize`
- `encryptionEnvelope`
- `createdByDeviceId`
- `revisionId`

### `encryptedPathIndex`

- `codebaseId`
- `zoneId`
- `pathId`
- `parentPathId`
- `encryptedName`
- `pathFingerprint`
- `entryType`
- `revisionId`

### `keyAuditEvents`

- `eventId`
- `codebaseId`
- `actorUserId`
- `actorDeviceId`
- `eventType`
- `targetUserId`
- `targetDeviceId`
- `zoneId`
- `keyId`
- `createdAt`
- `signature`

## End-To-End Workflows

### New User And First Device

1. User signs in through Clerk.
2. Local agent or trusted browser creates device encryption/signing keys.
3. Device private keys are stored locally.
4. HopIt creates a user vault key locally.
5. The user vault key is wrapped to the first device.
6. Optional recovery phrase/file wraps the user vault key.
7. Convex stores only public keys, wrapped key ciphertext, and audit metadata.

Definition of done:

- Signing in alone is not enough to decrypt existing private data.
- Losing the first device without recovery means HopIt cannot decrypt for the
  user.
- The app explains recovery clearly before valuable encrypted data exists.

### Create Private Repo

1. Device creates a repo content key, private-zone key, git-internals key, and
   default secret-zone key.
2. Keys are wrapped to the owner user vault key or directly to trusted owner
   devices.
3. Repo defaults to private.
4. All new file writes use the correct privacy zone.
5. File bytes are encrypted before object upload.
6. Convex receives encrypted blob metadata and key ids only.

Definition of done:

- R2, Convex, Vercel, and an unauthenticated user cannot decrypt repo content.
- `.private/` and `.private/env/` do not share the normal repo content key.

### Import Or Mirror A Git Repo

1. Run the production-safe import/mirror scan.
2. Route root `.env.local` and secret-like paths into `.private/env/`.
3. Classify paths into privacy zones before upload.
4. Generate file DEKs and encrypt payloads locally.
5. Upload ciphertext to object storage.
6. Commit encrypted metadata and wrapped-key references to Convex.
7. Verify local manifest, encrypted graph manifest, object counts, and decrypt
   round-trip.

Definition of done:

- No raw secret bytes are uploaded.
- Normal files are encrypted if the target repo is private.
- `.git/` is owner-private or governed by an explicit history-sharing policy.

### Sync A File Edit

1. Agent detects a local write.
2. Agent records a safety-journal entry before cloud mutation.
3. Agent classifies the path into a privacy zone.
4. Agent encrypts the file body locally.
5. Agent uploads ciphertext to object storage.
6. Agent sends a per-file mutation with base revision, encrypted blob metadata,
   zone id, and key ids.
7. Convex checks actor permissions and revision guards.
8. On acknowledgement, the journal entry becomes acknowledged.

Definition of done:

- The cloud never receives plaintext for private zones.
- Stale revisions return conflict state, not silent overwrite.
- Secret-zone writes use secret keys, not repo content keys.

### Hydrate A File

1. Agent requests visible encrypted metadata from Convex.
2. Agent verifies the user/device has a key grant for the zone.
3. Agent downloads ciphertext from object storage.
4. Agent verifies ciphertext hash and envelope AAD.
5. Agent unwraps the file DEK through the device/user/repo/zone key chain.
6. Agent decrypts and writes the plaintext to the managed local cache.

Definition of done:

- A user without a key grant can see neither plaintext nor decrypted metadata.
- Tampered object bytes, path ids, or envelopes fail closed.

### Invite A Collaborator

1. Owner creates an invitation with role and content scopes.
2. Invite acceptance requires a signed-in user with the matching email.
3. The recipient registers or selects a trusted device.
4. An owner trusted device approves the grant.
5. The owner device wraps the repo content key to the recipient's device or user
   vault.
6. Convex stores the wrapped grant and audit event.
7. The recipient can decrypt only the granted zones.

Default grant:

- normal repo content only
- no `.private/`
- no `.private/env/`
- no secret groups
- no owner-private Git internals unless explicitly included

Definition of done:

- Membership without a wrapped key cannot decrypt.
- Wrapped key without active membership cannot access current metadata.
- Invite UI clearly shows whether secrets are included.

### Share Secrets

1. Owner creates or selects a secret group.
2. Owner chooses recipient users/devices.
3. UI shows an explicit warning and exact path prefixes.
4. Owner trusted device wraps the secret-group key to recipients.
5. Recipients can hydrate only that secret group.
6. Audit event records who shared which group and when.

Definition of done:

- Sharing repo code never shares secrets by accident.
- Secret sharing is path/group-specific and reversible for future updates.
- Revoking a secret group rotates the group key before new secret writes.

### Revoke Access

1. Server marks membership or device grant revoked.
2. Revoked actors stop receiving metadata and key wraps.
3. New writes use rotated repo/zone/secret keys when strong revocation is needed.
4. Existing blobs can be lazily re-encrypted or expired by retention policy.
5. Audit events record the revocation and rotation.

Definition of done:

- Revoked users cannot access future updates.
- The UI explains that already downloaded plaintext cannot be clawed back.
- Secret revocation defaults to key rotation.

### Add A New Device

1. New device signs in and creates local keypairs.
2. Existing trusted device sees a device-approval request.
3. Existing trusted device verifies user intent and wraps the user vault key to
   the new device.
4. New device can unwrap existing repo and secret grants according to policy.

Definition of done:

- Web-account login alone does not silently grant all keys to a new device.
- Device approval and recovery are visible in the dashboard and CLI.

### Recovery

1. User enables recovery before disaster.
2. Recovery phrase/file wraps the user vault key locally.
3. Recovery material is never stored as plaintext by HopIt.
4. A new device can recover the user vault key only with the recovery material.
5. Recovery use creates an audit event and can optionally rotate keys.

Definition of done:

- HopIt cannot recover private data without user-held recovery material.
- The user knows that no recovery setup means no server-side backdoor.

### Public Publish

1. User explicitly publishes a Main snapshot or release.
2. Publish excludes `.private/`, `.private/env/`, secret groups, and owner-only
   Git internals by default.
3. Published files may be emitted as plaintext Git exports or public artifacts.
4. Public snapshot records should be signed by a trusted device.

Definition of done:

- Public publish never leaks private zones.
- The published artifact can be verified against a signed manifest.

## Hosted Web Dashboard Boundary

The hosted dashboard is useful for code browsing, review, issues, releases, and
member management, but private-key handling needs care.

Recommended policy:

- Normal private repo browsing may allow browser-side decryption after device
  approval, with clear trust labeling.
- Secret browsing/import/export should default to the installed local agent or a
  signed desktop app, not arbitrary hosted JavaScript.
- The hosted app should never receive or persist raw private keys.
- Any browser-held key should be session-scoped and clearable.
- High-sensitivity operations should prefer local-agent loopback confirmation,
  device signatures, and explicit user approval.

This is the honest caveat: web-based zero-knowledge apps can protect against
storage and database compromise, but a compromised web deployment can serve
malicious JavaScript. HopIt should not hide that. The long-term secure path is a
signed local agent/desktop trust root for keys, with the hosted app as a
coordination and collaboration surface.

## Implementation Phases

### Phase 0: Freeze The Contract

Status: `Done for foundation`

- Add versioned envelope types to the graph schema. Current status: the legacy
  `clientEncryption` envelope remains compatible, and canonical `encryption`
  metadata is reserved for the wrapped-key phase.
- Add explicit privacy-zone ids to every file entry. Current status: file rows
  derive `privacyZone` and `zoneId`; local graph entries derive `privacyZone`.
- Make current `HOPIT_CLIENT_ENCRYPTION_KEY` support a legacy secret-only
  compatibility path. Current status: the legacy env key remains supported, and
  `hop keys` can now derive the same bridge key from a local user-vault keyring.
- Add fail-closed validation for unknown encryption versions.
- Add docs and CLI warnings that full private-repo encryption is not complete
  yet.

Exit criteria:

- Existing encrypted secret tests still pass.
- Unencrypted upload of secret-zone paths is rejected.
- Private-repo encryption gaps are visible in status/docs.

### Phase 1: Shared Crypto Package

Status: `Mostly done`

- Create a shared crypto module used by agent, tests, and future browser code.
  Current status: agent crypto/envelope helpers live in
  `packages/agent/src/crypto.js`.
- Implement envelope creation, validation, encrypt, decrypt, wrap, and unwrap.
  Current status: file-byte encrypt/decrypt, blob wrap/unwrap, X25519 device
  key wrapping, user-vault unwrap, and PBKDF2 recovery export are extracted.
- Add deterministic test vectors. Current status: focused round-trip and
  tamper/wrong-context tests exist, but cross-runtime deterministic vectors are
  still pending.
- Add AAD tamper, ciphertext tamper, wrong-key, wrong-path, and wrong-version
  tests.
- Keep all APIs byte-oriented.

Exit criteria:

- No product code calls low-level crypto directly.
- Tests prove round-trip and tamper failure across Node and browser-compatible
  runtimes.

### Phase 2: Device Trust And Local Key Storage

Status: `In progress`

- Add `hop keys status`, `hop keys init-device`, `hop keys export-recovery`,
  `hop keys rotate`, and `hop device approve`. Current status: status,
  init-device, and export-recovery exist; rotate and approve remain.
- Store private device keys in the OS credential store where available.
- Use an encrypted local file fallback only with an explicit passphrase. Current
  status: local keyring files use `0700`/`0600` permissions and self-wrapped user
  vault keys, but the device private keys are not yet protected by Keychain or a
  passphrase-encrypted local store.
- Add Convex `deviceKeys`, `userKeyrings`, and `wrappedKeys`. Current status:
  tables and first register/list/ensure/create/list/revoke APIs exist.
- Require trusted-device approval before a new device receives the user vault
  key. Current status: server APIs require trusted recipient devices for device
  wraps, but the human approval flow is not built yet.

Exit criteria:

- A second device cannot decrypt until approved.
- Revoked/lost devices stop receiving new grants.
- Recovery can bootstrap a new device without server-held plaintext keys.

### Phase 3: Encrypt All Private Repo Blobs

Status: `Next`

- Extend the current object-blob pipeline from secret-only encryption to
  repo-wide private-content encryption.
- Classify every path into a privacy zone before upload.
- Encrypt file bodies with per-file DEKs.
- Store ciphertext hashes and encrypted metadata.
- Replace plaintext hashes with keyed fingerprints for private repos.
- Preserve binary, symlink, empty-directory, and large-file behavior.

Exit criteria:

- Private repo normal files upload only as ciphertext.
- Hydrate/refresh/export decrypt through key grants.
- Wrong user, wrong device, wrong zone, and tampered envelope tests fail closed.

### Phase 4: Permission And Key-Grant Enforcement

Status: `Next`

- Tie `codebaseMembers` roles to key-grant eligibility.
- Add server-side checks for key-grant creation, revocation, and listing.
- Require actor/device signatures for grant changes.
- Prevent browser and agent writes from referencing zones the actor cannot write.
- Add audit events for every grant, revoke, rotate, and device approval.

Exit criteria:

- Membership alone cannot decrypt without a key grant.
- Key grant alone cannot bypass active membership.
- Every key-changing mutation is permission-checked and audited.

### Phase 5: Invite-Time Key Sharing

Status: `Next`

- Update invitation create/accept flows with encryption scopes.
- Default invites to normal repo content only.
- Add explicit options for reviewer-only access, maintainer access, and future
  secret-group access.
- Add owner-device approval flow for wrapping repo keys to recipients.
- Add dashboard and CLI status for pending key grants.

Exit criteria:

- Accepted invite can browse permitted encrypted repo files.
- Accepted invite cannot see `.private/` or secrets by default.
- Owner can see exactly which zones each member can decrypt.

### Phase 6: `.private` And Secret Sharing UX

Status: `Next`

- Keep `.private/` owner-only by default.
- Add named secret groups over `.private/env/**` and other configured prefixes.
- Add UI for share, revoke, rotate, and audit secret groups.
- Add CLI equivalents for headless/agent-only workflows.
- Add warnings when secret values are about to be shared.

Exit criteria:

- Sharing project code never shares secrets.
- Secret grants are explicit, audited, revocable, and key-rotated on revoke.
- Dashboard and CLI agree on the grant state.

### Phase 7: Private Metadata And Path Encryption

Status: `Next`

- Add encrypted path manifests for private repos.
- Replace plaintext private paths in shared cloud metadata with keyed path ids.
- Keep enough server-side opaque indexing for sync, permissions, and conflict
  handling.
- Decrypt names client-side for authorized users.
- Add migration from plaintext-path private repos to encrypted-path private repos.

Exit criteria:

- Private repo paths are not exposed to Convex/R2 as plaintext.
- Non-members and storage operators cannot infer private filenames from graph
  rows.
- Review/code-browser UI still works for authorized members.

### Phase 8: Revocation, Rotation, And Retention

Status: `Next`

- Add repo, zone, secret-group, and device key rotation flows.
- Make future writes use new keys immediately after revocation.
- Support lazy re-encryption for old blobs.
- Add retention policy for old encrypted blobs and old wrapped keys.
- Add audit summaries and user-visible security history.

Exit criteria:

- Revoking a member blocks future decryptable updates.
- Revoking a secret grant rotates the secret-group key.
- Old key material has explicit retention and deletion behavior.

### Phase 9: Import, Export, And Git Compatibility

Status: `Next`

- Make `hop import-git --production-safe` create encrypted private repos by
  default.
- Add conversion previews showing which paths enter each privacy zone.
- Add "public publish" that decrypts only publishable paths into a clean Git
  export.
- Keep owner-private export as an explicitly local, encrypted-backup-aware flow.

Exit criteria:

- Git conversion cannot accidentally upload private plaintext.
- Public Git publish cannot include `.private/` or secret groups.
- Owner-private exports clearly label their sensitivity.

### Phase 10: Hardening And External Review

Status: `Next`

- Add threat-model review before public beta.
- Add fuzz/property tests for envelopes and metadata parsing.
- Add dependency review for crypto libraries.
- Add red-team style tests for permission/key-grant bypasses.
- Add operational alerts for unexpected plaintext private blobs.
- Document incident response for key compromise and provider exposure.

Exit criteria:

- Automated checks can prove no private-zone plaintext is stored in Convex or
  object storage.
- Security docs explain exactly what HopIt can and cannot protect.
- Public release does not depend on undocumented trust assumptions.

## Verification Matrix

Required tests before claiming this complete:

- crypto envelope round-trip for text, binary, large files, symlinks, and empty
  directories
- AAD tamper fails for path, codebase id, revision id, size, and zone id changes
- wrong user/device cannot decrypt private repo content
- collaborator can decrypt normal repo files after invite acceptance
- collaborator cannot decrypt `.private/` after normal invite acceptance
- collaborator cannot decrypt secrets unless secret group is explicitly granted
- revoked collaborator cannot decrypt new writes after key rotation
- revoked/lost device cannot receive new wrapped keys
- recovery phrase/file can bootstrap a new device
- hosted dashboard never receives secret private keys in server logs or Convex
  args
- R2 object scan finds only ciphertext for private zones
- Convex document scan finds no raw secret values or private plaintext payloads
- public export omits `.private/`, `.private/env/`, and secret groups
- legacy `HOPIT_CLIENT_ENCRYPTION_KEY` secret blobs migrate or remain readable
  through a documented compatibility path

Manual verification before dogfooding with real secrets:

```bash
npm run agent:test
npm run lint
npm run check:production-config
npm run hop -- storage status --profile production
npm run hop -- storage gc --profile production
```

Additional security verification should include a scripted two-user scenario:

1. owner creates private repo
2. owner imports a repo with normal files, `.private/`, `.private/env/`, `.git/`,
   binary files, and generated files
3. collaborator accepts normal invite
4. collaborator hydrates normal files
5. collaborator fails to hydrate `.private/` and secrets
6. owner grants one secret group
7. collaborator hydrates only that group
8. owner revokes collaborator and rotates keys
9. collaborator fails to hydrate new writes

## Recommended Immediate Next Work

Completed foundation:

1. Schema placeholders for privacy zones, encrypted envelopes, device keys,
   keyrings, wrapped keys, and key audit events exist.
2. The current secret-only AES-GCM logic is extracted into a shared
   crypto/envelope module.
3. The first device keyring path exists while preserving backward compatibility
   for existing dogfood secrets.

Next implementation tranche:

1. Move local device private-key storage into Keychain/Secure Enclave-backed
   storage where possible, with a passphrase-encrypted local fallback.
2. Add repo content, owner-private, Git-internals, and secret-zone symmetric keys
   to local and Convex codebase keyrings.
3. Extend encryption from `.private/env/` to all private repo file bodies with
   per-file data-encryption keys wrapped to zone keys.
4. Add invite-time key grants for normal repo content, leaving `.private/` and
   secrets unshared by default.
5. Build secret-group grants after normal repo-content grants are verified.
6. Add revoke/rotate flows for devices, members, repo content, owner-private
   content, Git internals, and secret groups.
7. Add path encryption/private metadata once byte encryption and key grants are
   solid.

That order keeps HopIt usable while moving toward the actual product promise:
everything can be uploaded, but only the intended users and devices can decrypt
the right parts.
