---
title: Fix Turbopack dev reload loop
date: 2026-11-20
summary: Disabled server-side Fast Refresh to stop full-page HMR restarts while retaining the persistent development cache.
---

# Fix Turbopack dev reload loop

## What happened

The builder repeatedly refreshed while idle. Browser diagnostics showed Turbopack sending `type: "restart"` for an unchanged entry chunk with no diagnostics, and the client stack called `restart -> handleApply -> triggerUpdate`.

## Decision

Set `experimental.turbopackServerFastRefresh` to `false` in `apps/builder/next.config.ts`. Persistent filesystem caching remains enabled so later development starts can reuse compiled output.

## Verification

The project restarted with Builder on 3123, Realtime on 1999, and Zalo Account gateway on 3211. A browser observation recorded no restart messages, document navigations, or runtime exceptions. Ultracite checked the modified config successfully.

## Next steps

Keep the server-side Fast Refresh guard until the upstream Turbopack invalidation issue is resolved and revalidated against this workspace.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
