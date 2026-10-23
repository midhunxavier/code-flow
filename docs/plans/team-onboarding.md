# Connections and team onboarding

## Goal

Make the next action obvious for a person connecting a phone, hosting a team, or joining a project. Build on the existing network listeners, SSH deployment, project roles, boards, runner connections and repository mappings.

## Product research (23 October 2026)

- [ChatGPT desktop remote connections](https://learn.chatgpt.com/docs/remote-connections) separates controlling this computer, controlling another device and SSH. Setup uses a QR code and explicit account/workspace confirmation. Hosts remain responsible for files, tools and execution; availability depends on the host staying online.
- [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control) uses session URLs/QR codes, named sessions and connection status. Local execution continues on the original machine, with reconnection after interruptions.
- These are interaction references, not protocol integrations. CodeFlow continues to use direct Wi-Fi/Tailscale HTTPS and its existing SSH transport; it does not acquire either product's relay or identity service.

## Implementation plan

1. Add a purpose-first sharing landing page with separate device, join and host paths. Keep existing links working and retain advanced management.
2. Add owner-issued, project-scoped, single-use invitations. Default to contributor, expire after 24 hours, support revocation, store only token hashes, and enforce HTTPS away from loopback.
3. Let recipients preview their project/role, create their own account or sign in with an existing one, and accept atomically. Preserve other project memberships. Never grant owner, terminal or host-execution access through an invitation.
4. Show a successful join with an immediate project-board action and a credential-free connection link for the recipient's own CodeFlow installation. Guide repository mapping and show readiness per project.
5. Include invitation creation in project People and local/SSH team-server setup. Keep account administration available for recovery and existing users.
6. Validate storage migration, expiry/replay/revocation, authorization and transport boundaries; run browser journeys with independent owner/member contexts, local runner connection, project isolation, mobile layout and existing connection regressions.

## Acceptance criteria

- Personal pairing and teammate membership have distinct entry points and explanations.
- An owner can invite a person without choosing or sending their password.
- A recipient lands in the intended project and can identify where work runs.
- Invitations do not bypass project roles, network rules, existing host grants or HTTPS.
- A connected teammate can map a local repository and open its shared board.
- Failure states tell the person what to do next without claiming an unreachable server is ready.

## Scope limits

Network membership, DNS, certificate issuance and firewall rules remain prerequisites checked/explained by the existing setup. This change does not add public relay hosting, simultaneous editing of one checkout, or automatic merging.

## Implemented behavior

- Three purpose cards lead to device access, joining and hosting. Existing management and legacy bookmarks still work.
- Project People and both server-setup targets issue/revoke invitations. New accounts choose their own password; existing accounts retain unrelated and stronger memberships.
- Browser joins open the intended board. Contributors get a reusable, credential-free connection hint, and their own CodeFlow shows repository readiness with a folder picker.
- Invitation and setup views load on demand to keep startup JavaScript below the existing 850 KB budget.

## Validation

- Storage/authorization tests cover one-use acceptance, concurrent redemption, expiry, revocation, HTTPS enforcement, existing-account membership preservation, hashed secrets, legacy documents and invalid links.
- Five new browser scenarios exercise invitation issuance, mobile acceptance, separate-computer connection, repository mapping, shared comments, a completed fixture-agent run, replay/revocation failures, and existing-account joins.
- Existing team, Tailscale, SSH hosting, shared-account and settings browser suites cover 39 additional scenarios. SSH setup tests now issue and revoke invitations through the actual setup proxy.
- Desktop/mobile axe checks and screenshots were inspected. TypeScript and production builds passed. The initial full-suite startup-size failure was corrected with lazy loading and its regression check passed.
- Tests use temporary state, real Chrome/server/HTTPS flows, deterministic agent fixtures and simulated Tailscale/SSH environments. A real deployment must still verify DNS, certificate trust and reachability from the team's devices; no real network or team membership was modified.
