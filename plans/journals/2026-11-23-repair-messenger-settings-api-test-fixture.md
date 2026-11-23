---
title: repair Messenger settings API test fixture
date: 2026-11-23
summary: PR 2 CI fixture omitted the new non-null Messenger history preference
---

# repair Messenger settings API test fixture

## What happened
PR #2 CI run 45108772330 failed in builder test shard 5/8. The existing channel-settings public API GET test mocked a Messenger integration without `coexistSkipNamelessContacts`, causing the new output schema to raise `ZodError: expected boolean, received undefined`. The same test failed locally before the fix. Other shards were canceled by matrix fail-fast.

## Decision
Update the fixture to reflect the migrated database row. Keep API validation strict. Add tests for GET returning both saved boolean values without exposing auth and PATCH forwarding explicit false to the shared writer.

## Verification
The five focused builder suites passed 60 tests; repository lint passed. A separate tester is checking the full builder shard. Final GitHub CI verification follows the fix push.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
