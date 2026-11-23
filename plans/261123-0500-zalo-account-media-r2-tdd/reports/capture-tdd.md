# Inbound capture TDD evidence

2026-11-23. Worktree: `/Users/jacky/.codex/worktrees/zalo-account-media-r2/ChatWorkAI`.

## Scope delivered

SDK inbound-only strict descriptors (maximum 12), direct/group descriptor-only content, unchanged image/file outbound schema; gateway known media and typed card assets; missing source markers; preserved source identity and provider metadata; legacy image/file display projection; integration descriptor transfer. Sticker read command flows SDK → executor → account-owned pool/runtime → authenticated API `getStickersDetail`, maximum 20 numeric IDs and three variants, per-API cache maximum 1000 entries/15 minutes. Original animation bytes are selected as independent variants, never decoded/transcoded.

Private transport contract: `payload.mediaResources?: ZaloAccountMediaResource[]`; integration carries it in `message.contentAttributes.zaloAccount.mediaResources`. A descriptor has kind, role, stable slot, providerResourceId/providerVersion, source `url` OR `sourceMissing: "source_missing"`, optional filename/MIME/size/dimensions/durationMs/animated hints. **The ingress owner must register/encrypt source locators and strip URL-bearing descriptors before database/public message projection.** The pure integration mapper performs no database writes.

Sticker command: `kind: "get_sticker_resources"`, account route, owned target and `stickerIds: string[]`; applied result `stickerResources: Array<{stickerId,resources}>`. Public transport service is owned by the controller. No send API, sticker picker or historical/provider profile crawl was added.

## Commands and observed results

All Vitest commands use `VITEST_MAX_WORKERS=1` and `exec vitest run`, with paths relative to the selected workspace.

- Baseline: gateway `__tests__/provider-message.test.ts __tests__/outbound-attachment.test.ts`: 2 files / 13 tests passed before implementation.
- RED: gateway `__tests__/media-capture.test.ts`: 9 failed / 1 passed. Unsupported-content rejection prevented descriptor-only direct/group video/voice/GIF/sticker. Missing-source assertion failed as expected.
- RED: gateway `__tests__/sticker-resource.test.ts`: missing module, before implementation.
- GREEN: gateway provider-message/outbound/media-capture/sticker-resource/command-executor/pool/runtime: 7 files / 53 tests passed. Subsequent card-bound and command-dispatch assertions brought the focused capture/sticker/executor run to 27 passing tests.
- SDK `__tests__/zalo-account-media.test.ts __tests__/zalo-account.test.ts __tests__/zalo-account-transport.test.ts __tests__/zalo-account-group-message.test.ts`: 4 files / 36 tests passed.
- Integration `__tests__/message.test.ts`: 6 tests passed, including descriptor-only transfer.
- `pnpm --filter @chatbotx.io/sdk check-types`: passed.
- `pnpm exec ultracite check` against all 16 owned source/test files: passed.
- Gateway and integration `check-types`: blocked by concurrent media database pgEnum tuple errors and worker-config no-op queue union errors in other agents' files. Gateway's missing test mock was corrected. Controller notified; no errors hidden.

## Limits and remaining integration gates

No live provider calls, migrations or commits. URL acquisition safety and MIME magic are downloader responsibilities; gateway parsing selects explicit known keys and rejects credentials in source URLs. This suite covers current/history-shaped payload normalization without adding provider history fetching. Whole-repository lint, integrated typechecks, coverage thresholds, ingress registration and end-to-end durable bytes are controller gates, not claimed by this report.
