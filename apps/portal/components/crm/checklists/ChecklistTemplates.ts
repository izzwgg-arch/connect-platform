/**
 * Phase 19J — Checklist starter templates for cold-calling and CRM workflows.
 * Each template produces a pre-built item list for the create form.
 */

export type TemplateItem = {
  label: string;
  required: boolean;
};

/** Visual accent for template cards (dark SaaS operational palette). */
export type ChecklistTemplateAccent =
  | "cyan"
  | "amber"
  | "blue"
  | "green"
  | "violet"
  | "teal";

export type ChecklistTemplate = {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: ChecklistTemplateAccent;
  items: TemplateItem[];
};

/** Tailwind class bundles per template accent — keep in sync with crm.checklistTpl* tokens. */
export const TEMPLATE_ACCENT_CLASSES: Record<
  ChecklistTemplateAccent,
  {
    strip: string;
    iconBox: string;
    iconRing: string;
    card: string;
    cardBase: string;
    cardGlow: string;
    badge: string;
    meta: string;
  }
> = {
  cyan: {
    strip: "bg-crm-accent",
    iconBox:
      "border-crm-accent/40 bg-gradient-to-br from-crm-accent/25 to-crm-accent/5 text-crm-accent",
    iconRing:
      "shadow-[0_0_28px_-6px_rgba(56,189,248,0.5)] ring-1 ring-crm-accent/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#152535]/95 via-[#101a2d] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(56,189,248,0.12),transparent_55%)]",
    card: "hover:border-crm-accent/50 hover:shadow-[0_16px_40px_-12px_rgba(56,189,248,0.28),0_0_0_1px_rgba(56,189,248,0.15)]",
    badge: "border-crm-accent/35 bg-crm-accent/12 text-crm-accent",
    meta: "text-crm-accent border-crm-accent/25",
  },
  amber: {
    strip: "bg-crm-warning",
    iconBox:
      "border-crm-warning/40 bg-gradient-to-br from-crm-warning/25 to-crm-warning/5 text-crm-warning",
    iconRing:
      "shadow-[0_0_28px_-6px_rgba(245,158,11,0.4)] ring-1 ring-crm-warning/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#1f1a14]/95 via-[#141210] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(245,158,11,0.1),transparent_55%)]",
    card: "hover:border-crm-warning/45 hover:shadow-[0_16px_40px_-12px_rgba(245,158,11,0.22)]",
    badge: "border-crm-warning/35 bg-crm-warning/12 text-crm-warning",
    meta: "text-crm-warning border-crm-warning/25",
  },
  blue: {
    strip: "bg-sky-400",
    iconBox:
      "border-sky-400/40 bg-gradient-to-br from-sky-400/25 to-sky-400/5 text-sky-300",
    iconRing: "shadow-[0_0_28px_-6px_rgba(56,189,248,0.38)] ring-1 ring-sky-400/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#14202e]/95 via-[#101a28] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(56,189,248,0.1),transparent_55%)]",
    card: "hover:border-sky-400/45 hover:shadow-[0_16px_40px_-12px_rgba(56,189,248,0.2)]",
    badge: "border-sky-400/35 bg-sky-400/12 text-sky-300",
    meta: "text-sky-300 border-sky-400/25",
  },
  green: {
    strip: "bg-crm-success",
    iconBox:
      "border-crm-success/40 bg-gradient-to-br from-crm-success/25 to-crm-success/5 text-crm-success",
    iconRing:
      "shadow-[0_0_28px_-6px_rgba(52,211,153,0.38)] ring-1 ring-crm-success/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#122018]/95 via-[#101a14] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(52,211,153,0.1),transparent_55%)]",
    card: "hover:border-crm-success/45 hover:shadow-[0_16px_40px_-12px_rgba(52,211,153,0.2)]",
    badge: "border-crm-success/35 bg-crm-success/12 text-crm-success",
    meta: "text-crm-success border-crm-success/25",
  },
  violet: {
    strip: "bg-violet-400",
    iconBox:
      "border-violet-400/40 bg-gradient-to-br from-violet-400/25 to-violet-400/5 text-violet-300",
    iconRing:
      "shadow-[0_0_28px_-6px_rgba(167,139,250,0.38)] ring-1 ring-violet-400/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#1a1428]/95 via-[#12101c] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(167,139,250,0.1),transparent_55%)]",
    card: "hover:border-violet-400/45 hover:shadow-[0_16px_40px_-12px_rgba(167,139,250,0.2)]",
    badge: "border-violet-400/35 bg-violet-400/12 text-violet-300",
    meta: "text-violet-300 border-violet-400/25",
  },
  teal: {
    strip: "bg-teal-400",
    iconBox:
      "border-teal-400/40 bg-gradient-to-br from-teal-400/25 to-teal-400/5 text-teal-300",
    iconRing: "shadow-[0_0_28px_-6px_rgba(45,212,191,0.38)] ring-1 ring-teal-400/30",
    cardBase:
      "border-crm-border/40 bg-gradient-to-br from-[#102220]/95 via-[#101a18] to-[#0a101c]",
    cardGlow:
      "bg-[radial-gradient(ellipse_at_top_left,rgba(45,212,191,0.1),transparent_55%)]",
    card: "hover:border-teal-400/45 hover:shadow-[0_16px_40px_-12px_rgba(45,212,191,0.2)]",
    badge: "border-teal-400/35 bg-teal-400/12 text-teal-300",
    meta: "text-teal-300 border-teal-400/25",
  },
};

export const CHECKLIST_TEMPLATES: ChecklistTemplate[] = [
  {
    id: "cold-call-qualification",
    name: "Cold Call Qualification",
    description: "Qualify a new prospect on an outbound cold call",
    icon: "📞",
    accent: "cyan",
    items: [
      { label: "Confirm you have the decision maker", required: true },
      { label: "Introduce yourself and company", required: true },
      { label: "State the purpose of the call (30-second pitch)", required: true },
      { label: "Ask if they have 2 minutes", required: false },
      { label: "Identify their current solution / provider", required: true },
      { label: "Uncover a pain point or challenge", required: true },
      { label: "Qualify budget range (direct or indirect)", required: false },
      { label: "Confirm timeline / urgency", required: false },
      { label: "Propose next step (demo / follow-up)", required: true },
      { label: "Confirm contact details and best time to reach", required: false },
    ],
  },
  {
    id: "appointment-booking",
    name: "Appointment Booking",
    description: "Book a discovery call or demo with a qualified lead",
    icon: "📅",
    accent: "amber",
    items: [
      { label: "Confirm contact name and role", required: true },
      { label: "Reference previous interaction or lead source", required: false },
      { label: "State the value of the demo / discovery call", required: true },
      { label: "Confirm they are involved in the decision", required: true },
      { label: "Offer two specific time slots", required: true },
      { label: "Get calendar confirmation / email address", required: true },
      { label: "Send calendar invite before hanging up", required: false },
      { label: "Confirm meeting link / dial-in details", required: false },
      { label: "Summarize what they can expect in the meeting", required: false },
    ],
  },
  {
    id: "insurance-verification",
    name: "Insurance Verification",
    description: "Verify client insurance information on an inbound or outbound call",
    icon: "🛡️",
    accent: "blue",
    items: [
      { label: "Verify caller identity (name, DOB, policy number)", required: true },
      { label: "Confirm primary insurance carrier", required: true },
      { label: "Get policy / member ID number", required: true },
      { label: "Confirm group number (if applicable)", required: false },
      { label: "Verify coverage effective date", required: true },
      { label: "Confirm co-pay / deductible amounts", required: false },
      { label: "Check pre-authorization requirements", required: true },
      { label: "Confirm secondary insurance (if any)", required: false },
      { label: "Read back verified information to caller", required: true },
      { label: "Log verification reference number", required: true },
    ],
  },
  {
    id: "callback-workflow",
    name: "Callback Workflow",
    description: "Follow through on a scheduled callback with context continuity",
    icon: "🔁",
    accent: "green",
    items: [
      { label: "Review previous call notes before dialing", required: true },
      { label: "Reference the scheduled callback date/time", required: true },
      { label: "Confirm the contact remembers the conversation", required: false },
      { label: "Recap where you left off", required: true },
      { label: "Address any questions they mentioned previously", required: false },
      { label: "Present updated offer or information", required: true },
      { label: "Handle objections with prepared responses", required: false },
      { label: "Confirm decision status / next step", required: true },
      { label: "Set follow-up or close the loop", required: true },
    ],
  },
  {
    id: "objection-handling",
    name: "Objection Handling",
    description: "Structured flow for handling common sales objections",
    icon: "🎯",
    accent: "violet",
    items: [
      { label: "Acknowledge the objection without dismissing it", required: true },
      { label: "Clarify the objection (ask open-ended question)", required: true },
      { label: "Identify if it is the real objection or a stall", required: true },
      { label: "Address price objection with ROI framing", required: false },
      { label: "Address timing objection with urgency trigger", required: false },
      { label: "Address competition objection with differentiator", required: false },
      { label: "Confirm the objection is resolved", required: true },
      { label: "Move to next step without hesitation", required: true },
    ],
  },
  {
    id: "follow-up-call",
    name: "Follow-Up Call",
    description: "Post-demo or post-proposal follow-up to advance the deal",
    icon: "✅",
    accent: "teal",
    items: [
      { label: "Review demo / proposal notes before calling", required: true },
      { label: "Reference the specific solution discussed", required: true },
      { label: "Ask for their feedback on the demo/proposal", required: true },
      { label: "Identify any unresolved questions or concerns", required: true },
      { label: "Check in with all stakeholders / influencers", required: false },
      { label: "Reconfirm budget and timeline alignment", required: false },
      { label: "Present any adjusted terms or incentives", required: false },
      { label: "Ask for the decision directly", required: true },
      { label: "Define concrete next step with date", required: true },
      { label: "Log outcome and update contact stage", required: true },
    ],
  },
];
