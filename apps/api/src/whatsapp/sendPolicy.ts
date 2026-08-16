/**
 * The one place WhatsApp's sending rules live.
 *
 * ⛔ EVERY path that puts a message on the wire must call `evaluateSend` and
 * honour its verdict: a chat reply, a campaign, an agent-initiated message, an
 * internal door, anything added later. A rule enforced in the composer protects
 * the composer and nothing else.
 *
 * This repo has paid for that lesson twice already:
 *   - Two IVR publish paths existed; a fix applied to one silently skipped the
 *     other and shipped broken audio for a whole test round.
 *   - Two welcome-email paths existed; only one carried the Android APK link, so
 *     every self-service sign-up got an invitation with no way to install the app.
 * The shape that worked is `agentConfirmations.ts` — gates in one module,
 * capabilities plugged into them. This is that, for WhatsApp.
 *
 * This module is deliberately PURE: no Prisma, no fetch, no clock of its own.
 * Everything it needs arrives in `SendContext`, so the rules can be tested
 * exhaustively without a database, without Meta, and without credentials —
 * none of which exist yet. Gathering the context is a separate job; getting the
 * rules wrong is the expensive failure, so it is the part that gets proven first.
 *
 * Failure mode is CLOSED throughout. An unknown quality rating, an absent
 * template, a missing timestamp — each refuses rather than assumes. A refused
 * message is an inconvenience; a message that should not have been sent costs
 * the number's quality rating, and enough of those get the number restricted.
 */

export type WhatsAppQuality = "GREEN" | "MEDIUM" | "RED" | "UNKNOWN";

export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";

export type TemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED";

/** Meta's customer-service window: free-form is allowed only inside it. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type TemplateRef = {
  name: string;
  category: TemplateCategory;
  status: TemplateStatus;
};

export type SendRequest =
  | { kind: "free_form"; body: string }
  | { kind: "template"; templateName: string };

export type SendContext = {
  /** Caller-supplied so the policy has no clock of its own and stays testable. */
  now: Date;
  /** The sending number is registered, verified and not restricted by Meta. */
  numberIsLive: boolean;
  /** Meta's quality rating for the sending number. */
  quality: WhatsAppQuality;
  /** Timestamp of the recipient's most recent inbound message, or null if never. */
  lastInboundAt: Date | null;
  /** Set once the recipient opts out. Permanent — nothing overrides it. */
  recipientOptedOutAt: Date | null;
  /** Set when we hold a real, documented opt-in for this recipient. */
  recipientOptedInAt: Date | null;
  /** Templates we hold for this number, by name. */
  templates: Record<string, TemplateRef>;
  /** Unique recipients messaged in the rolling 24h, and the tier ceiling. */
  uniqueRecipientsInWindow: number;
  tierLimit: number | null;
};

export type GuardCode =
  | "number_not_live"
  | "recipient_opted_out"
  | "window_closed_free_form"
  | "template_unknown"
  | "template_not_approved"
  | "marketing_requires_opt_in"
  | "marketing_blocked_low_quality"
  | "tier_limit_reached";

export type Verdict =
  | { allowed: true; windowOpen: boolean; windowClosesAt: Date | null }
  | {
      allowed: false;
      code: GuardCode;
      /** For staff and logs — names the real cause. */
      staffMessage: string;
      /** For the person who pressed send — says what to do instead. */
      customerMessage: string;
    };

function refuse(code: GuardCode, staffMessage: string, customerMessage: string): Verdict {
  return { allowed: false, code, staffMessage, customerMessage };
}

/**
 * True when the recipient has messaged us within the last 24 hours.
 *
 * A null `lastInboundAt` means they never have, which closes the window — the
 * safe reading. A future-dated timestamp is treated as open; clock skew between
 * Meta's stamp and ours is real and small, and refusing on it would drop
 * legitimate replies.
 */
export function isServiceWindowOpen(now: Date, lastInboundAt: Date | null): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

export function serviceWindowClosesAt(lastInboundAt: Date | null): Date | null {
  if (!lastInboundAt) return null;
  return new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);
}

/**
 * Decide whether one message may be sent.
 *
 * Order matters and is not arbitrary — the checks run from the most absolute to
 * the most situational, so the refusal a caller sees names the most fundamental
 * reason rather than an incidental one. Someone who opted out should be told
 * exactly that, never "your template isn't approved".
 */
export function evaluateSend(req: SendRequest, ctx: SendContext): Verdict {
  // 1. The number itself. Nothing is sendable from a number Meta hasn't cleared.
  if (!ctx.numberIsLive) {
    return refuse(
      "number_not_live",
      "Sending number is not registered, not verified, or restricted by Meta.",
      "This number isn't set up for WhatsApp yet. Finish setup before sending.",
    );
  }

  // 2. Opt-out. Absolute, and checked before everything except the number itself.
  //    ⛔ There is deliberately no flag, role, or parameter that overrides this.
  //    The only thing that clears it is a fresh opt-in the recipient gives.
  if (ctx.recipientOptedOutAt) {
    return refuse(
      "recipient_opted_out",
      `Recipient opted out at ${ctx.recipientOptedOutAt.toISOString()}.`,
      "This person asked to stop receiving WhatsApp messages. They can only be added back if they opt in again themselves.",
    );
  }

  const windowOpen = isServiceWindowOpen(ctx.now, ctx.lastInboundAt);
  const windowClosesAt = serviceWindowClosesAt(ctx.lastInboundAt);

  if (req.kind === "free_form") {
    // 3. Free-form is allowed only inside the 24h service window.
    if (!windowOpen) {
      return refuse(
        "window_closed_free_form",
        ctx.lastInboundAt
          ? `Service window closed at ${windowClosesAt?.toISOString()}; free-form not permitted.`
          : "Recipient has never messaged this number; free-form not permitted.",
        "You can only write freely for 24 hours after they message you. Send an approved template instead — once they reply, the window reopens.",
      );
    }
    // Replies inside the window are not template sends and do not consume tier
    // capacity, so no further checks apply.
    return { allowed: true, windowOpen, windowClosesAt };
  }

  // 4. The template must be one we actually hold, and Meta must have approved it.
  const template = ctx.templates[req.templateName];
  if (!template) {
    return refuse(
      "template_unknown",
      `No template named "${req.templateName}" on this number.`,
      "That message template doesn't exist on this number. Pick one from the list.",
    );
  }
  if (template.status !== "APPROVED") {
    return refuse(
      "template_not_approved",
      `Template "${template.name}" is ${template.status}, not APPROVED.`,
      template.status === "PENDING"
        ? "Meta is still reviewing this template. It usually takes under a day — you'll be able to send it once it's approved."
        : "Meta hasn't approved this template, so it can't be sent. Edit it and submit it again.",
    );
  }

  if (template.category === "MARKETING") {
    // 5. Marketing needs a real, documented opt-in. This is the rule that
    //    protects the number's quality rating more than any other.
    if (!ctx.recipientOptedInAt) {
      return refuse(
        "marketing_requires_opt_in",
        "Marketing template to a recipient with no recorded opt-in.",
        "This person hasn't agreed to marketing messages, so they've been left out. Add opt-in to your booking or sign-up form and they'll be included next time.",
      );
    }
    // 6. Quality gate. Marketing stops while the rating is anything but Green —
    //    UNKNOWN included, because an unmeasured rating is not a good one.
    //    Utility and authentication keep flowing, so reminders and codes are
    //    never collateral damage of a marketing problem.
    if (ctx.quality !== "GREEN") {
      return refuse(
        "marketing_blocked_low_quality",
        `Quality is ${ctx.quality}; marketing sends are suspended until it returns to GREEN.`,
        "Marketing messages are paused on this number while its quality rating recovers. Reminders and replies are still sending normally.",
      );
    }
  }

  // 7. Tier headroom. A null limit means we have not learned the tier yet, which
  //    is not the same as unlimited — but refusing every send on an unknown tier
  //    would block a brand-new number entirely, so this one check is permissive
  //    by design and Meta's own rejection is the backstop.
  if (ctx.tierLimit !== null && ctx.uniqueRecipientsInWindow >= ctx.tierLimit) {
    return refuse(
      "tier_limit_reached",
      `${ctx.uniqueRecipientsInWindow} of ${ctx.tierLimit} unique recipients used in the rolling 24h.`,
      "This number has reached how many people WhatsApp lets it message in 24 hours. Sending resumes as the window rolls forward.",
    );
  }

  return { allowed: true, windowOpen, windowClosesAt };
}
