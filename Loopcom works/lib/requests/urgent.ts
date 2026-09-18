export function buildUrgentUpdateData(isUrgent: boolean, userId: string, now = new Date()) {
  return {
    isUrgent,
    urgentAt: isUrgent ? now : null,
    urgentByUserId: isUrgent ? userId : null,
  }
}
