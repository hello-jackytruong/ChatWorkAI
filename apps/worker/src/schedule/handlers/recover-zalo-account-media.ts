import { distributedLock } from "@chatbotx.io/redis"
import { scavengeMediaTemp } from "../../zalo-account-media/bounded-download"
import {
  recoverZaloAccountMediaCandidates,
  recoverZaloAccountMediaDeletions,
  recoverZaloAccountMediaOrphans,
  recoverZaloAccountMediaOutbox,
  recoverZaloAccountMediaProjections,
  recoverZaloDeletedContactMedia,
} from "../../zalo-account-media/maintenance"

export async function recoverZaloAccountMedia(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:zalo-account-media",
    timeoutInSeconds: 50,
    retryTimeoutInSeconds: 1,
    fn: async () => {
      const deadline = Date.now() + 40_000
      await recoverZaloAccountMediaCandidates(
        Math.min(deadline, Date.now() + 15_000),
      )
      await recoverZaloDeletedContactMedia(deadline)
      await recoverZaloAccountMediaDeletions(deadline)
      await recoverZaloAccountMediaOrphans(deadline)
      await recoverZaloAccountMediaProjections(deadline)
      await recoverZaloAccountMediaOutbox()
      await scavengeMediaTemp()
    },
  })
}
