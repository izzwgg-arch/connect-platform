import test from "node:test";
import assert from "node:assert/strict";
import { tenDlcSubmissionSchema } from "./validation";

test("10DLC schema rejects invalid website URL", () => {
  const result = tenDlcSubmissionSchema.safeParse({
    legalName: "Connect Communications LLC",
    ein: "12-3456789",
    businessType: "LLC",
    websiteUrl: "not-a-url",
    businessAddress: { street: "1 Main", city: "Las Vegas", state: "NV", zip: "89101", country: "US" },
    supportEmail: "support@connectcomunications.com",
    supportPhone: "7025551234",
    useCaseCategory: "marketing",
    messageSamples: ["sample1", "sample2", "sample3"],
    optInMethod: "website_form",
    optInWorkflowDescription: "Users opt in via web form with checkbox consent.",
    optInProofUrl: "",
    volumeEstimate: { messagesPerDay: 100, messagesPerMonth: 3000 },
    includesEmbeddedLinks: false,
    includesEmbeddedPhoneNumbers: true,
    includesAffiliateMarketing: false,
    ageGatedContent: false,
    termsAccepted: true,
    signatureName: "Ops Admin",
    signatureDate: "2026-02-24"
  });

  assert.equal(result.success, false);
});
