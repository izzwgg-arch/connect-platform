/** Phase 19I — starter script templates for the scripts playbook workspace. */

export type ScriptTemplateAccent =
  | "cyan"
  | "violet"
  | "amber"
  | "green"
  | "blue"
  | "rose";

export interface ScriptTemplate {
  key: string;
  label: string;
  description: string;
  body: string;
  accent: ScriptTemplateAccent;
  icon: string;
}

/** Tailwind accent bundles per template — paired with crm.scriptTpl* tokens. */
export const SCRIPT_TEMPLATE_ACCENT_CLASSES: Record<
  ScriptTemplateAccent,
  { strip: string; iconBox: string; card: string; meta: string }
> = {
  cyan: {
    strip: "bg-crm-accent",
    iconBox:
      "border-crm-accent/35 bg-crm-accent/12 text-crm-accent shadow-[0_0_20px_-4px_rgba(56,189,248,0.35)]",
    card: "hover:border-crm-accent/45 hover:shadow-[0_0_28px_-8px_rgba(56,189,248,0.22)]",
    meta: "text-crm-accent",
  },
  violet: {
    strip: "bg-violet-400",
    iconBox:
      "border-violet-400/35 bg-violet-400/12 text-violet-300 shadow-[0_0_20px_-4px_rgba(167,139,250,0.28)]",
    card: "hover:border-violet-400/40 hover:shadow-[0_0_28px_-8px_rgba(167,139,250,0.16)]",
    meta: "text-violet-300",
  },
  amber: {
    strip: "bg-crm-warning",
    iconBox:
      "border-crm-warning/35 bg-crm-warning/12 text-crm-warning shadow-[0_0_20px_-4px_rgba(245,158,11,0.3)]",
    card: "hover:border-crm-warning/40 hover:shadow-[0_0_28px_-8px_rgba(245,158,11,0.18)]",
    meta: "text-crm-warning",
  },
  green: {
    strip: "bg-crm-success",
    iconBox:
      "border-crm-success/35 bg-crm-success/12 text-crm-success shadow-[0_0_20px_-4px_rgba(52,211,153,0.28)]",
    card: "hover:border-crm-success/40 hover:shadow-[0_0_28px_-8px_rgba(52,211,153,0.16)]",
    meta: "text-crm-success",
  },
  blue: {
    strip: "bg-sky-400",
    iconBox:
      "border-sky-400/35 bg-sky-400/12 text-sky-300 shadow-[0_0_20px_-4px_rgba(56,189,248,0.28)]",
    card: "hover:border-sky-400/40 hover:shadow-[0_0_28px_-8px_rgba(56,189,248,0.16)]",
    meta: "text-sky-300",
  },
  rose: {
    strip: "bg-rose-400",
    iconBox:
      "border-rose-400/35 bg-rose-400/12 text-rose-300 shadow-[0_0_20px_-4px_rgba(251,113,133,0.25)]",
    card: "hover:border-rose-400/40 hover:shadow-[0_0_28px_-8px_rgba(251,113,133,0.14)]",
    meta: "text-rose-300",
  },
};

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    key: "cold-call",
    label: "Cold Call",
    description: "First-touch outbound introduction",
    accent: "cyan",
    icon: "📞",
    body: `# Introduction
Hi, this is [Agent Name] calling from [Company]. Am I speaking with [Contact Name]?

Great! I'm reaching out because we help [industry] businesses [key benefit]. I wanted to take just a couple of minutes to see if that might be relevant for you.

---

# Qualification
Do you currently have a solution in place for [problem area]?

How are you handling [pain point] today?

Who else is typically involved in decisions like this?

---

# Value Proposition
We help companies like yours [benefit 1] and [benefit 2] — typically within [timeframe].

One of our clients, [example], was able to [specific result] after working with us.

---

# Objection Handling
**"Not interested"**
I completely understand. Just out of curiosity, is it the timing, or is there something specific that doesn't seem relevant?

**"We already have a solution"**
That makes sense. A lot of our customers came to us when they were already using something. What made you choose your current provider?

**"Send me an email"**
Absolutely. Before I do, is there a specific topic you'd like me to focus on so I can make it worth your time?

---

# Closing
Based on what you've shared, I think there could be a good fit here. Would it make sense to set up a quick 15-minute call this week so I can show you exactly what we do?

What day works better — [Day] or [Day]?`,
  },
  {
    key: "follow-up",
    label: "Follow-Up",
    description: "Re-engage after prior contact",
    accent: "violet",
    icon: "✉️",
    body: `# Opening
Hi [Contact Name], this is [Agent Name] from [Company]. We spoke [timeframe] ago about [topic]. How have things been?

---

# Recap
Last time we talked, you mentioned [pain point / interest]. I wanted to follow up and see if that's still something you're thinking about.

---

# Check-in Questions
Has anything changed on your end since we last spoke?

Are you still the right person to be speaking with about this?

---

# Move Forward
I've been working with a few other companies in your space and wanted to share what's been working for them. Is now still a good time?

If so, I'd love to get 20 minutes on the calendar to walk you through a quick demo. Does [Day] or [Day] work?`,
  },
  {
    key: "re-engagement",
    label: "Re-Engagement",
    description: "Wake up a dormant or cold lead",
    accent: "amber",
    icon: "🔄",
    body: `# Opening
Hi [Contact Name], this is [Agent Name] from [Company]. I know it's been a while — I hope things are going well.

I'm reaching out because [reason: new feature / updated pricing / industry event].

---

# Re-establish Context
We last connected around [timeframe]. At that point you were [situation]. Is that still where things stand?

---

# New Angle
Since we last spoke, we've [new development / improvement]. I thought of you because [personalized reason].

---

# Commitment Ask
I don't want to take too much of your time today. Would it be worth a quick 15-minute catch-up so I can share what's changed? No pressure — just want to make sure you have the latest information.`,
  },
  {
    key: "callback",
    label: "Callback",
    description: "Scheduled callback conversation",
    accent: "green",
    icon: "📅",
    body: `# Opening
Hi [Contact Name], this is [Agent Name] from [Company]. We had a callback scheduled for today — is now still a good time?

---

# Context Reset
Last time we spoke, we talked about [topic]. You mentioned [key detail]. I've had a chance to think about that and wanted to pick up where we left off.

---

# Advance the Conversation
Have you had a chance to [action they were going to take / think about / review]?

What questions have come up since we last spoke?

---

# Next Step
Great — based on what you've shared, I think the best next step is [specific action]. Does that sound right to you?

Let's lock that in. Can I send you a calendar invite for [day/time]?`,
  },
  {
    key: "voicemail",
    label: "Voicemail",
    description: "Short, compelling voicemail drop",
    accent: "blue",
    icon: "🎙️",
    body: `# Voicemail Script
Hi [Contact Name], this is [Agent Name] from [Company].

I'm calling because [one-sentence reason — specific and relevant].

If you get a chance, please give me a call back at [phone number], or I'll try you again [day].

Have a great day!

---

# Voicemail (Short Version)
Hi [Contact Name] — [Agent Name] at [Company], [phone number]. Calling about [topic]. Talk soon.`,
  },
  {
    key: "closing",
    label: "Closing",
    description: "Late-stage commitment and close",
    accent: "rose",
    icon: "🎯",
    body: `# Recap
So just to summarize where we are: you've said [pain point], and you're looking to [goal]. Based on that, I believe [product/service] is a strong fit.

---

# Handle Final Objections
**"I need to think about it"**
Of course. What specific concerns do you still have? I want to make sure you have everything you need to make a confident decision.

**"I need to talk to my team"**
That makes sense. If your team is supportive, is there anything on your end that would hold this back?

**"The price is too high"**
I understand. Let me ask — if price weren't a factor, is this the right solution for you? [If yes] Let's talk about what we can do to make this work.

---

# Close
Based on everything we've discussed, I'd like to move forward. Can we get the paperwork started today?

What would you need to feel comfortable saying yes right now?

---

# Commitment
Great. Here's what I'll do: I'll send you [next step] by [time]. You'll have everything you need by end of day. Sound good?`,
  },
];

/** Parse a script body into named sections separated by `---` */
export function parseScriptSections(body: string): { title: string; content: string }[] {
  const rawSections = body.split(/\n---\n/);
  return rawSections
    .map((raw) => {
      const lines = raw.trim().split("\n");
      const firstLine = lines[0] ?? "";
      if (firstLine.startsWith("# ")) {
        return {
          title: firstLine.replace(/^#\s+/, "").trim(),
          content: lines.slice(1).join("\n").trim(),
        };
      }
      return {
        title: "",
        content: raw.trim(),
      };
    })
    .filter((s) => s.content.length > 0 || s.title.length > 0);
}

/** Serialize sections back into a body string */
export function serializeScriptSections(sections: { title: string; content: string }[]): string {
  return sections
    .filter((s) => s.title.trim() || s.content.trim())
    .map((s) => {
      const titleLine = s.title.trim() ? `# ${s.title.trim()}` : "";
      const contentBlock = s.content.trim();
      return [titleLine, contentBlock].filter(Boolean).join("\n");
    })
    .join("\n\n---\n\n");
}
