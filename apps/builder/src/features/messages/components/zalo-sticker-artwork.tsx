"use client"

import { StickerIcon } from "lucide-react"
import Image from "next/image"
import {
  type CSSProperties,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import styles from "./zalo-sticker-artwork.module.css"

export type ZaloStickerArt = {
  staticUrl?: string
  webpUrl?: string
  spriteUrl?: string
  frameCount?: number | null
  frameDurationMs?: number | null
}

const motionPreference = "(prefers-reduced-motion: reduce)"
const getMotionPreference = () =>
  window.matchMedia?.(motionPreference).matches ?? false
const subscribeMotionPreference = (onChange: () => void) => {
  const query = window.matchMedia?.(motionPreference)
  query?.addEventListener("change", onChange)
  return () => query?.removeEventListener("change", onChange)
}

export function ZaloStickerArtwork({
  artwork,
  label,
  size = 96,
}: {
  artwork: ZaloStickerArt
  label: string
  size?: number
}) {
  const frame = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const reducedMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getMotionPreference,
    () => true,
  )
  useEffect(() => {
    const element = frame.current
    if (!(element && typeof IntersectionObserver === "function")) {
      return
    }
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(Boolean(entry?.isIntersecting)),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const { frameCount, frameDurationMs, spriteUrl, staticUrl, webpUrl } = artwork
  const animate = visible && !reducedMotion
  const sprite =
    animate &&
    spriteUrl &&
    !failed.has(spriteUrl) &&
    frameCount &&
    frameCount > 1 &&
    frameDurationMs
      ? { url: spriteUrl, frameCount, frameDurationMs }
      : undefined
  const image = [animate ? webpUrl : undefined, staticUrl].find(
    (candidate) => candidate && !failed.has(candidate),
  )
  const markFailed = (url: string) =>
    setFailed((previous) => new Set(previous).add(url))
  return (
    <span
      className="relative flex max-w-full shrink-0 items-center justify-center overflow-hidden rounded-lg text-muted-foreground"
      data-slot="zalo-sticker"
      ref={frame}
      style={{ width: size, height: size }}
    >
      {sprite && (
        <Image
          alt={label}
          className={styles.sprite}
          height={size}
          loading="lazy"
          onError={() => markFailed(sprite.url)}
          src={sprite.url}
          style={
            {
              position: "absolute",
              insetInlineStart: 0,
              maxWidth: "none",
              width: size * sprite.frameCount,
              height: size,
              "--sticker-duration": `${sprite.frameDurationMs * sprite.frameCount}ms`,
              "--sticker-frames": sprite.frameCount,
              "--sticker-shift": `${-size * sprite.frameCount}px`,
            } as CSSProperties
          }
          unoptimized
          width={size * sprite.frameCount}
        />
      )}
      {!sprite && image && (
        <Image
          alt={label}
          className="size-full object-contain"
          height={size}
          loading="lazy"
          onError={() => markFailed(image)}
          src={image}
          unoptimized
          width={size}
        />
      )}
      {!(sprite || image) && (
        <span className="flex flex-col items-center gap-1 text-center text-xs">
          <StickerIcon aria-hidden className="size-5" />
          <span>{label}</span>
        </span>
      )}
    </span>
  )
}
