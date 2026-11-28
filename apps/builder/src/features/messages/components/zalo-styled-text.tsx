import type { ZaloAccountRichContent } from "@chatbotx.io/sdk"
import { Fragment, type ReactNode } from "react"
import { splitZaloMentions } from "@/features/zalo-accounts/lib/group-content"
import { ZaloMemberIdentity } from "./zalo-member-identity"

type StyleSpan = Extract<
  ZaloAccountRichContent,
  { kind: "styledText" }
>["spans"][number]
type Mention = { uid: string; offset: number; length: number }

const splitsSurrogatePair = (text: string, offset: number) => {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return (
    before >= 0xd8_00 &&
    before <= 0xdb_ff &&
    after >= 0xdc_00 &&
    after <= 0xdf_ff
  )
}

const validRange = (text: string, offset: number, end: number) =>
  Number.isInteger(offset) &&
  Number.isInteger(end) &&
  offset >= 0 &&
  end > offset &&
  end <= text.length &&
  !splitsSurrogatePair(text, offset) &&
  !splitsSurrogatePair(text, end)

const isList = (style: string) => style === "lst_1" || style === "lst_2"

function styledRun(text: string, styles: string[], uid?: string): ReactNode {
  const color = styles.findLast((style) => style.startsWith("c_"))
  const size = styles.findLast((style) => style.startsWith("f_"))
  let content: ReactNode = text
  if (color || size) {
    content = (
      <span
        style={{
          color: color ? `#${color.slice(2)}` : undefined,
          fontSize: size ? `${size.slice(2)}px` : undefined,
        }}
      >
        {content}
      </span>
    )
  }
  if (styles.includes("s")) {
    content = <s>{content}</s>
  }
  if (styles.includes("u")) {
    content = <u>{content}</u>
  }
  if (styles.includes("i")) {
    content = <em>{content}</em>
  }
  if (styles.includes("b")) {
    content = <strong>{content}</strong>
  }
  return uid ? (
    <ZaloMemberIdentity uid={uid}>
      <mark className="rounded bg-primary/15 text-inherit">{content}</mark>
    </ZaloMemberIdentity>
  ) : (
    content
  )
}

export function ZaloStyledText({
  text,
  spans,
  mentions = [],
}: {
  text: string
  spans: StyleSpan[]
  mentions?: readonly Mention[]
}) {
  const ranges = spans
    .filter(({ offset, length }) => validRange(text, offset, offset + length))
    .map(({ offset, length, style }) => ({
      offset,
      end: offset + length,
      style: style.toLowerCase(),
    }))
  const mentionRanges = splitZaloMentions(
    text,
    mentions.filter(({ offset, length }) =>
      validRange(text, offset, offset + length),
    ),
  ).filter(({ uid }) => uid)
  const renderRange = (start: number, end: number) => {
    const boundaries = new Set([start, end])
    for (const range of ranges) {
      if (range.offset > start && range.offset < end) {
        boundaries.add(range.offset)
      }
      if (range.end > start && range.end < end) {
        boundaries.add(range.end)
      }
    }
    for (const mention of mentionRanges) {
      const mentionEnd = mention.offset + mention.text.length
      if (mention.offset > start && mention.offset < end) {
        boundaries.add(mention.offset)
      }
      if (mentionEnd > start && mentionEnd < end) {
        boundaries.add(mentionEnd)
      }
    }
    const points = [...boundaries].sort((a, b) => a - b)
    return points.slice(0, -1).map((offset, index) => {
      const styles = ranges
        .filter((range) => range.offset <= offset && offset < range.end)
        .map(({ style }) => style)
      const mention = mentionRanges.find(
        (part) =>
          part.offset <= offset && offset < part.offset + part.text.length,
      )
      return (
        <Fragment key={offset}>
          {styledRun(
            text.slice(offset, points[index + 1]),
            styles,
            mention?.uid,
          )}
        </Fragment>
      )
    })
  }

  const lists = ranges.filter(({ style }) => isList(style))
  if (!lists.length) {
    return renderRange(0, text.length)
  }

  const blocks: Array<{
    start: number
    listStyle?: string
    lines: Array<{ start: number; end: number }>
  }> = []
  let start = 0
  for (const line of text.split("\n")) {
    const end = start + line.length
    const listStyle = lists.find(
      (range) => range.offset < end && range.end > start,
    )?.style
    const last = blocks.at(-1)
    if (last && last.listStyle === listStyle) {
      last.lines.push({ start, end })
    } else {
      blocks.push({ start, listStyle, lines: [{ start, end }] })
    }
    start = end + 1
  }
  return blocks.map((block) => {
    if (!block.listStyle) {
      const last = block.lines.at(-1)
      return (
        <div key={block.start}>
          {renderRange(block.start, last?.end ?? block.start)}
        </div>
      )
    }
    const ordered = block.listStyle === "lst_2"
    const List = ordered ? "ol" : "ul"
    return (
      <List
        className={ordered ? "list-decimal ps-5" : "list-disc ps-5"}
        key={block.start}
      >
        {block.lines.map((line) => (
          <li key={line.start}>{renderRange(line.start, line.end)}</li>
        ))}
      </List>
    )
  })
}
