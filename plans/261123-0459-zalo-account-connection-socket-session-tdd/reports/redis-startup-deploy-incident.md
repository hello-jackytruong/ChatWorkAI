# Redis consumer startup deployment incident

Date:2026-11-23 (Asia/Saigon). Failed release88d3197efa02a73b4ea8761a7bccb6cbcd73712f; Actions run45137182613/job137569189209. Job activation started15:22:54 and failed15:31:38. Production mutations were performed by the existing workflow, not this investigation.

## Observed production outcome

The new Zalo gateway was unhealthy while deployment was activating apps. The host then showed all application containers restored to the previous1d53a89c2 image, with healthz200 and readyz200. Healthy old images establish successful rollback, not a successful deployment of the new release. Actions correctly reported failure. Public Actions output intentionally redirects deployment detail to restricted host logs; no failed new-container log was obtained. No SSH/restart/rerun/deploy or database migration was performed during this fix.

## Confirmed startup regression

The new main Redis connection sets lazyConnect:true and enableOfflineQueue:false. RedisCommandConsumer duplicated those options and immediately called XREADGROUP on a client still in wait state. Installed ioredis reproduced the exact rejection: `Stream isn't writeable and enableOfflineQueue options is false`. Consumer startup failure makes transportFailed true; enabled gateway healthchecks use readyz, which cannot stay healthy on that failure path.

Existing main tests mocked the entire consumer, and previous consumer tests exercised reclaimPending rather than start. Three startup regressions first failed against the old code, then passed after the repair.

Fix: explicitly create the blocking duplicate as lazy, await connect inside the existing cleanup try/finally, and require that client's ready status before reporting ready. Keep fail-fast command settings and sanitized logging. Connection failure cleans up; stop during connection setup cannot begin reading.

## Reader/producer compatibility defect

The previous activation order started the new gateway before replacing the old worker. Old SDK lifecycle envelopes are strict and lack runtime_diagnostic/attempt/sequence; their poison handling acknowledges/deletes invalid events. New initial lifecycle/QR events could therefore be lost during that gap.

Fix: start the new worker image before the gateway. Before explicit rollback, or automatic rollback after gateway activation was attempted, validate the predecessor before stopping anything; stop the gateway and drain its event stream with the current compatible worker. Redis length probes have at most5s timeout and an overall30s drain deadline. Error/non-numeric result/deadline blocks downgrade rather than deleting events. Auto failures before the gateway step restore previous apps without unnecessary Zalo stop/drain. No table, queue, config variable or other channel implementation added.

## Verification

- Startup regression RED:3fail/3existingpass; GREEN:6pass.
- Full gateway suite:18files/96tests pass; gateway check-types passes.
- Full gateway coverage retains80% thresholds:73.49lines/73.43statements/65.93branches/65.43functions; aggregate gate still fails and is not bypassed or labelled preexisting.
- Deployment regression RED established incorrect reader order/drain; invalid-target and early-worker-failure cases also failed before their repairs. Final24deployment tests pass; shell syntax/Biome/diff checks pass.
- Final root lint and final review are recorded in the recovery PR. No corrected release has been exercised on production during this investigation.

The fix requires a new built image containing this change. Re-running the failed old-SHA job alone would run the old code again. Do not treat process health on the rollback image as verification of the fixed image.
