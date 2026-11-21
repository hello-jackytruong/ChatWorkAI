import { splitZaloMentions } from "@/features/zalo-accounts/lib/group-content"

export function ZaloGroupText({
  text,
  mentions,
}: {
  text: string
  mentions: ReadonlyArray<{ uid: string; offset: number; length: number }>
}) {
  return splitZaloMentions(text, mentions).map((part) =>
    part.uid ? (
      <mark
        className="rounded bg-primary/15 text-inherit"
        key={`${part.offset}-${part.uid}`}
        title={part.uid}
      >
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  )
}
