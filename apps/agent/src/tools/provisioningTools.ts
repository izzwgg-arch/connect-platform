/**
 * "I want to add an extension" / "I want to activate SMS" — the PREPARE half.
 *
 * ⛔ NOTHING HERE CREATES OR CHARGES ANYTHING. Each tool writes a DRAFT
 * `AgentAction` and hands back a plain-English summary and a price. The change
 * only happens after the API re-checks the requester's own account password —
 * and the API re-derives every fact for itself, so a model talked into
 * something outrageous achieves a request and no more.
 *
 * Why the split (same reasoning as the permission-grant tool): a password must
 * never reach a language model, a conversation transcript, or the agent's audit
 * log; and the check has to be something the agent cannot be argued out of.
 *
 * The model is expected to QUOTE THE PRICE AND GET A YES before calling a
 * prepare tool — `account_setup_info` exists so it can do that from real
 * numbers rather than guessing.
 */
import type { ToolSpec, ToolContext } from "./toolRegistry";
import {
  ADD_EXTENSION_CAPABILITY_ID,
  ENABLE_SMS_CAPABILITY_ID,
  ADD_PHONE_NUMBER_CAPABILITY_ID,
  addExtensionHashInput,
  enableSmsHashInput,
  addPhoneNumberHashInput,
  isBillableExtensionNumber,
  SMS_INBOX_SCOPES,
  type SmsInboxScope,
} from "@connect/shared";
import { permissionParamsHash } from "@connect/shared/chatPermissionGrantHash";
import { createHash } from "node:crypto";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface ProvisioningToolDeps {
  prisma: any;
  /** Reads this tenant's REAL prices and monthly total from the invoice engine. */
  loadAccountSetupInfo(tenantId: string): Promise<AccountSetupInfo>;
  /** Numbers this account could take, stock we already own listed first. */
  searchPhoneNumbers?(
    tenantId: string,
    areaCode?: string,
  ): Promise<Array<{ did: string; pretty: string; location: string }>>;
}

export type AccountSetupInfo = {
  monthlyTotal: string;
  extensionPrice: string;
  smsPrice: string;
  additionalNumberPrice: string;
  firstNumberFree: boolean;
  smsAlreadyOn: boolean;
  extensionsInUse: string[];
  suggestedExtensionNumber: string | null;
  people: Array<{ id: string; name: string; email: string }>;
  hasTextableNumber: boolean;
  /** The company's own phone numbers, main line first ("845-723-1213"). */
  companyNumbers?: string[];
};

/** "$30.00" — anything the model reads out to a customer. */
function money(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export { money as formatCentsForChat };

export function buildProvisioningTools(deps: ProvisioningToolDeps): ToolSpec[] {
  return [
    {
      name: "account_setup_info",
      description:
        "What this account currently has and what adding to it costs: the company's own phone numbers (main line first), the monthly total, the price of another extension, of text messaging, and of another phone number; which extension numbers are already taken and a suggested free one; whether texting is already on; and the people on the account with their ids. " +
        "Use this to answer \"what is my company's phone number\" (companyNumbers, first entry is the main line), and BEFORE quoting any price or preparing any change, so the figure you say out loud is the one the customer will actually be billed.",
      minRole: "internal",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: (_args, ctx: ToolContext) => deps.loadAccountSetupInfo(ctx.tenantId),
    },

    {
      name: "prepare_add_extension",
      description:
        "Prepare (do NOT create) one more extension for this account, for a named person who will get a welcome email. " +
        "Only call this once you have told the customer the monthly price and they have agreed, and you have their extension number, first name, last name and email address. " +
        "Returns a confirmation id; the extension is only created after the customer re-enters their own account password in the app, so always tell them a password prompt is coming.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          extensionNumber: { type: "string", description: "The extension number — exactly three digits, e.g. '105'." },
          firstName: { type: "string", description: "The person's first name." },
          lastName: { type: "string", description: "The person's last name." },
          email: { type: "string", description: "The person's email address — the welcome email goes here." },
        },
        required: ["extensionNumber", "firstName", "lastName", "email"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return {
            ok: false,
            error: "no_requester",
            message: "This has to be asked for from a signed-in account, because it needs a password to confirm.",
          };
        }
        const extensionNumber = String(args.extensionNumber ?? "").trim();
        if (!isBillableExtensionNumber(extensionNumber)) {
          return {
            ok: false,
            error: "bad_extension_number",
            message: "An extension number has to be exactly three digits, like 105. Ask them which three-digit number they want.",
          };
        }
        const firstName = String(args.firstName ?? "").trim();
        const lastName = String(args.lastName ?? "").trim();
        const email = String(args.email ?? "").trim().toLowerCase();
        if (!firstName || !lastName) {
          return { ok: false, error: "name_required", message: "I need both a first and a last name for the new extension." };
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return { ok: false, error: "bad_email", message: "That doesn't look like an email address — the welcome email needs a valid one." };
        }

        // Cheap, honest pre-checks so the customer hears the problem in the
        // conversation instead of at the password prompt. The API re-checks
        // both for real; these are courtesy, not security.
        const taken = await deps.prisma.extension.findFirst({
          where: { tenantId: ctx.tenantId, extNumber: extensionNumber },
          select: { id: true },
        });
        if (taken) {
          return {
            ok: false,
            error: "extension_taken",
            message: `Extension ${extensionNumber} is already in use on this account. Ask them for a different three-digit number.`,
          };
        }
        const emailTaken = await deps.prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (emailTaken) {
          return {
            ok: false,
            error: "email_taken",
            message: `${email} already has an account. Ask them for a different email address.`,
          };
        }

        const info = await deps.loadAccountSetupInfo(ctx.tenantId);
        const summary = `Add extension ${extensionNumber} for ${firstName} ${lastName} (${email}).`;
        const action = await deps.prisma.agentAction.create({
          data: {
            tenantId: ctx.tenantId,
            capabilityId: ADD_EXTENSION_CAPABILITY_ID,
            params: { extensionNumber, firstName, lastName, email },
            riskTier: "high",
            status: "DRAFT",
            summary,
            requestedBy: ctx.clientUserId,
            requestedRole: ctx.role,
            paramsHash: sha256(addExtensionHashInput(ctx.tenantId, { extensionNumber, email })),
          },
          select: { id: true },
        });

        return {
          ok: true,
          actionId: action.id,
          summary,
          price: info.extensionPrice,
          requiresPasswordConfirmation: true,
          message:
            `${summary} That's ${info.extensionPrice} a month. This is not done yet — confirm it with your account password and ` +
            `${firstName} will get a welcome email with everything needed to set up the phone.`,
        };
      },
    },

    {
      name: "prepare_enable_sms",
      description:
        "Prepare (do NOT switch on) text messaging for this account. " +
        "Only call this once you have told the customer the monthly price, they have agreed, and you have asked whose inbox the texts should go to: " +
        "'everyone' (shared with the whole company), 'one_person' (one named person), or 'shared_with' (a specific group of people). " +
        "For 'one_person' and 'shared_with' you must pass the person ids from account_setup_info. " +
        "Returns a confirmation id; texting is only switched on after the customer re-enters their own account password.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "'everyone' | 'one_person' | 'shared_with' — who sees the text inbox.",
          },
          userIds: {
            type: "array",
            items: { type: "string" },
            description: "Person ids from account_setup_info. Empty for 'everyone'; exactly one for 'one_person'.",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return {
            ok: false,
            error: "no_requester",
            message: "This has to be asked for from a signed-in account, because it needs a password to confirm.",
          };
        }
        const scope = String(args.scope ?? "") as SmsInboxScope;
        if (!SMS_INBOX_SCOPES.includes(scope)) {
          return {
            ok: false,
            error: "bad_scope",
            message: "Ask them whether the text inbox should be shared with everyone, go to one person, or be shared between specific people.",
          };
        }
        const userIds = Array.isArray(args.userIds) ? args.userIds.map((x) => String(x)).filter(Boolean) : [];
        if (scope === "one_person" && userIds.length !== 1) {
          return { ok: false, error: "need_one_person", message: "Ask them which single person the texts should go to." };
        }
        if (scope === "shared_with" && userIds.length === 0) {
          return { ok: false, error: "need_people", message: "Ask them which people should share the text inbox." };
        }
        const ids = scope === "everyone" ? [] : userIds;

        // ⛔ Scoped to the caller's own tenant — someone in another company
        // simply does not exist from here.
        if (ids.length) {
          const found = await deps.prisma.user.findMany({
            where: { id: { in: ids }, tenantId: ctx.tenantId },
            select: { id: true },
          });
          if (found.length !== ids.length) {
            return { ok: false, error: "unknown_person", message: "I couldn't find one of those people on this account." };
          }
        }

        const info = await deps.loadAccountSetupInfo(ctx.tenantId);
        if (info.smsAlreadyOn) {
          return { ok: false, error: "sms_already_on", message: "Text messaging is already switched on for this account." };
        }
        if (!info.hasTextableNumber) {
          return {
            ok: false,
            error: "no_sms_number",
            message: "There's no phone number set up for texting on this account yet — a number has to be added first.",
          };
        }

        const who =
          scope === "everyone"
            ? "shared with everyone on the account"
            : scope === "one_person"
              ? "going to one person"
              : "shared between the people chosen";
        const summary = `Turn on text messaging, with the inbox ${who}.`;
        const action = await deps.prisma.agentAction.create({
          data: {
            tenantId: ctx.tenantId,
            capabilityId: ENABLE_SMS_CAPABILITY_ID,
            params: { scope, userIds: ids },
            riskTier: "high",
            status: "DRAFT",
            summary,
            requestedBy: ctx.clientUserId,
            requestedRole: ctx.role,
            paramsHash: sha256(enableSmsHashInput(ctx.tenantId, { scope, userIds: ids })),
          },
          select: { id: true },
        });

        return {
          ok: true,
          actionId: action.id,
          summary,
          price: info.smsPrice,
          requiresPasswordConfirmation: true,
          message:
            `${summary} That's ${info.smsPrice} a month. This is not switched on yet — confirm it with your account password.`,
        };
      },
    },
    {
      name: "search_phone_numbers",
      description:
        "Phone numbers this account could add, best first. Optionally pass a 3-digit area code to look in one area. " +
        "Use this after the customer has agreed to the monthly price, so they can pick the number they want. Read a few of them out and let them choose.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          areaCode: { type: "string", description: "Optional 3-digit area code, e.g. '845'." },
        },
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!deps.searchPhoneNumbers) {
          return { ok: false, error: "unavailable", message: "I can't look up available numbers right now." };
        }
        const areaCode = String(args.areaCode ?? "").replace(/\D/g, "").slice(0, 3) || undefined;
        const numbers = await deps.searchPhoneNumbers(ctx.tenantId, areaCode);
        if (!numbers.length) {
          return {
            ok: false,
            error: "none_available",
            message: areaCode
              ? `I couldn't find any numbers in the ${areaCode} area. Ask them if another area code would work.`
              : "I couldn't find any available numbers just now.",
          };
        }
        return { ok: true, numbers };
      },
    },

    {
      name: "prepare_add_phone_number",
      description:
        "Prepare (do NOT buy) one more phone number for this account, chosen from search_phone_numbers. " +
        "Only call this once you have told the customer the monthly price, they have agreed, and they have picked a specific number. " +
        "Returns a confirmation id; the number is only bought and connected after the customer re-enters their own account password.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          did: { type: "string", description: "The 10-digit number they chose, exactly as search_phone_numbers returned it." },
        },
        required: ["did"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return {
            ok: false,
            error: "no_requester",
            message: "This has to be asked for from a signed-in account, because it needs a password to confirm.",
          };
        }
        const did = String(args.did ?? "").replace(/\D/g, "").slice(-10);
        if (did.length !== 10) {
          return { ok: false, error: "bad_number", message: "Ask them to pick one of the numbers I listed." };
        }
        if (/^(800|833|844|855|866|877|888)/.test(did)) {
          return {
            ok: false,
            error: "tollfree_not_by_chat",
            message: "Toll-free numbers are priced differently and have to be set up by our team. Offer them a local number instead.",
          };
        }

        const info = await deps.loadAccountSetupInfo(ctx.tenantId);
        const pretty = `(${did.slice(0, 3)}) ${did.slice(3, 6)}-${did.slice(6)}`;
        const summary = `Add the phone number ${pretty} to this account.`;
        const action = await deps.prisma.agentAction.create({
          data: {
            tenantId: ctx.tenantId,
            capabilityId: ADD_PHONE_NUMBER_CAPABILITY_ID,
            params: { did },
            riskTier: "high",
            status: "DRAFT",
            summary,
            requestedBy: ctx.clientUserId,
            requestedRole: ctx.role,
            paramsHash: sha256(addPhoneNumberHashInput(ctx.tenantId, { did })),
          },
          select: { id: true },
        });

        return {
          ok: true,
          actionId: action.id,
          summary,
          price: info.additionalNumberPrice,
          requiresPasswordConfirmation: true,
          message:
            `${summary} That's ${info.additionalNumberPrice} a month. This is not done yet — confirm it with your account password ` +
            `and the number will be connected to your phones.`,
        };
      },
    },
  ];
}

/** Re-exported so the permission-grant tool and these share one hash helper. */
export { permissionParamsHash };
