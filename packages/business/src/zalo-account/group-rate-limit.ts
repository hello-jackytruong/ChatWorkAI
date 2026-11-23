import { cacheConnections } from "@chatbotx.io/redis"
import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"

// Both buckets advance together or neither does. Redis time avoids gateway clock skew.
const TAKE_CAPACITY = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local values = {}
local retry = 0
for i = 1, #KEYS do
  local capacity = tonumber(ARGV[i + 1])
  local stored = redis.call('HMGET', KEYS[i], 'tokens', 'at')
  local tokens = math.min(capacity, tonumber(stored[1]) or capacity)
  local at = tonumber(stored[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now - at) * capacity / interval)
  values[i] = tokens
  if tokens < 1 then retry = math.max(retry, math.ceil((1 - tokens) * interval / capacity)) end
end
if retry > 0 then return retry end
for i = 1, #KEYS do
  redis.call('HSET', KEYS[i], 'tokens', values[i] - 1, 'at', now)
  redis.call('PEXPIRE', KEYS[i], interval * 2)
end
return 0
`

export async function takeGroupSendCapacity(input: {
  workspaceId: string
  accountId: string
  providerGroupId: string
}): Promise<void> {
  await takeCapacity(input, input.providerGroupId)
}

export async function takeDirectSendCapacity(input: {
  workspaceId: string
  accountId: string
}): Promise<void> {
  await takeCapacity(input)
}

async function takeCapacity(
  input: { workspaceId: string; accountId: string },
  providerGroupId?: string,
): Promise<void> {
  const scope = `${encodeURIComponent(input.workspaceId)}:${encodeURIComponent(input.accountId)}`
  let delay: number
  try {
    const redis = await cacheConnections.useExisting()
    delay = Number(
      providerGroupId === undefined
        ? await redis.eval(
            TAKE_CAPACITY,
            1,
            `zalo-direct-rate:{${scope}}:account`,
            60_000,
            60,
          )
        : await redis.eval(
            TAKE_CAPACITY,
            2,
            `zalo-group-rate:{${scope}}:account`,
            `zalo-group-rate:{${scope}}:group:${encodeURIComponent(providerGroupId)}`,
            60_000,
            60,
            10,
          ),
    )
    if (!Number.isFinite(delay) || delay < 0) {
      throw new Error("Invalid admission result")
    }
  } catch {
    throw new ZaloAccountPreDispatchError(
      "Zalo Account send admission unavailable",
      {
        code: "admission_unavailable",
        phase: "admission",
        retryAfterMs: 60_000,
        safeAction: "new_attempt",
      },
    )
  }
  if (delay > 0) {
    throw new ZaloAccountPreDispatchError("Zalo Account send rate limit", {
      code: "rate_limited",
      phase: "admission",
      retryAfterMs: Math.min(60_000, Math.ceil(delay)),
      safeAction: "new_attempt",
    })
  }
}
