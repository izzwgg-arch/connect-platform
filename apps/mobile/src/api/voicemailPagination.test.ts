/**
 * Run: pnpm --filter @connect/mobile test:voicemail-pagination
 */
import assert from "node:assert/strict";
import {
  shouldFetchAnotherVoicemailPage,
  VOICEMAIL_API_PAGE_SIZE,
  VOICEMAIL_MAX_PAGES_PER_FOLDER,
} from "./voicemailPagination";

const PS = VOICEMAIL_API_PAGE_SIZE;
const MAX = VOICEMAIL_MAX_PAGES_PER_FOLDER;

assert.equal(shouldFetchAnotherVoicemailPage(100, 1, 250, MAX, PS), true);
assert.equal(shouldFetchAnotherVoicemailPage(100, 2, 250, MAX, PS), true);
assert.equal(shouldFetchAnotherVoicemailPage(50, 3, 250, MAX, PS), false);
assert.equal(shouldFetchAnotherVoicemailPage(100, 2, 200, MAX, PS), false);
assert.equal(shouldFetchAnotherVoicemailPage(0, 1, 0, MAX, PS), false);
assert.equal(shouldFetchAnotherVoicemailPage(100, MAX, 99999, MAX, PS), false);

console.log("voicemailPagination tests ok");
