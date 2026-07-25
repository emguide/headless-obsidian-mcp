import { GIT_AUTOCOMMIT_ENV, gitGuardEnabled } from "./env-flags.js";

// Thin compatibility shim: the pre-write git snapshot this module used to
// provide has been replaced by the commit-after-write funnel in write.ts
// (`assertSyncableBeforeWrite` + `afterWrite`, backed by git-sync.ts). This
// file now only re-exports the flag helpers for existing importers
// (config.ts, tests) until they're repointed to env-flags.js directly.
export { GIT_AUTOCOMMIT_ENV, gitGuardEnabled };
