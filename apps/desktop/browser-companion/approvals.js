/** Capability data stays in the trusted service worker; page text cannot create approval. */
export const protectedCommands = new Set(["open","act","download","upload","screenshot","close"]);
export function requestIdentity(item) { return JSON.stringify([item.taskId,item.scopeId,item.command,item.args]); }
export class ApprovalBook {
  entries = new Map();
  issue(item, snapshot, now=Date.now()) {
    for (const [key,value] of this.entries) if (value.expires < now) this.entries.delete(key);
    if (this.entries.size >= 32) throw Error("too_many_pending_approvals");
    const token = crypto.randomUUID();
    this.entries.set(token,{identity:requestIdentity(item),binding:snapshot.binding,expires:now+120000});
    return token;
  }
  consume(item, snapshot, now=Date.now()) {
    const record = this.entries.get(item.authorization); this.entries.delete(item.authorization);
    if (!record || record.expires < now || record.identity !== requestIdentity(item) || record.binding !== snapshot.binding) throw Error("approval_missing_expired_or_page_changed");
    return record.binding;
  }
  clear() { this.entries.clear(); }
}
