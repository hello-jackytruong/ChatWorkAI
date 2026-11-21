import { zaloAccountMessageStateService } from "@chatbotx.io/business/zalo-account"
import { distributedLock } from "@chatbotx.io/redis"

/** At most 10,000 rows/tick, independently committed batches. */
export async function purgeZaloMessageState(): Promise<void> {
  await distributedLock.runExclusive({
    key: "schedule:zalo-message-state",
    timeoutInSeconds: 50,
    retryTimeoutInSeconds: 1,
    fn: purgeBatches,
  })
}

async function purgeBatches(): Promise<void> {
  const deadline = Date.now() + 40_000
  for (let batch = 0; batch < 10 && Date.now() < deadline; batch++) {
    if (!(await zaloAccountMessageStateService.purgeExpired())) {
      break
    }
  }
}
