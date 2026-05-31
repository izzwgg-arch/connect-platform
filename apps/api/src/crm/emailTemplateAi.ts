import OpenAI from "openai";

export class CrmEmailTemplateAiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function generateCrmEmailTemplateDraft(input: {
  action: string;
  prompt: string;
  subject?: string | null;
  bodyText?: string | null;
  category?: string | null;
}): Promise<{ subject: string; previewText: string; bodyText: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new CrmEmailTemplateAiError(
      "ai_not_configured",
      "OPENAI_API_KEY is not configured. Ask an administrator to enable CRM email AI.",
    );
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.CRM_EMAIL_AI_MODEL || process.env.LEAD_INTELLIGENCE_MODEL || "gpt-4o-mini";
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.35,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You write concise, professional CRM sales emails. Return JSON only with subject, previewText, and bodyText. Use merge tokens like {{contact.firstName}}, {{business.name}}, and {{sender.signature}} when useful. Do not invent real company data.",
      },
      {
        role: "user",
        content: JSON.stringify({
          action: input.action,
          prompt: input.prompt,
          currentSubject: input.subject || "",
          currentBodyText: input.bodyText || "",
          category: input.category || "Custom",
        }),
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content || "";
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CrmEmailTemplateAiError("ai_invalid_response", "AI provider returned an invalid response.");
  }
  return {
    subject: String(parsed.subject || input.subject || "").slice(0, 500),
    previewText: String(parsed.previewText || "").slice(0, 300),
    bodyText: String(parsed.bodyText || "").slice(0, 50000),
  };
}
