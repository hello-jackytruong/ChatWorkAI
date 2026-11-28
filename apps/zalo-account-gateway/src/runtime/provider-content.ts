import { toZaloAccountWebUrl } from "@chatbotx.io/sdk"

export const asNonEmptyString = (
  value: unknown,
  maxLength = 512,
): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") {
    return
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return
  }
  const normalized = String(value).trim()
  if (normalized.length > maxLength) {
    return
  }
  return normalized || undefined
}

export const asObject = (
  value: unknown,
): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

export const parseObject = (
  value: unknown,
): Record<string, unknown> | undefined => {
  const direct = asObject(value)
  if (direct) {
    return direct
  }
  if (typeof value !== "string" || value.length > 16_384) {
    return
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return withinBudget(parsed) ? asObject(parsed) : undefined
  } catch {
    return
  }
}

export const firstUrl = (
  object: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const url = toZaloAccountWebUrl(asNonEmptyString(object[key], 8192))
    if (url && url.href.length <= 8192) {
      return url.href
    }
  }
}

// Inspect selected evidence before parsing or spreading provider objects.
export const withinBudget = (
  value: unknown,
  depth = 0,
  budget = { bytes: 0 },
): boolean => {
  if (typeof value === "string") {
    budget.bytes += value.length * 2
    return value.length <= 65_536 && budget.bytes <= 262_144
  }
  if (value === null || typeof value !== "object") {
    return true
  }
  if (depth > 4) {
    return false
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 100 &&
      value.every((item) => withinBudget(item, depth + 1, budget))
    )
  }
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    if (
      (key === "params" || key === "ext") &&
      typeof (value as Record<string, unknown>)[key] === "string" &&
      ((value as Record<string, unknown>)[key] as string).length > 16_384
    ) {
      return false
    }
    if (
      ++count > 64 ||
      !withinBudget((value as Record<string, unknown>)[key], depth + 1, budget)
    ) {
      return false
    }
  }
  return true
}

const providerDecimal = /^-?\d+(?:\.\d+)?$/
export const providerNumber = (
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  const number =
    typeof value === "string" &&
    value.length <= 24 &&
    providerDecimal.test(value.trim())
      ? Number(value)
      : value
  return typeof number === "number" &&
    Number.isFinite(number) &&
    number >= min &&
    number <= max
    ? number
    : undefined
}
