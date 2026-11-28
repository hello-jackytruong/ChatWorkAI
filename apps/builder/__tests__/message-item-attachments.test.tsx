import type { TenantSettings } from "@chatbotx.io/business"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AttachmentResource } from "@/features/attachments/schema/resource"
import { MessageItem } from "@/features/messages/components/message-item"
import type { MessageResourceWithRelations } from "@/features/messages/schema/resource"
import { TenantProvider } from "@/features/tenant/tenant-settings-provider"

/** Echoes the key back so assertions never depend on the English copy. */
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("next/image", () => ({
  default: ({
    alt,
    onError,
    src,
  }: {
    alt: string
    onError?: () => void
    src: string
  }) => (
    // biome-ignore lint/performance/noImgElement: test double exposes the src passed to Next Image
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: forwards Next Image's load-error handler
    <img alt={alt} height={120} onError={onError} src={src} width={120} />
  ),
}))

// Exposes the `prefetch` prop: in production Next prefetches a visible <Link>,
// which would execute the media proxy for every attachment on screen.
vi.mock("next/link", () => ({
  default: ({
    children,
    prefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    prefetch?: boolean | null
  }) => (
    <a data-prefetch={String(prefetch)} {...props}>
      {children}
    </a>
  ),
}))

// MediaLibraryTrigger imports "use server" query modules at module scope
// that drag in a live pg Pool under vitest; stub it to keep this test about
// attachment rendering.
vi.mock("@/features/media-library/components/media-library-trigger", () => ({
  MediaLibraryTrigger: () => null,
}))

// The real call card pulls in useOutboundCallMode/useWhatsappCallStarter,
// which chain into the same "use server" calling actions — stub it for the
// same reason (its own contents are covered by whatsapp-call-card.test.tsx).
vi.mock("@/features/messages/components/whatsapp-call-card", () => ({
  WhatsappCallCard: () => <div data-slot="whatsapp-call-card">audioCall</div>,
}))

// Comment bubbles render the like/hide/reply actions, which need the chat
// store; stub them to keep this test about what the bubble itself shows.
vi.mock("@/features/messages/components/message-actions", () => ({
  MessageActions: () => null,
  MessageActionsEditor: () => null,
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

const tenantSettings = {
  storageUrl: "https://cdn.example.com",
} as unknown as TenantSettings

function renderComponent(ui: React.ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TenantProvider settings={tenantSettings}>{ui}</TenantProvider>,
    )
  })
  return container
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  container = null
  root = null
})

const makeMessage = (overrides: Partial<MessageResourceWithRelations> = {}) =>
  ({
    id: "msg-1",
    workspaceId: "ws-1",
    conversationId: "conv-1",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    messageType: "outgoing",
    type: "message",
    text: null,
    deletedAt: null,
    attributes: null,
    contentAttributes: null,
    attachments: [],
    ...overrides,
  }) as unknown as MessageResourceWithRelations

const makeImageAttachment = (id: string) =>
  ({
    id,
    fileType: "image",
    url: `https://cdn.example.com/${id}.png`,
    name: `${id}.png`,
    originPath: `public/${id}.png`,
    width: 400,
    height: 300,
  }) as unknown as AttachmentResource

const makeFileAttachment = (id: string) =>
  ({
    id,
    fileType: "file",
    url: `https://cdn.example.com/${id}.pdf`,
    name: `${id}.pdf`,
    originPath: `public/${id}.pdf`,
  }) as unknown as AttachmentResource

const makeProxyAttachment = (
  id: string,
  fileType: AttachmentResource["fileType"],
  mimeType: string,
) =>
  ({
    id,
    fileType,
    mimeType,
    url: `https://builder.example.com/media/attachment/${id}-token`,
    name: `${id}.${fileType}`,
    originPath: `pending/${id}`,
    width: fileType === "image" ? 400 : null,
    height: fileType === "image" ? 300 : null,
  }) as unknown as AttachmentResource

describe("MessageItem attachment rendering — multiple images", () => {
  test("an explicit null server URL renders the existing placeholder instead of rebuilding the origin path", () => {
    const attachment = {
      ...makeImageAttachment("failed-image"),
      originPath: "failed:unresolvable",
      url: null,
    } as unknown as AttachmentResource

    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [attachment],
        })}
      />,
    )

    expect(el.querySelector("img")).toBeNull()
    expect(el.querySelector('a[href*="failed:unresolvable"]')).toBeNull()
    expect(el.textContent).toContain("failed-image.png")
  })

  test("image, video, audio, and file render their absolute server URLs unchanged", () => {
    const image = makeProxyAttachment("image", "image", "image/jpeg")
    const video = makeProxyAttachment("video", "video", "video/mp4")
    const audio = makeProxyAttachment("audio", "audio", "audio/mpeg")
    const file = makeProxyAttachment("file", "file", "application/pdf")

    const el = renderComponent(
      <MessageItem
        message={makeMessage({ attachments: [image, video, audio, file] })}
      />,
    )

    expect(el.querySelector("img")?.getAttribute("src")).toBe(image.url)
    expect(el.querySelector("video source")?.getAttribute("src")).toBe(
      video.url,
    )
    expect(el.querySelector("audio source")?.getAttribute("src")).toBe(
      audio.url,
    )
    expect(
      el.querySelector(`a[href="${file.url}"]`)?.getAttribute("href"),
    ).toBe(file.url)
  })

  test("image-grid items render their absolute server URLs unchanged", () => {
    const first = makeProxyAttachment("image-1", "image", "image/jpeg")
    const second = makeProxyAttachment("image-2", "image", "image/jpeg")

    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [first, second] })} />,
    )

    expect(
      Array.from(el.querySelectorAll("img"), (image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([first.url, second.url])
  })

  test("a single image without stored dimensions gets an explicit width instead of collapsing", () => {
    // Media-library sends store no width/height. A chat bubble sizes to its
    // content, so a box with only max-width and an aspect ratio resolves to 0×0.
    const attachment = {
      ...makeImageAttachment("unsized"),
      width: null,
      height: null,
    } as unknown as AttachmentResource

    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    const frame = el.querySelector("img")?.parentElement
    expect(frame?.className.split(" ")).toContain("w-80")
    expect(frame?.className.split(" ")).toContain("max-w-full")
  })

  test("a single image renders without the grid wrapper", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [makeImageAttachment("img-1")],
        })}
      />,
    )

    expect(el.querySelector('[data-slot="attachment-image-grid"]')).toBeNull()
    expect(el.querySelectorAll("img")).toHaveLength(1)
  })

  test("exactly 2 images render a 2-column grid, not a 3-column grid with an empty cell", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [
            makeImageAttachment("img-1"),
            makeImageAttachment("img-2"),
          ],
        })}
      />,
    )

    const grid = el.querySelector('[data-slot="attachment-image-grid"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain("grid-cols-2")
    expect(grid?.className).not.toContain("grid-cols-3")
    expect(grid?.querySelectorAll("img")).toHaveLength(2)
  })

  test("multiple images render inside a 3-column grid", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [
            makeImageAttachment("img-1"),
            makeImageAttachment("img-2"),
            makeImageAttachment("img-3"),
          ],
        })}
      />,
    )

    const grid = el.querySelector('[data-slot="attachment-image-grid"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain("grid-cols-3")
    expect(grid?.querySelectorAll("img")).toHaveLength(3)
  })

  test("non-image attachments stay outside the image grid", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [
            makeImageAttachment("img-1"),
            makeImageAttachment("img-2"),
            makeFileAttachment("file-1"),
          ],
        })}
      />,
    )

    const grid = el.querySelector('[data-slot="attachment-image-grid"]')
    expect(grid?.querySelectorAll("img")).toHaveLength(2)
    expect(el.textContent).toContain("file-1.pdf")
  })
})

describe("MessageItem attachment rendering — fallback on load failure", () => {
  const fallbackUrl = "https://builder.example.com/media/attachment/token"
  const retryUrl = `${fallbackUrl}?retry=1`

  const failLoading = (element: Element | null | undefined) => {
    act(() => {
      element?.dispatchEvent(new Event("error"))
    })
  }

  test("an image that fails to load steps through the fallback URL and then its retry form", () => {
    const attachment = {
      ...makeImageAttachment("img-1"),
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    failLoading(el.querySelector("img"))
    expect(el.querySelector("img")?.getAttribute("src")).toBe(fallbackUrl)

    failLoading(el.querySelector("img"))
    expect(el.querySelector("img")?.getAttribute("src")).toBe(retryUrl)

    failLoading(el.querySelector("img"))
    expect(el.querySelector("img")?.getAttribute("src")).toBe(retryUrl)
  })

  test("an image-grid item that fails to load switches to its fallback URL", () => {
    const first = {
      ...makeImageAttachment("img-1"),
      fallbackUrl,
    } as unknown as AttachmentResource
    const second = makeImageAttachment("img-2")
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [first, second] })} />,
    )

    failLoading(el.querySelectorAll("img")[0])

    expect(
      Array.from(el.querySelectorAll("img"), (image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([fallbackUrl, second.url])
  })

  test("a video source that fails to load switches to its fallback URL", () => {
    const attachment = {
      ...makeProxyAttachment("video", "video", "video/mp4"),
      url: "https://cdn.example.com/video.mp4",
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    failLoading(el.querySelector("video source"))

    expect(el.querySelector("video source")?.getAttribute("src")).toBe(
      fallbackUrl,
    )
  })

  test("a mid-playback error on the video element itself switches to its fallback URL", () => {
    const attachment = {
      ...makeProxyAttachment("video", "video", "video/mp4"),
      url: "https://cdn.example.com/video.mp4",
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    failLoading(el.querySelector("video"))

    expect(el.querySelector("video source")?.getAttribute("src")).toBe(
      fallbackUrl,
    )
  })

  test("an audio element error switches to its fallback URL", () => {
    const attachment = {
      ...makeProxyAttachment("audio", "audio", "audio/mpeg"),
      url: "https://cdn.example.com/audio.mp3",
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    failLoading(el.querySelector("audio"))

    expect(el.querySelector("audio source")?.getAttribute("src")).toBe(
      fallbackUrl,
    )
  })

  test("one failure reported by both the source and the media element advances a single step", () => {
    const attachment = {
      ...makeProxyAttachment("video", "video", "video/mp4"),
      url: "https://cdn.example.com/video.mp4",
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )
    const source = el.querySelector("video source")
    const video = el.querySelector("video")

    act(() => {
      source?.dispatchEvent(new Event("error"))
      video?.dispatchEvent(new Event("error"))
    })

    expect(el.querySelector("video source")?.getAttribute("src")).toBe(
      fallbackUrl,
    )
  })

  test("a video loads lazily on its primary URL but loads and plays on its own once recovering", () => {
    const attachment = {
      ...makeProxyAttachment("video", "video", "video/mp4"),
      url: "https://cdn.example.com/video.mp4",
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    expect(el.querySelector("video")?.getAttribute("preload")).toBe("none")
    expect(el.querySelector("video")?.hasAttribute("autoplay")).toBe(false)

    failLoading(el.querySelector("video source"))

    expect(el.querySelector("video")?.getAttribute("preload")).toBe("auto")
    expect(el.querySelector("video")?.hasAttribute("autoplay")).toBe(true)
  })

  test("a file link downloads through the fallback URL and offers a reload from the channel", () => {
    const attachment = {
      ...makeFileAttachment("file-1"),
      fallbackUrl,
    } as unknown as AttachmentResource
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    // The fallback re-signs the stored key on every click, so a link kept open
    // past the presign lifetime still downloads.
    expect(el.querySelector(`a[href="${fallbackUrl}"]`)?.textContent).toBe(
      attachment.url,
    )
    const reload = el.querySelector(`a[href="${retryUrl}"]`)
    expect(reload?.getAttribute("aria-label")).toBe("reloadAttachment")
    expect(reload?.getAttribute("target")).toBe("_blank")
    // Neither link may be prefetched: the reload would call the channel API
    // and queue a restore just because the message scrolled into view.
    expect(
      el
        .querySelector(`a[href="${fallbackUrl}"]`)
        ?.getAttribute("data-prefetch"),
    ).toBe("false")
    expect(reload?.getAttribute("data-prefetch")).toBe("false")
  })

  test("image links never prefetch, since they can point at the media proxy", () => {
    const single = { ...makeImageAttachment("img-1"), fallbackUrl }
    const unsized = {
      ...makeImageAttachment("img-2"),
      width: null,
      height: null,
      fallbackUrl,
    }
    const grid = [makeImageAttachment("img-3"), makeImageAttachment("img-4")]

    for (const attachments of [[single], [unsized], grid]) {
      const el = renderComponent(
        <MessageItem
          message={makeMessage({
            attachments: attachments as unknown as AttachmentResource[],
          })}
        />,
      )
      const links = Array.from(el.querySelectorAll("a")).filter((link) =>
        link.querySelector("img"),
      )
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link.getAttribute("data-prefetch")).toBe("false")
      }
      act(() => root?.unmount())
      root = null
      container?.remove()
    }
  })

  test("a file link without a fallback URL keeps its stored URL and no reload action", () => {
    const attachment = makeFileAttachment("file-1")
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    expect(el.querySelector(`a[href="${attachment.url}"]`)).not.toBeNull()
    expect(el.querySelector('a[aria-label="reloadAttachment"]')).toBeNull()
  })

  test("an attachment without a fallback URL keeps its URL when loading fails", () => {
    const attachment = makeImageAttachment("img-1")
    const el = renderComponent(
      <MessageItem message={makeMessage({ attachments: [attachment] })} />,
    )

    failLoading(el.querySelector("img"))

    expect(el.querySelector("img")?.getAttribute("src")).toBe(attachment.url)
  })
})

describe("MessageItem attachment rendering — gif", () => {
  test("renders an image/gif attachment as an image", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [makeProxyAttachment("gif-1", "gif", "image/gif")],
        })}
      />,
    )

    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "https://builder.example.com/media/attachment/gif-1-token",
    )
    expect(el.querySelector("video")).toBeNull()
  })

  test("autoplays a video gif muted and on loop, without controls", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          attachments: [makeProxyAttachment("gif-2", "gif", "video/mp4")],
        })}
      />,
    )

    const video = el.querySelector("video")
    expect(video).not.toBeNull()
    expect(video?.autoplay).toBe(true)
    expect(video?.loop).toBe(true)
    expect(video?.muted).toBe(true)
    expect(video?.hasAttribute("controls")).toBe(false)
    expect(video?.querySelector("source")?.getAttribute("type")).toBe(
      "video/mp4",
    )
  })
})

describe("MessageItem comment without text", () => {
  test("shows a note for a comment whose media the channel does not expose", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          type: "comment",
          messageType: "incoming",
          text: null,
          attachments: [],
        })}
      />,
    )

    expect(el.textContent).toContain("commentMediaUnavailable")
  })

  test("shows the attachment instead of the note when the media was downloaded", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          type: "comment",
          messageType: "incoming",
          text: null,
          attachments: [makeImageAttachment("comment-gif")],
        })}
      />,
    )

    expect(el.textContent).not.toContain("commentMediaUnavailable")
    expect(el.querySelector("img")).not.toBeNull()
  })

  test("keeps the deleted label for a deleted media-only comment", () => {
    const el = renderComponent(
      <MessageItem
        message={makeMessage({
          type: "comment",
          messageType: "incoming",
          text: null,
          deletedAt: new Date("2024-01-02T00:00:00Z"),
        })}
      />,
    )

    expect(el.textContent).toContain("messageDeleted")
    expect(el.textContent).not.toContain("commentMediaUnavailable")
  })
})

describe("Zalo group message translation", () => {
  test.each([
    false,
    true,
  ])("keeps group source text unless a translation is available (%s)", (translated) => {
    const message = makeMessage({
      messageType: "incoming",
      text: "Hello @Mai",
      contentAttributes: {
        zaloAccount: {
          group: {
            providerMessageId: "provider-1",
            threadId: "group-1",
            threadType: "group",
            senderId: "sender-1",
            timestampMs: 1_790_000_000_000,
            msgType: "webchat",
            isSelf: false,
            text: "Hello @Mai",
            attachments: [],
            mentions: [{ uid: "mai", offset: 6, length: 4, type: 0 }],
          },
        },
      },
    })
    const element = renderComponent(
      <MessageItem
        message={message}
        translation={
          translated
            ? {
                mainText: "Xin chào @Mai",
                footer: <span>original-footer</span>,
              }
            : undefined
        }
        zaloGroup
      />,
    )
    expect(element.querySelector("pre")?.textContent).toBe(
      translated ? "Xin chào @Mai" : "Hello @Mai",
    )
    if (translated) {
      expect(element.textContent).toContain("original-footer")
    }
  })
})

test("Zalo recalled marker suppresses raw text and retained attachment URLs", () => {
  const el = renderComponent(
    <MessageItem
      message={makeMessage({
        sourceId: "za:1:user:2:3",
        text: "original-secret",
        contentAttributes: { zaloAccount: { lifecycle: { recalled: true } } },
        attachments: [makeImageAttachment("secret-image")],
      })}
    />,
  )
  expect(el.textContent).toContain("recalled")
  expect(el.textContent).not.toContain("original-secret")
  expect(el.querySelector("img[src*=secret-image]")).toBeNull()
})

test("Zalo delete-only-me shows provider state while preserving the local original", () => {
  const el = renderComponent(
    <MessageItem
      message={makeMessage({
        sourceId: "za:1:user:2:3",
        text: "retained original",
        contentAttributes: {
          zaloAccount: {
            lifecycle: { providerDeletedForMeAt: "2026-11-23T00:00:00Z" },
          },
        },
      })}
    />,
  )
  expect(el.textContent).toContain("retained original")
  expect(el.textContent).toContain("deletedOnMyZalo")
})

test("retained quote shows a safe recall marker without hiding the reply body", () => {
  const el = renderComponent(
    <MessageItem
      message={makeMessage({
        sourceId: "za:1:user:2:reply",
        text: "reply body",
        contentAttributes: {
          zaloAccount: {
            retainedQuote: {
              sourceId: "za:1:user:2:parent",
              lifecycle: { recalled: true },
            },
          },
        },
      })}
    />,
  )
  expect(el.textContent).toContain("reply body")
  expect(el.querySelector("blockquote")?.textContent).toContain("recalled")
})

vi.mock("@/features/zalo-accounts/actions/account-operations.action", () => ({
  inspectZaloAccountMessageAction: vi.fn(),
}))

describe("Zalo image attachment presentation", () => {
  const zalo = (attachment: AttachmentResource) =>
    makeMessage({
      contentAttributes: { zaloAccount: { accountId: "a" } },
      attachments: [attachment],
    })

  test("previews image MIME files inline while retaining the download link", () => {
    const attachment = {
      ...makeFileAttachment("photo"),
      mimeType: "image/jpeg",
    }
    const el = renderComponent(<MessageItem message={zalo(attachment)} />)
    expect(el.querySelector("img")?.getAttribute("src")).toBe(attachment.url)
    expect(el.querySelector(`a[href="${attachment.url}"]`)).not.toBeNull()
  })

  test("updates a pending Zalo file to its image preview when media metadata arrives without remounting", () => {
    const pending = {
      ...makeFileAttachment("live-photo"),
      name: null,
      mimeType: "application/octet-stream",
      url: null,
    } as AttachmentResource
    const el = renderComponent(<MessageItem message={zalo(pending)} />)
    expect(el.querySelector("img")).toBeNull()
    const ready = {
      ...pending,
      mimeType: "image/jpeg",
      url: "https://signed.test/live-photo.jpg",
    }
    act(() =>
      root?.render(
        <TenantProvider settings={tenantSettings}>
          <MessageItem message={zalo(ready)} />
        </TenantProvider>,
      ),
    )
    expect(el.querySelector("img")?.getAttribute("src")).toBe(ready.url)
  })

  test("keeps image MIME files with terminal null URLs private and image-specific", () => {
    const attachment = {
      ...makeFileAttachment("private-photo"),
      mimeType: "image/jpeg",
      url: null,
      originPath: "https://provider.test/private.jpg",
    } as AttachmentResource
    const el = renderComponent(<MessageItem message={zalo(attachment)} />)
    expect(el.querySelector("img, a")).toBeNull()
    expect(el.textContent).toContain("failedToPreviewImage")
    expect(el.textContent).not.toContain("Attachment")
  })

  test("keeps ordinary files and non-Zalo image files as file cards", () => {
    const file = {
      ...makeFileAttachment("document"),
      mimeType: "application/pdf",
    }
    const el = renderComponent(<MessageItem message={zalo(file)} />)
    expect(el.querySelector("img")).toBeNull()
    act(() =>
      root?.render(
        <TenantProvider settings={tenantSettings}>
          <MessageItem
            message={makeMessage({
              attachments: [{ ...file, mimeType: "image/jpeg" }],
            })}
          />
        </TenantProvider>,
      ),
    )
    expect(el.querySelector("img")).toBeNull()
  })

  test("falls back to the file link when a generic MIME filename preview fails", () => {
    const attachment = {
      ...makeFileAttachment("hint"),
      name: "photo.JPG",
      mimeType: "application/octet-stream",
    }
    const el = renderComponent(<MessageItem message={zalo(attachment)} />)
    const image = el.querySelector("img")
    expect(image).not.toBeNull()
    act(() => image?.dispatchEvent(new Event("error")))
    expect(el.querySelector("img")).toBeNull()
    expect(el.querySelector(`a[href="${attachment.url}"]`)).not.toBeNull()
  })

  test.each([
    "pending",
    "downloading",
  ])("shows processing rather than an error while Zalo image is %s", (state) => {
    const attachment = {
      ...makeImageAttachment("pending-photo"),
      url: null,
    } as AttachmentResource
    const message = zalo(attachment)
    message.contentAttributes = {
      zaloAccount: {
        mediaResources: [
          {
            attachmentId: attachment.id,
            role: "original",
            kind: "image",
            state,
          },
        ],
      },
    }
    const el = renderComponent(<MessageItem message={message} />)
    expect(el.textContent).toContain("processingImage")
    expect(el.textContent).not.toContain("failedToPreviewImage")
    expect(el.querySelector("img, a")).toBeNull()
    act(() =>
      root?.render(
        <TenantProvider settings={tenantSettings}>
          <MessageItem
            message={{
              ...message,
              attachments: [
                { ...attachment, url: "https://signed.test/ready.jpg" },
              ],
            }}
          />
        </TenantProvider>,
      ),
    )
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "https://signed.test/ready.jpg",
    )
  })
  test("draws an authorized pending image before the archive is ready", () => {
    const url =
      "https://builder.example.com/media/attachment/zalo-preview-token"
    const attachment = { ...makeImageAttachment("pending-photo"), url }
    const message = zalo(attachment)
    message.contentAttributes = {
      zaloAccount: {
        mediaResources: [
          {
            attachmentId: attachment.id,
            role: "original",
            kind: "image",
            state: "pending",
          },
        ],
      },
    }
    const element = renderComponent(
      <MessageItem message={message} zaloAccount />,
    )
    expect(element.querySelector("img")?.getAttribute("src")).toBe(url)
    expect(element.textContent).not.toContain("processingImage")
  })

  test("keeps failed image transfers distinct from processing", () => {
    const attachment = {
      ...makeImageAttachment("failed-photo"),
      url: null,
    } as AttachmentResource
    const message = zalo(attachment)
    message.contentAttributes = {
      zaloAccount: {
        mediaResources: [
          {
            attachmentId: attachment.id,
            role: "original",
            kind: "image",
            state: "failed",
          },
        ],
      },
    }
    const el = renderComponent(<MessageItem message={message} />)
    expect(el.textContent).toContain("failedToPreviewImage")
    expect(el.textContent).not.toContain("processingImage")
  })

  test("shows an honest unavailable image without reconstructing a private origin", () => {
    const attachment = {
      ...makeImageAttachment("private"),
      url: null,
      originPath: "workspace/private/secret.jpg",
      name: null,
    } as unknown as AttachmentResource
    const el = renderComponent(<MessageItem message={zalo(attachment)} />)
    expect(el.textContent).toContain("failedToPreviewImage")
    expect(el.textContent).not.toContain("Attachment")
    expect(el.querySelector("img, a")).toBeNull()
  })

  test("previews only a server HTTPS thumbnail when the original URL is unavailable", () => {
    const attachment = {
      ...makeImageAttachment("preview"),
      url: null,
      thumbnailPath: "https://signed.test/preview?token=signed",
    } as unknown as AttachmentResource
    const message = zalo(attachment)
    message.contentAttributes = {
      zaloAccount: {
        mediaResources: [
          { attachmentId: attachment.id, role: "thumbnail", state: "stored" },
        ],
      },
    }
    const el = renderComponent(<MessageItem message={message} />)
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      attachment.thumbnailPath,
    )
  })

  test("never turns private thumbnail keys into preview URLs", () => {
    const attachment = {
      ...makeImageAttachment("private-preview"),
      url: null,
      thumbnailPath: "workspace/private/preview.jpg",
    } as unknown as AttachmentResource
    const el = renderComponent(<MessageItem message={zalo(attachment)} />)
    expect(el.querySelector("img, a")).toBeNull()
  })
})

test("does not treat an unprojected provider HTTPS thumbnail as authorized", () => {
  const el = renderComponent(
    <MessageItem
      message={makeMessage({
        contentAttributes: { zaloAccount: { accountId: "a" } },
        attachments: [
          {
            ...makeImageAttachment("raw-thumb"),
            url: null,
            thumbnailPath: "https://provider.test/private.jpg",
          } as unknown as AttachmentResource,
        ],
      })}
    />,
  )
  expect(el.querySelector("img, a")).toBeNull()
})

const zaloRichMessage = (
  richContent: unknown,
  overrides: Partial<MessageResourceWithRelations> = {},
) =>
  makeMessage({
    sourceId: "za:1:user:2:3",
    text: "[fallback]",
    contentAttributes: { zaloAccount: { richContent } },
    ...overrides,
  })

describe("Zalo Account rich messages", () => {
  test("renders an outgoing bank card accepted without a provider ID only in its Zalo Account inbox", () => {
    const message = zaloRichMessage(undefined, {
      sourceId: null,
      messageType: "outgoing",
      contentAttributes: {
        zaloAccount: {
          accountId: "51",
          richSendKind: "bankCard",
          richContent: {
            kind: "bank",
            bankName: "Example bank",
            accountNumber: "0013",
          },
        },
      },
    })
    const el = renderComponent(
      <>
        <MessageItem message={message} zaloAccount />
        <MessageItem message={message} />
        <MessageItem
          message={{ ...message, messageType: "incoming" }}
          zaloAccount
        />
      </>,
    )
    expect(el.textContent?.split("Example bank")).toHaveLength(2)
    expect(el.textContent?.split("[fallback]")).toHaveLength(3)
    expect(el.querySelector("a, button")).toBeNull()
  })

  test("uses a safe typed file quote while keeping the reply and a keyboard-operable jump", () => {
    const openQuote = vi.fn()
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          text: "A reply",
          contentAttributes: {
            zaloAccountQuote: {
              providerMessageId: "10",
              msgType: "chat.file",
              contentKind: "file",
              fileName: "receipt.pdf",
              senderName: "Quỳnh",
              senderId: "sender-1",
              timestampMs: Date.now(),
            },
          },
        })}
        onOpenZaloQuote={openQuote}
        zaloAccount
      />,
    )
    const jump = el.querySelector("button")
    expect(jump?.textContent).toContain("Quỳnh")
    expect(jump?.textContent).toContain("receipt.pdf")
    expect(el.textContent).toContain("A reply")
    act(() => jump?.click())
    expect(openQuote).toHaveBeenCalledOnce()
  })

  test("keeps a missing sticker in a fixed fallback frame and never renders its raw text summary", () => {
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          contentAttributes: { zaloAccount: { msgType: "chat.sticker" } },
        })}
        zaloAccount
      />,
    )
    expect(el.querySelector('[data-slot="zalo-sticker"]')).not.toBeNull()
    expect(el.textContent).toContain("sticker")
    expect(el.textContent).not.toContain("[fallback]")
  })

  test("renders a sticker ID directly from the public Zalo CDN without a stored asset", () => {
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage({ kind: "sticker", stickerId: "23037" })}
        zaloAccount
      />,
    )
    expect(
      el.querySelector('[data-slot="zalo-sticker"] img')?.getAttribute("src"),
    ).toBe("https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=23037")
  })

  test("renders sticker artwork from a scoped preview while storage is unavailable", () => {
    const url = "https://builder.example.com/media/attachment/sticker-preview"
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          contentAttributes: {
            zaloAccount: {
              msgType: "chat.sticker",
              mediaResources: [
                {
                  kind: "sticker",
                  role: "original",
                  slot: "static",
                  state: "failed",
                  url,
                },
              ],
            },
          },
        })}
        zaloAccount
      />,
    )
    expect(
      el.querySelector('[data-slot="zalo-sticker"] img')?.getAttribute("src"),
    ).toBe(url)
  })

  test("opens a safe original link with an archived lazy thumbnail and escapes provider markup", () => {
    const thumbnail = makeProxyAttachment("cover", "image", "image/png")
    const richContent = {
      kind: "link",
      url: "https://example.com/article",
      title: "<b>Article</b>",
      description: "Article summary",
    }
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(richContent, {
          attachments: [thumbnail],
          contentAttributes: {
            zaloAccount: {
              richContent,
              mediaResources: [
                {
                  attachmentId: thumbnail.id,
                  role: "card_image",
                  slot: "link_preview",
                  state: "stored",
                },
              ],
            },
          },
        })}
        zaloAccount
      />,
    )

    const link = el.querySelector('a[href="https://example.com/article"]')
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
    expect(link?.textContent).toContain("<b>Article</b>")
    expect(link?.querySelector("b")).toBeNull()
    expect(link?.textContent).toContain("Article summary")
    expect(link?.querySelector("img")?.getAttribute("src")).toBe(thumbnail.url)
    expect(el.querySelectorAll("img")).toHaveLength(1)
    expect(el.textContent).not.toContain("[fallback]")
  })

  test.each([
    "javascript:alert(1)",
    "https://user:secret@example.com/article",
  ])("keeps the fallback for a rejected rich link (%s)", (url) => {
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage({ kind: "link", url })}
        zaloAccount
      />,
    )

    expect(el.querySelector("a, iframe")).toBeNull()
    expect(el.textContent).toContain("[fallback]")
  })

  test("leaves rich attributes inert on another channel and in the guest widget", () => {
    const message = zaloRichMessage({
      kind: "link",
      url: "https://example.com/article",
    })
    const el = renderComponent(
      <>
        <MessageItem message={message} />
        <MessageItem
          message={{ ...message, sourceId: "meta-message" }}
          zaloAccount
        />
        <MessageItem guestDisplay message={message} zaloAccount />
      </>,
    )

    expect(el.querySelector("a")).toBeNull()
    expect(el.textContent?.split("[fallback]")).toHaveLength(4)
  })

  test("does not expose a recalled card or its saved image in the ordinary inbox", () => {
    const message = zaloRichMessage(
      { kind: "qr", title: "private QR" },
      { attachments: [makeProxyAttachment("qr", "image", "image/png")] },
    )
    const el = renderComponent(
      <MessageItem
        message={{
          ...message,
          contentAttributes: {
            zaloAccount: {
              richContent: { kind: "qr", title: "private QR" },
              lifecycle: { recalled: true },
            },
          },
        }}
        zaloAccount
      />,
    )

    expect(el.textContent).toContain("recalled")
    expect(el.textContent).not.toContain("private QR")
    expect(el.querySelector("img, a")).toBeNull()
  })

  test("shows a location action and informational bank and call cards", () => {
    const el = renderComponent(
      <>
        <MessageItem
          message={zaloRichMessage({
            kind: "location",
            latitude: 10.5,
            longitude: 106.25,
            address: "12 Market Street",
          })}
          zaloAccount
        />
        <MessageItem
          message={zaloRichMessage({
            kind: "bank",
            bankName: "Example Bank",
            accountNumber: "00123",
          })}
          zaloAccount
        />
        <MessageItem
          message={zaloRichMessage({
            kind: "call",
            direction: "incoming",
            status: "missed",
            medium: "video",
            durationMs: 42_000,
          })}
          zaloAccount
        />
      </>,
    )

    expect(el.textContent).toContain("12 Market Street")
    expect(el.querySelector("a")?.getAttribute("href")).toContain(
      "10.5%2C106.25",
    )
    expect(el.querySelectorAll("a")).toHaveLength(1)
    expect(el.querySelector("iframe, button")).toBeNull()
    expect(el.textContent).toContain("Example Bank")
    expect(el.textContent).toContain("00123")
    expect(el.textContent).toContain("missedCall")
    expect(el.textContent).toContain("videoCall")
    expect(el.textContent).toContain("0:42")
  })

  test("renders nested styles around emoji without interpreting markup and rejects split-surrogate spans", () => {
    const text = "A😀BC <b>plain</b>"
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(
          {
            kind: "styledText",
            spans: [
              { offset: 1, length: 4, style: "b" },
              { offset: 3, length: 1, style: "i" },
              { offset: 2, length: 1, style: "u" },
            ],
          },
          { text },
        )}
        zaloAccount
      />,
    )

    expect(el.textContent).toContain(text)
    expect(el.querySelector("strong")?.textContent).toContain("😀")
    expect(el.querySelector("strong em")?.textContent).toBe("B")
    expect(el.querySelector("u, b")).toBeNull()
  })

  test("uses only projected video and voice URLs with no preload, a trusted poster and duration", () => {
    const video = {
      ...makeProxyAttachment("video", "video", "video/mp4"),
      thumbnailPath:
        "https://builder.example.com/media/attachment/poster-token",
    }
    const audio = makeProxyAttachment("voice", "audio", "audio/mpeg")
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          text: null,
          attachments: [video, audio],
          contentAttributes: {
            zaloAccount: {
              mediaResources: [
                {
                  attachmentId: video.id,
                  role: "original",
                  kind: "video",
                  state: "stored",
                  durationMs: 40_000,
                },
                {
                  attachmentId: video.id,
                  role: "poster",
                  state: "stored",
                },
                {
                  attachmentId: audio.id,
                  role: "original",
                  kind: "audio",
                  state: "stored",
                  durationMs: 20_000,
                },
              ],
            },
          },
        })}
        zaloAccount
      />,
    )

    expect(
      el
        .querySelector("video[controls][preload=none] source")
        ?.getAttribute("src"),
    ).toBe(video.url)
    expect(el.querySelector("video")?.getAttribute("poster")).toBe(
      video.thumbnailPath,
    )
    expect(
      el
        .querySelector("audio[controls][preload=none] source")
        ?.getAttribute("src"),
    ).toBe(audio.url)
    expect(el.querySelector(`a[href="${video.url}"][download]`)).not.toBeNull()
    expect(el.querySelector(`a[href="${audio.url}"][download]`)).not.toBeNull()
    expect(el.textContent).toContain("0:40")
    expect(el.textContent).toContain("0:20")
  })

  test("shows pending and failed media without deriving a URL from the private path", () => {
    const pending = {
      ...makeProxyAttachment("pending", "video", "video/mp4"),
      url: null,
    }
    const failed = {
      ...makeProxyAttachment("failed", "audio", "audio/mpeg"),
      url: null,
    }
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          text: null,
          attachments: [pending, failed],
          contentAttributes: {
            zaloAccount: {
              mediaResources: [
                {
                  attachmentId: pending.id,
                  role: "original",
                  kind: "video",
                  state: "pending",
                },
                {
                  attachmentId: failed.id,
                  role: "original",
                  kind: "audio",
                  state: "failed",
                },
              ],
            },
          },
        })}
        zaloAccount
      />,
    )

    expect(el.textContent).toContain("processingMedia")
    expect(el.textContent).toContain("mediaUnavailable")
    expect(el.querySelector("video, audio, a")).toBeNull()
    expect(el.innerHTML).not.toContain("pending/pending")
  })

  test("renders a provider GIF and its caption before any archive exists", () => {
    const url = "https://photo.zdn.vn/original/animation.gif"
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(undefined, {
          text: "Caption from the Zalo socket",
          contentAttributes: {
            zaloAccount: { inlineGif: { url, mimeType: "image/gif" } },
          },
        })}
        zaloAccount
      />,
    )

    expect(el.textContent).toContain("Caption from the Zalo socket")
    expect(el.querySelector("img")?.getAttribute("src")).toBe(url)
    expect(el.textContent).not.toContain("processingMedia")
  })

  test("updates a standalone GIF from processing to the original animation", () => {
    const media = {
      referenceId: "gif",
      role: "original",
      kind: "gif",
      slot: "original",
      state: "downloading",
      mimeType: "image/gif",
    }
    const gifMessage = (resource: object) =>
      zaloRichMessage(undefined, {
        text: "A caption stays visible",
        contentAttributes: { zaloAccount: { mediaResources: [resource] } },
      })
    const el = renderComponent(
      <MessageItem message={gifMessage(media)} zaloAccount />,
    )
    expect(el.textContent).toContain("processingMedia")
    expect(el.querySelector("img")).toBeNull()

    const archivedUrl = "https://builder.example.com/media/attachment/gif-token"
    act(() =>
      root?.render(
        <TenantProvider settings={tenantSettings}>
          <MessageItem
            message={gifMessage({
              ...media,
              state: "stored",
              url: archivedUrl,
            })}
            zaloAccount
          />
        </TenantProvider>,
      ),
    )

    expect(el.textContent).toContain("A caption stays visible")
    expect(el.textContent).not.toContain("processingMedia")
    expect(el.querySelector("img")?.getAttribute("src")).toBe(archivedUrl)
  })

  test("keeps contact and QR information usable when previews are missing or broken", () => {
    const el = renderComponent(
      <>
        <MessageItem
          message={zaloRichMessage({
            kind: "contact",
            phone: "0123456789",
          })}
          zaloAccount
        />
        <MessageItem
          message={zaloRichMessage(undefined, {
            contentAttributes: {
              zaloAccount: {
                richContent: { kind: "qr", title: "Collection QR" },
                mediaResources: [
                  {
                    referenceId: "qr-reference",
                    role: "card_image",
                    slot: "qr_image",
                    state: "stored",
                    url: "https://builder.example.com/media/attachment/qr-token",
                  },
                ],
              },
            },
          })}
          zaloAccount
        />
      </>,
    )

    expect(el.textContent).toContain("0123456789")
    expect(el.textContent).toContain("Collection QR")
    expect(el.querySelector("a, button")).toBeNull()
    const image = el.querySelector("img")
    expect(image).not.toBeNull()
    act(() => image?.dispatchEvent(new Event("error")))
    expect(el.querySelector("img")).toBeNull()
    expect(el.textContent).toContain("Collection QR")
  })

  test("renders list items and bounded color and size styles inside the message", () => {
    const text = "First\nSecond"
    const el = renderComponent(
      <MessageItem
        message={zaloRichMessage(
          {
            kind: "styledText",
            spans: [
              { offset: 0, length: text.length, style: "lst_2" },
              { offset: 0, length: 5, style: "c_0088FF" },
              { offset: 0, length: 5, style: "f_18" },
              { offset: 6, length: 6, style: "s" },
            ],
          },
          { text },
        )}
        zaloAccount
      />,
    )

    expect(
      Array.from(el.querySelectorAll("ol li"), (item) => item.textContent),
    ).toEqual(["First", "Second"])
    expect(el.querySelector<HTMLElement>("li span")?.style.fontSize).toBe(
      "18px",
    )
    expect(el.querySelector<HTMLElement>("li span")?.style.color).toBe(
      "rgb(0, 136, 255)",
    )
    expect(el.querySelector("li s")?.textContent).toBe("Second")
  })
})
