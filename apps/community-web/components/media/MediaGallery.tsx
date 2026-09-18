"use client";

import { useEffect, useState } from "react";
import { mediaUrl } from "@/lib/api";
import { Icon } from "@/components/ui";
import "./media.css";

export type GalleryAsset = { id: string; kind: string; mime: string; width?: number | null; height?: number | null; alt?: string | null };

/** Renders 1–10 image/video assets in a grid (LinkedIn-style layout) with a lightbox on click. */
export function MediaGallery({ assets, testId = "gallery" }: { assets: GalleryAsset[]; testId?: string }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const shown = assets.slice(0, 10);
  if (!shown.length) return null;
  const n = shown.length;
  const cls = n === 1 ? "n1" : n === 2 ? "n2" : n === 3 ? "n3" : n === 4 ? "n4" : "ngt";
  const extra = n > 4 ? n - 4 : 0;
  const cells = n > 4 ? shown.slice(0, 4) : shown;

  return (
    <>
      <div className={`gallery-grid ${cls}`} data-testid={testId}>
        {cells.map((a, i) => (
          <button
            type="button"
            key={a.id}
            className={`gallery-cell g-${i}`}
            onClick={() => setOpenAt(i)}
            aria-label={a.alt || `Open media ${i + 1}`}
            data-testid={`${testId}-cell-${i}`}
          >
            {a.kind === "video" ? (
              <>
                <video src={mediaUrl(a.id, "medium") ?? undefined} muted />
                <span className="play">
                  <Icon name="video" />
                </span>
              </>
            ) : (
              <img src={mediaUrl(a.id, "medium") ?? undefined} alt={a.alt ?? ""} loading="lazy" />
            )}
            {i === 3 && extra > 0 ? <span className="more">+{extra}</span> : null}
          </button>
        ))}
      </div>
      {openAt !== null ? <Lightbox assets={shown} index={openAt} onClose={() => setOpenAt(null)} onIndex={setOpenAt} /> : null}
    </>
  );
}

function Lightbox({ assets, index, onClose, onIndex }: { assets: GalleryAsset[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const a = assets[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") onIndex((index + 1) % assets.length);
      if (e.key === "ArrowLeft") onIndex((index - 1 + assets.length) % assets.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, assets.length, onClose, onIndex]);
  return (
    <div className="lightbox-scrim" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-stage">
        {a.kind === "video" ? <video src={mediaUrl(a.id, "original") ?? undefined} controls autoPlay /> : <img src={mediaUrl(a.id, "original") ?? undefined} alt={a.alt ?? ""} />}
        <button type="button" className="lightbox-close" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
        {assets.length > 1 ? (
          <>
            <button type="button" className="lightbox-nav prev" aria-label="Previous" onClick={() => onIndex((index - 1 + assets.length) % assets.length)}>
              <Icon name="back" />
            </button>
            <button type="button" className="lightbox-nav next" aria-label="Next" onClick={() => onIndex((index + 1) % assets.length)}>
              <Icon name="arrow" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
