# Group message contract and normalizer progress

Date: 2026-11-21. Phase 10 remains incomplete; no acceptance checkbox is complete.

## Implemented slice

- Added a strict SDK group-message schema with sender identity, provider/client IDs, original text, bounded mentions (UID/span/type), image/file attachments and quote metadata.
- Gateway normalization preserves these fields without a direct recipient or arbitrary provider fields. Direct normalization remains unchanged.
- Direct mentions take precedence over object/JSON extension fallback. Invalid spans fail closed; all-member mention type remains explicit.
- Existing group activity identity remains available even when message content is unsupported. The adapter continues scheduling metadata refresh.
- Group message transport publication, anchor creation, durable dedupe and Inbox persistence are not enabled by this slice.

## Evidence

- RED: SDK contract tests failed on the missing schema; gateway tests failed on missing group content (five expected failures, three existing tests passed).
- GREEN after formatting: SDK Zalo suites 24/24; gateway normalizer/runtime/fenced-publisher suites 25/25.
- SDK and gateway `check-types`: pass, run sequentially.
- Full `ultracite check`: pass (11,687 files).
- Agent-instruction and invariant scripts: pass; builder i18n lint: pass.
- Independent invariant review: pass. Compatibility/security behavior was reviewed inline; the invariant reviewer did not perform a general logic audit.
- Full lint is NOT passed: schema drift generator did not finish during the bounded run. The sequential retry (`pnpm turbo run lint --concurrency=1`) was stopped after 2m25s with no schema drift result. No migration was applied. All started lint/generator processes were stopped.
- An initial default `pnpm lint` accidentally allowed two internal Turbo lint tasks to overlap; it was stopped and retried with explicit concurrency one. Subsequent verification commands ran serially.

## Remaining work

Continue Phase 10 schema/anchor/durable inbox ledger, mandatory person-only customer isolation, group event publication and side-effect-free persistence/outbound policy before marking any phase acceptance complete. Phases 11–16 remain pending. Re-run the schema drift/full quality gate before calling Phase 10 verified; do not substitute a focused test pass for it.
