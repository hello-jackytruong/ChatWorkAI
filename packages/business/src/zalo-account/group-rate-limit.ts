import { cacheConnections } from "@chatbotx.io/redis"
import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"

// Both buckets advance together or neither does. Redis time avoids gateway clock skew.
const TAKE_CAPACITY = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local values = {}
local retry = 0
for i = 1, 2 do
  local capacity = tonumber(ARGV[i + 1])
  local stored = redis.call('HMGET', KEYS[i], 'tokens', 'at')
  local tokens = math.min(capacity, tonumber(stored[1]) or capacity)
  local at = tonumber(stored[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now - at) * capacity / interval)
  values[i] = tokens
  if tokens < 1 then retry = math.max(retry, math.ceil((1 - tokens) * interval / capacity)) end
end
if retry > 0 then return retry end
for i = 1, 2 do
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
  const redis = await cacheConnections.useExisting()
  const scope = `${encodeURIComponent(input.workspaceId)}:${encodeURIComponent(input.accountId)}`
  const delay = Number(
    await redis.eval(
      TAKE_CAPACITY,
      2,
      `zalo-group-rate:{${scope}}:account`,
      `zalo-group-rate:{${scope}}:group:${encodeURIComponent(input.providerGroupId)}`,
      60_000,
      60,
      10,
    ),
  )
  if (!Number.isFinite(delay) || delay > 0) {
    throw new ZaloAccountPreDispatchError(
      `Zalo Account group rate limit; retry after ${Number.isFinite(delay) ? delay : 60_000}ms`,
    )
  }
}
