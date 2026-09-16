/**
 * Creative Studio — helpers shared by every door.
 *
 * Their own module because the browser routes, the agent's internal door and
 * the service layer all need them; without this they would import each other
 * in a circle.
 */

export async function loadBrandKit(db: any, tenantId: string): Promise<any | null> {
  const kit = await db.creativeBrandKit.findFirst({ where: { tenantId, isDefault: true }, include: { items: true } });
  if (!kit) return null;
  const items: any[] = kit.items || [];
  const guidance: any = kit.guidance || {};
  return {
    name: kit.name,
    colors: items.filter((i) => i.type === "color").map((i) => ({ label: i.label, value: String((i.value as any)?.hex || i.value) })),
    fonts: items.filter((i) => i.type === "font").map((i) => ({ label: i.label, value: String((i.value as any)?.family || i.value) })),
    voice: guidance.voice || "",
    prohibitions: [...(guidance.prohibitions || []), ...items.filter((i) => i.type === "prohibition").map((i) => i.label)],
    claims: [...(guidance.claims || []), ...items.filter((i) => i.type === "claim").map((i) => i.label)],
  };
}

/**
 * Apply edit operations to a document. Deliberately small and total: an op
 * that does not make sense is skipped rather than throwing, because a single
 * bad instruction from the agent must not lose a person's work.
 */
export function applyOps(doc: any, ops: Array<{ op: string; target?: string; payload?: any }>): any {
  const next = JSON.parse(JSON.stringify(doc ?? {}));
  if (!Array.isArray(next.objects)) next.objects = [];
  for (const { op, target, payload } of ops) {
    const idx = target ? next.objects.findIndex((o: any) => o?.id === target) : -1;
    switch (op) {
      case "add":
        if (payload && typeof payload === "object") next.objects.push({ id: payload.id || `o${next.objects.length + 1}`, ...payload });
        break;
      case "set":
      case "move":
      case "resize":
      case "replace":
        if (idx >= 0 && payload && typeof payload === "object") next.objects[idx] = { ...next.objects[idx], ...payload, id: next.objects[idx].id };
        break;
      case "delete":
        if (idx >= 0) next.objects.splice(idx, 1);
        break;
      case "reorder":
        if (idx >= 0 && typeof payload?.to === "number") {
          const [moved] = next.objects.splice(idx, 1);
          next.objects.splice(Math.max(0, Math.min(next.objects.length, payload.to)), 0, moved);
        }
        break;
      case "split":
      case "trim":
        if (idx >= 0 && payload && typeof payload === "object") next.objects[idx] = { ...next.objects[idx], ...payload };
        break;
      default:
        break;
    }
  }
  return next;
}
