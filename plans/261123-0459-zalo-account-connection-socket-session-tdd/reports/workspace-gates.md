# Full workspace gate results

Date:2026-11-23. Full coverage commands ran sequentially with VITEST_MAX_WORKERS=1; existing80% thresholds enabled. No baseline run or threshold bypass. All commands completed.

|Workspace|Behavior tests from full coverage invocation|Statements / branches / functions / lines|Gate|
|---|---|---|---|
|zalo-account-gateway|Tests  93 passed (93)|71.14% / 64.89% / 63.27% / 71.17%|FAIL: unchanged80% threshold|
|sdk|Tests  272 passed (272)|77.44% / 63.77% / 63.97% / 77.57%|FAIL: unchanged80% threshold|
|database|Tests  1952 passed / 627 skipped (2579)|54.16% / 39.76% / 39.36% / 53.9%|FAIL: unchanged80% threshold|
|business|Tests  1 failed / 10819 passed / 552 skipped (11372)|Not reported (test assertion failed)|FAIL at first invocation; fixture repaired; plain full rerun PASS|
|connections|Tests  172 passed / 27 skipped (199)|86.25% / 77.39% / 87.5% / 86.19%|FAIL: unchanged80% threshold|
|worker|Tests  5522 passed (5522)|82.89% / 76.21% / 84.22% / 82.94%|FAIL: unchanged80% threshold|
|realtime-protocol|Tests  107 passed (107)|95.05% / 84.82% / 94.82% / 95.03%|PASS|
|builder|Tests  1 failed / 11482 passed / 2 skipped (11485)|Not reported (test assertion failed)|FAIL at first invocation; parity manifest repaired; focused rerun PASS|

Post-fix business full plain suite:675files/10820tests pass,52files/552tests skipped,exit0. Corrected full coverage rerun not claimed.

Builder full invocation:1250files pass/1parity-manifest assertion fails;11482tests pass/1fails/2skipped. That exact manifest failure was repaired against the existing public status route. Post-fix parity/public/action tests3files/15tests pass. App implementation did not change after the full builder run started. A successful corrected full coverage invocation is not claimed. Nonfatal jsdom HTMLMediaElement/Canvas warnings are distinct from the one assertion failure.

Dedicated real PostgreSQL suite separately executed11tests with0skips; ordinary opt-in skips above are not concurrency proof.

Exact command/status records: [gate-results.json](./gate-results.json), [business post-fix result](./post-fix-results.json). Logs remain temporary under /tmp/zalo-p0-*.log; this report includes no credentials.

Disposition: implementation DONE_WITH_CONCERNS. Overall plan/Phase4 stays in progress. Coverage and live release gates block a production-readiness claim. Coverage failures are not labelled preexisting because no baseline comparison was run.
