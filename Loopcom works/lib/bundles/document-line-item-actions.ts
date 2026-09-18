export type DocumentLineItemLike = {
  groupId?: string
  groupName?: string
  isGroupHeader?: boolean
  isSubtotal?: boolean
}

/** Remove one line, or the entire bundle when removing a bundle header row. */
export function removeDocumentLineItem<T extends DocumentLineItemLike>(
  items: T[],
  index: number
): T[] {
  if (items.length <= 1) return items
  const item = items[index]
  if (item?.groupId && item.isGroupHeader) {
    return items.filter((li) => li.groupId !== item.groupId)
  }
  return items.filter((_, i) => i !== index)
}

/** Insert a blank line inside the same bundle group (after header or a child row). */
export function insertDocumentLineAfter<T extends DocumentLineItemLike>(
  items: T[],
  index: number,
  createBlank: () => T
): { items: T[]; focusIndex: number } {
  const row = items[index]
  const blank = createBlank()
  if (!row.isSubtotal && row.groupId) {
    blank.groupId = row.groupId
    blank.groupName = row.groupName
  }
  const next = [...items]
  next.splice(index + 1, 0, blank)
  return { items: next, focusIndex: index + 1 }
}

/** Append a new editable row at the end of a bundle on this document only. */
export function addItemToDocumentBundle<T extends DocumentLineItemLike>(
  items: T[],
  groupId: string,
  createBlank: () => T
): { items: T[]; focusIndex: number } {
  const header = items.find((li) => li.groupId === groupId && li.isGroupHeader)
  let lastIndex = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].groupId === groupId) lastIndex = i
  }
  const insertAt = lastIndex >= 0 ? lastIndex : Math.max(0, items.length - 1)
  const blank = createBlank()
  blank.groupId = groupId
  if (header?.groupName) blank.groupName = header.groupName
  const next = [...items]
  next.splice(insertAt + 1, 0, blank)
  return { items: next, focusIndex: insertAt + 1 }
}
