# Ubuntu deployment and R2

Status: local implementation and validation complete; live activation requires environment setup.

Outcome: commit existing dev work; merge latest origin/main preserving current Zalo gateway and branding; deliver a tested, unattended dev-to-Ubuntu release pipeline using R2.

Constraints: local delivery; no push or live migration; no credentials in Git; preserve existing data and business behavior. The reference repo is read-only. Its separate Zalo Personal stack does not belong here.

Non-goals: copy unrelated Zalo Personal infrastructure, change message processing, expose private storage publicly, or silently replace existing local storage credentials.

Acceptance: clean commits on dev; main ancestor of dev; quality-gated SHA-addressed images; serialized deployment; verified DB backup; explicit migration approval; health-checked activation with image rollback; production R2 configuration, prefix-restricted public reads, CORS and data-copy instructions; local validation with honest limitations.

Execution: [phase-01-delivery.md](phase-01-delivery.md).

Evidence and activation limits: [verification.md](reports/verification.md).

Follow-up: [GitHub-managed environment and bootstrap](phase-02-github-managed-env.md).
