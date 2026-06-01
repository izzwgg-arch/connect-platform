import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCampaignFilterOptions,
  buildStageFilterOptions,
  buildTagFilterOptions,
  buildTimezoneFilterOptions,
} from "./contactFilterOptions";

test("buildCampaignFilterOptions prepends All campaigns", () => {
  assert.deepEqual(
    buildCampaignFilterOptions([{ id: "camp-1", name: "May Leads" }]),
    [
      { value: "all", label: "All campaigns" },
      { value: "camp-1", label: "May Leads" },
    ],
  );
});

test("buildTagFilterOptions includes counts in labels", () => {
  assert.deepEqual(
    buildTagFilterOptions([{ tag: { id: "tag-1", name: "VIP" }, count: 3 }]),
    [
      { value: "all", label: "All tags" },
      { value: "tag-1", label: "VIP (3)" },
    ],
  );
});

test("buildTimezoneFilterOptions preserves timezone values", () => {
  assert.deepEqual(
    buildTimezoneFilterOptions([
      { value: "all", label: "All timezones" },
      { value: "eastern", label: "Eastern" },
    ]),
    [
      { value: "all", label: "All timezones" },
      { value: "eastern", label: "Eastern" },
    ],
  );
});

test("buildStageFilterOptions maps stage tabs to labels", () => {
  assert.deepEqual(
    buildStageFilterOptions(["all", "LEAD"], { all: "All stages", LEAD: "Lead" }),
    [
      { value: "all", label: "All stages" },
      { value: "LEAD", label: "Lead" },
    ],
  );
});
