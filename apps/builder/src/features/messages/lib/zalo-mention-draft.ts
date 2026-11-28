export type ZaloMentionRange = { uid: string; offset: number; length: number }
export type ZaloMentionQuery = { start: number; end: number; query: string }
export type ZaloMentionMember = { uid: string; name?: string }

const mentionBeforeCaret = /(?:^|\s)@([^\s@]{0,64})$/u

export function findZaloMentionQuery(
  text: string,
  caret: number,
): ZaloMentionQuery | null {
  const preceding = text.slice(0, caret)
  const match = preceding.match(mentionBeforeCaret)
  if (!match) {
    return null
  }
  const query = match[1] ?? ""
  return { start: caret - query.length - 1, end: caret, query }
}

/** Rebase selected identities around one contiguous editor change. */
export function updateZaloMentionRanges(
  before: string,
  after: string,
  mentions: readonly ZaloMentionRange[],
): ZaloMentionRange[] {
  if (!mentions.length || before === after) {
    return [...mentions]
  }
  let start = 0
  while (start < before.length && before[start] === after[start]) {
    start++
  }
  let beforeEnd = before.length
  let afterEnd = after.length
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--
    afterEnd--
  }
  return mentions.flatMap((mention) => {
    const end = mention.offset + mention.length
    if (end <= start) {
      return [mention]
    }
    if (mention.offset >= beforeEnd) {
      return [{ ...mention, offset: mention.offset + afterEnd - beforeEnd }]
    }
    return []
  })
}

export function applyZaloMention(
  text: string,
  mentions: readonly ZaloMentionRange[],
  range: ZaloMentionQuery,
  member: ZaloMentionMember,
) {
  const label = `@${member.name?.trim() || member.uid}`
  const before = text.slice(0, range.start)
  const after = text.slice(range.end)
  const space = after.startsWith(" ") ? "" : " "
  const nextText = before + label + space + after
  const next = updateZaloMentionRanges(text, nextText, mentions)
  return {
    text: nextText,
    caret: before.length + label.length + 1,
    mentions: [
      ...next.filter(({ offset }) => offset !== range.start),
      { uid: member.uid, offset: range.start, length: label.length },
    ].sort((a, b) => a.offset - b.offset),
  }
}

export function trimZaloMentionRanges(
  text: string,
  mentions: readonly ZaloMentionRange[],
) {
  const length = text.trim().length
  const leftTrim = text.length - text.trimStart().length
  return mentions
    .map((mention) => ({ ...mention, offset: mention.offset - leftTrim }))
    .filter(
      ({ offset, length: spanLength }) =>
        offset >= 0 && offset + spanLength <= length,
    )
}
