"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "../cn";
import {
  DEFAULT_RIGHT_RAIL_SECTION_ORDER,
  isRightRailDragEnabled,
  loadRightRailSectionOrder,
  moveRightRailSection,
  saveRightRailSectionOrder,
  type RightRailSectionId,
} from "./contactRightRailOrder";

const DRAG_THRESHOLD_PX = 8;

type DropTarget = {
  id: RightRailSectionId;
  position: "before" | "after";
};

type SectionDragProps = {
  dragEnabled?: boolean;
  dragVisual?: "idle" | "dragging" | "drop-before" | "drop-after";
  onSummaryPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSummaryClick?: (event: React.MouseEvent<HTMLElement>) => void;
};

function isInteractiveDragTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, input, select, textarea, a, label"));
}

function resolveDropTarget(clientY: number, container: HTMLElement, activeId: RightRailSectionId): DropTarget | null {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-rail-section-id]"));
  for (const node of nodes) {
    const id = node.dataset.railSectionId as RightRailSectionId | undefined;
    if (!id || id === activeId) continue;
    const rect = node.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) return { id, position: "before" };
    if (clientY >= midpoint && clientY <= rect.bottom) return { id, position: "after" };
  }
  const last = nodes.filter((node) => node.dataset.railSectionId !== activeId).at(-1);
  if (last) {
    return { id: last.dataset.railSectionId as RightRailSectionId, position: "after" };
  }
  return null;
}

export function ContactRightRailSectionList({
  userId,
  sections,
  trailing,
  className,
}: {
  userId?: string | null;
  sections: Partial<Record<RightRailSectionId, ReactNode>>;
  trailing?: ReactNode;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragSessionRef = useRef<{
    activeId: RightRailSectionId;
    startY: number;
    dragging: boolean;
    pointerId: number;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const [order, setOrder] = useState<RightRailSectionId[]>([...DEFAULT_RIGHT_RAIL_SECTION_ORDER]);
  const [dragEnabled, setDragEnabled] = useState(false);
  const [draggingId, setDraggingId] = useState<RightRailSectionId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useEffect(() => {
    setOrder(loadRightRailSectionOrder(userId));
  }, [userId]);

  useEffect(() => {
    const syncDragEnabled = () => setDragEnabled(isRightRailDragEnabled());
    syncDragEnabled();
    window.addEventListener("resize", syncDragEnabled);
    const coarse = window.matchMedia("(pointer: coarse)");
    coarse.addEventListener("change", syncDragEnabled);
    return () => {
      window.removeEventListener("resize", syncDragEnabled);
      coarse.removeEventListener("change", syncDragEnabled);
    };
  }, []);

  const commitOrder = useCallback(
    (next: RightRailSectionId[]) => {
      setOrder(next);
      saveRightRailSectionOrder(next, userId);
    },
    [userId],
  );

  const finishDrag = useCallback(
    (activeId: RightRailSectionId, target: DropTarget | null) => {
      if (target) {
        commitOrder(moveRightRailSection(order, activeId, target.id, target.position));
        suppressClickRef.current = true;
      }
      dragSessionRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
    },
    [commitOrder, order],
  );

  const handleSummaryPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, sectionId: RightRailSectionId) => {
      if (!dragEnabled || event.button !== 0 || isInteractiveDragTarget(event.target)) return;

      const summaryEl = event.currentTarget;

      dragSessionRef.current = {
        activeId: sectionId,
        startY: event.clientY,
        dragging: false,
        pointerId: event.pointerId,
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) return;

        if (!session.dragging) {
          if (Math.abs(moveEvent.clientY - session.startY) < DRAG_THRESHOLD_PX) return;
          session.dragging = true;
          setDraggingId(session.activeId);
          summaryEl.setPointerCapture?.(moveEvent.pointerId);
        }

        moveEvent.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        setDropTarget(resolveDropTarget(moveEvent.clientY, container, session.activeId));
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || upEvent.pointerId !== session.pointerId) return;

        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);

        if (summaryEl.hasPointerCapture?.(upEvent.pointerId)) {
          summaryEl.releasePointerCapture(upEvent.pointerId);
        }

        if (session.dragging) {
          const container = containerRef.current;
          const target = container
            ? resolveDropTarget(upEvent.clientY, container, session.activeId)
            : null;
          finishDrag(session.activeId, target);
          return;
        }

        dragSessionRef.current = null;
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [dragEnabled, finishDrag],
  );

  const handleSummaryClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClickRef.current = false;
  }, []);

  return (
    <div ref={containerRef} className={cn("flex flex-col gap-2", className)}>
      {order.map((sectionId) => {
        const section = sections[sectionId];
        if (!section || !isValidElement(section)) return null;

        const dragVisual =
          draggingId === sectionId
            ? "dragging"
            : dropTarget?.id === sectionId
              ? dropTarget.position === "before"
                ? "drop-before"
                : "drop-after"
              : "idle";

        const enhanced = cloneElement(section as ReactElement<SectionDragProps>, {
          dragEnabled,
          dragVisual,
          onSummaryPointerDown: (event: ReactPointerEvent<HTMLElement>) =>
            handleSummaryPointerDown(event, sectionId),
          onSummaryClick: handleSummaryClick,
        });

        return (
          <div key={sectionId} data-rail-section-id={sectionId} className="crm-contact-right-rail-section-slot">
            {enhanced}
          </div>
        );
      })}
      {trailing}
    </div>
  );
}
