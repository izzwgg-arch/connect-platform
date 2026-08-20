/**
 * IMAP source for the SMS-reply job — reads the bridge mailbox (sms@loopcom.net)
 * over Gmail IMAP with an app password. Deliberately thin: one connection per
 * poll, UNSEEN search, parse with mailparser, hand each mail to the job's
 * handler, and set \Seen only when the handler says the mail is dealt with.
 * A handler throw leaves the mail unseen for the next pass; everything
 * decision-shaped lives in smsEmailReplyJob.ts where it is unit-tested.
 *
 * Gmail plus-addressing is what makes one mailbox serve every thread: mail to
 * sms+<threadId>.<sig>@loopcom.net lands in sms@loopcom.net's INBOX, and the
 * original recipient address survives in To / Delivered-To / X-Original-To —
 * all of which are collected below.
 */
import type { SmsReplyEmail, SmsReplyEmailSource } from "./smsEmailReplyJob";

export interface SmsImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

const MAX_PER_PASS = 20;

function addAddresses(out: Set<string>, value: any): void {
  const list = Array.isArray(value?.value) ? value.value : Array.isArray(value) ? value : value ? [value] : [];
  for (const entry of list) {
    const addr = typeof entry === "string" ? entry : entry?.address;
    if (addr && String(addr).includes("@")) out.add(String(addr).trim());
  }
}

export function createSmsImapSource(cfg: SmsImapConfig): SmsReplyEmailSource {
  return {
    async poll(handler: (email: SmsReplyEmail) => Promise<boolean>): Promise<number> {
      // Lazy imports so the agent boots fine when the bridge is unconfigured.
      const { ImapFlow } = await import("imapflow");
      const { simpleParser } = await import("mailparser");

      const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: true,
        auth: { user: cfg.user, pass: cfg.pass },
        logger: false,
      });
      let handled = 0;
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
          for (const uid of uids.slice(0, MAX_PER_PASS)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!msg || !(msg as any).source) continue;
            const parsed = await simpleParser((msg as any).source);

            const to = new Set<string>();
            addAddresses(to, parsed.to);
            addAddresses(to, parsed.cc);
            for (const name of ["delivered-to", "x-original-to", "x-forwarded-to", "envelope-to"]) {
              const v = parsed.headers.get(name);
              const raw = typeof v === "string" ? v : (v as any)?.text ?? "";
              for (const piece of String(raw).split(/[,;\s]+/)) {
                if (piece.includes("@")) to.add(piece.replace(/[<>]/g, "").trim());
              }
              addAddresses(to, v);
            }

            const headers: Record<string, string> = {};
            for (const [key, value] of parsed.headers) {
              headers[key.toLowerCase()] = typeof value === "string" ? value : ((value as any)?.text ?? JSON.stringify(value ?? ""));
            }

            const email: SmsReplyEmail = {
              id: String(uid),
              messageId: parsed.messageId || null,
              from: parsed.from?.value?.[0]?.address || null,
              to: Array.from(to),
              subject: parsed.subject || "",
              text: parsed.text || null,
              html: typeof parsed.html === "string" ? parsed.html : null,
              headers,
            };

            const done = await handler(email);
            if (done) {
              await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
              handled++;
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
      return handled;
    },
  };
}
