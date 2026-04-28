"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type DropdownPosition = {
  left: number;
  top: number;
  width: number;
};

type ViewportDropdownProps = {
  open: boolean;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number;
  sideOffset?: number;
  collisionPadding?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function ViewportDropdown({
  open,
  triggerRef,
  onClose,
  children,
  className = "",
  width = 260,
  sideOffset = 8,
  collisionPadding = 16,
}: ViewportDropdownProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<DropdownPosition | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open || !mounted) return;

    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const safeWidth = Math.min(width, Math.max(160, viewportWidth - collisionPadding * 2));
      const maxLeft = viewportWidth - safeWidth - collisionPadding;
      const left = clamp(rect.right - safeWidth, collisionPadding, Math.max(collisionPadding, maxLeft));

      const panelHeight = panelRef.current?.offsetHeight ?? 0;
      const desiredTop = rect.bottom + sideOffset;
      const wouldClipBottom = panelHeight > 0 && desiredTop + panelHeight > viewportHeight - collisionPadding;
      const hasMoreRoomAbove = rect.top > viewportHeight - rect.bottom;
      const top = wouldClipBottom && hasMoreRoomAbove
        ? Math.max(collisionPadding, rect.top - sideOffset - panelHeight)
        : Math.min(desiredTop, Math.max(collisionPadding, viewportHeight - collisionPadding - panelHeight));

      setPosition({ left, top, width: safeWidth });
    }

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [collisionPadding, mounted, open, sideOffset, triggerRef, width]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open, triggerRef]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`dropdown-panel viewport-dropdown ${className}`.trim()}
      style={{
        position: "fixed",
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        width: position?.width ?? width,
        maxWidth: `calc(100vw - ${collisionPadding * 2}px)`,
        maxHeight: `calc(100vh - ${collisionPadding * 2}px)`,
        overflowY: "auto",
        zIndex: 1000,
      }}
      tabIndex={-1}
    >
      {children}
    </div>,
    document.body,
  );
}
