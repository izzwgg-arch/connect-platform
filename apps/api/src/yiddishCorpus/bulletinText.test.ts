/**
 * Bulletin harvest parsing. The fixtures are the real markup the site served
 * on 2026-09-18 (trimmed), because the whole point of this harvest is that the
 * article body lives in ONE place in that markup and nowhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BULLETIN_CAT_ID,
  PUBLISHER_ENGINE,
  hebrewCharCount,
  parseBulletinPage,
  parsePaginationResponse,
  publisherOriginRef,
  readListingParams,
  stripTags,
  compareTokens,
  titleDuplicatesBody,
} from "./bulletinText";

const YI = "\u05d3\u05d9 \u05e4\u05d0\u05dc\u05d9\u05e6\u05d9\u05d9 \u05d4\u05d0\u05d8 \u05d3\u05d5\u05e8\u05db\u05d2\u05e2\u05e4\u05d9\u05e8\u05d8 \u05d0 \u05e6\u05d0\u05dc \u05d0\u05d1\u05dc\u05d0\u05d5\u05d5\u05d0\u05e1";
const YI2 = "\u05e7\u05d9\u05d9\u05e0\u05e2\u05e8 \u05d0\u05d9\u05d6 \u05e0\u05d9\u05e9\u05d8 \u05e4\u05d0\u05e8\u05d5\u05d5\u05d0\u05d5\u05e0\u05d3\u05e2\u05d8 \u05d2\u05e2\u05d5\u05d5\u05d0\u05e8\u05df";
const TITLE = "\u05d0 16-\u05d9\u05e2\u05e8\u05d9\u05d2\u05e2\u05e8 \u05d0\u05d9\u05d6 \u05d0\u05e8\u05e2\u05e1\u05d8\u05d9\u05e8\u05d8 \u05d2\u05e2\u05d5\u05d5\u05d0\u05e8\u05df";

/** NEWER layout: the body sits inside a `content_block` next to an image. */
function page(body: string): string {
  return row("167484", TITLE, `<div class="content_block" data-id="_57_167484"><div class="images_block"><img src="x.jpg"></div>${body}</div>`, true);
}

/** One `bulletin-news-des-row`, exactly as the site emits it — including the
 * commented-out copy of the headline that precedes the real one. */
function row(id: string, title: string, inner: string, withAudio: boolean): string {
  return `
    <div class="bulletin-news-des-row ">
      <div class="bulletin-news-col text-right yiddish-player-details darkred">
        <!-- <h1 id="song-title${id}">${title}</h1><span class="date">x</span> -->
        <div class="post-bullet-wrap"><div class="post-bullet-title">
          <h1 id="song-title${id}">${title}</h1><span class="date">x</span>
        </div></div>
        ${inner}
        ${withAudio ? `<div class=" playing-panel item-data-${id} audio" data-id="${id}" data-song-url="https://cloudfront.yiddish24.com/${id}.mp3"></div>` : ""}
      </div>
    </div>`;
}

test("parseBulletinPage pairs title, body and audio BY ID", () => {
  const html = page(`<p>${YI2}</p>`);
  const [a] = parseBulletinPage(html);
  assert.equal(a.externalId, "167484");
  assert.equal(a.title, TITLE);
  assert.deepEqual(a.paragraphs, [YI2]);
  assert.equal(a.mediaUrl, "https://cloudfront.yiddish24.com/167484.mp3");
  assert.equal(a.fullText, `${TITLE} ${YI2}`);
  assert.ok(a.hebrewChars > 20);
});

test("two articles never cross-contaminate, even when one has no audio", () => {
  // Pairing by ORDER would give article B article A's body here.
  const html = row("1", TITLE, `<p>${YI}</p>`, false) + row("2", TITLE, `<p>${YI2}</p>`, true);
  const got = parseBulletinPage(html);
  assert.deepEqual(got.map((a) => a.externalId), ["1", "2"]);
  assert.deepEqual(got[0].paragraphs, [YI]);
  assert.equal(got[0].mediaUrl, null, "article 1 has no player; it must not borrow article 2's");
  assert.deepEqual(got[1].paragraphs, [YI2]);
  assert.equal(got[1].mediaUrl, "https://cloudfront.yiddish24.com/2.mp3");
});

test("the OLDER layout, with the body and no content_block wrapper, is harvested too", () => {
  // Anchoring on `content_block` (the first version) read every page older than
  // about item 164,000 as empty — roughly 2,300 of 3,230 articles.
  const html = row("163709", TITLE, `<p>${YI}</p>`, true);
  const [a] = parseBulletinPage(html);
  assert.equal(a.externalId, "163709");
  assert.deepEqual(a.paragraphs, [YI]);
  assert.equal(a.mediaUrl, "https://cloudfront.yiddish24.com/163709.mp3");
});

test("the commented-out copy of the headline never doubles the text", () => {
  const html = row("5", TITLE, `<p>${YI}</p>`, true);
  const [a] = parseBulletinPage(html);
  assert.equal((a.fullText.match(new RegExp(TITLE.slice(0, 12), "g")) || []).length, 1);
});

test("the photo credit and non-Yiddish chrome never become article text", () => {
  const html = page(`<p class="photo-credit">Photo credit: <span>Jhon</span></p><p>Loading...</p><p>${YI}</p>`);
  const [a] = parseBulletinPage(html);
  assert.deepEqual(a.paragraphs, [YI], "only the real Yiddish paragraph survives");
});

test("a block with no usable text is dropped rather than stored empty", () => {
  const html = row("9", "", '<div class="content_block" data-id="_57_9"><p>&nbsp;</p></div>', false);
  assert.deepEqual(parseBulletinPage(html), []);
});

test("stripTags decodes the entities this site emits and collapses whitespace", () => {
  assert.equal(stripTags("<p>a&nbsp;&amp;\r\n  b<!-- c --></p>"), "a & b");
  assert.equal(hebrewCharCount("abc"), 0);
  assert.ok(hebrewCharCount(YI) > 10);
});

test("parsePaginationResponse reads the ajax envelope", () => {
  const got = parsePaginationResponse(JSON.stringify({ result: "<div>x</div>", next_page: 3, prev_page: 1, curr_page: "2" }));
  assert.equal(got.html, "<div>x</div>");
  assert.equal(got.nextPage, 3);
  assert.equal(got.currPage, 2);
  // The last page answers next_page: 0/false — that must read as "no more".
  assert.equal(parsePaginationResponse(JSON.stringify({ result: "", next_page: 0, curr_page: "323" })).nextPage, null);
});

test("readListingParams reads the site's own page count, never a guess", () => {
  const html = '<input id="catID" value="57"><input type="hidden" value="323" id="totalPages"><input id="perPage" value="10">';
  assert.deepEqual(readListingParams(html), { catId: 57, totalPages: 323, perPage: 10 });
  assert.deepEqual(readListingParams("<div></div>"), { catId: null, totalPages: null, perPage: null });
});

test("the publisher engine and originRef stay distinct from ivrit and human", () => {
  assert.equal(PUBLISHER_ENGINE, "publisher");
  assert.notEqual(PUBLISHER_ENGINE, "ivrit");
  assert.notEqual(PUBLISHER_ENGINE, "human");
  assert.equal(publisherOriginRef("167484"), "bulletin:167484");
  assert.equal(BULLETIN_CAT_ID, 57);
});

// ── title-vs-body overlap (real 2026-09-18 behaviour of this section) ────────

test("compareTokens ignores the niqqud the site sprinkles inconsistently", () => {
  // Same sentence, one copy pointed, one not — must tokenize identically.
  const pointed = "\u05e4\u05bc\u05d0\u05b8\u05dc\u05d9\u05e6\u05d9\u05d9 \u05d2\u05e8\u05d9\u05d9\u05d8";
  const plain = "\u05e4\u05d0\u05dc\u05d9\u05e6\u05d9\u05d9 \u05d2\u05e8\u05d9\u05d9\u05d8";
  assert.deepEqual(compareTokens(pointed), compareTokens(plain));
  assert.equal(compareTokens(plain).length, 2);
});

test("a headline that IS the body's opening is not repeated in fullText", () => {
  // item 167511: the title is byte-identical to the body's first 141 chars.
  const shared = "\u05d3\u05d9 \u05e8\u05e2\u05e7\u05d0\u05e8\u05d3 \u05d4\u05d5\u05d9\u05db\u05e2 \u05d3\u05d9\u05d6\u05e2\u05dc \u05e4\u05e8\u05d9\u05d9\u05d6\u05df \u05d0\u05d9\u05df \u05d0\u05de\u05e2\u05e8\u05d9\u05e7\u05e2";
  const rest = " \u05d5\u05d5\u05e2\u05df \u05d3\u05d9 \u05d8\u05e8\u05d0\u05e7\u05d8\u05d0\u05e8\u05e1 \u05e4\u05d0\u05d3\u05e2\u05e8\u05df";
  assert.equal(titleDuplicatesBody(shared, shared + rest), true);
  const html = row("5", shared, `<p>${shared + rest}</p>`, true);
  const [a] = parseBulletinPage(html);
  assert.equal(a.fullText, shared + rest, "the opening sentence appears once, not twice");
});

test("a headline that is a separate summary is kept, since the audio may read it", () => {
  // item 167510: headline and body share nothing.
  const title = "\u05d8\u05d5\u05d9\u05d6\u05e0\u05d8\u05e2\u05e8 \u05d0\u05d9\u05d9\u05e0\u05d5\u05d5\u05d0\u05d5\u05d9\u05e0\u05e2\u05e8 \u05e9\u05d8\u05d9\u05d9\u05e2\u05df \u05d0\u05d5\u05d9\u05e1 \u05e2\u05e1\u05e0\u05d5\u05d5\u05d0\u05e8\u05d2";
  const body = "\u05d0\u05d5\u05e7\u05e8\u05d0\u05d9\u05e0\u05d9\u05e9\u05e2 \u05d1\u05d0\u05d0\u05de\u05d8\u05e2 \u05d6\u05d0\u05d2\u05df \u05d0\u05d6 \u05e9\u05d0\u05e1\u05d9\u05d9\u05e2\u05df \u05d6\u05e2\u05e0\u05e2\u05df \u05d0\u05e0\u05d2\u05e2\u05dc\u05d9\u05d9\u05d2\u05d8";
  assert.equal(titleDuplicatesBody(title, body), false);
  const html = row("6", title, `<p>${body}</p>`, true);
  const [a] = parseBulletinPage(html);
  assert.equal(a.fullText, `${title} ${body}`);
});

test("a short shared opening is NOT enough to call the title a duplicate", () => {
  // "די ניו יארק" opens thousands of these; two tokens must not drop a headline.
  const t = "\u05d3\u05d9 \u05e0\u05d9\u05d5 \u05d9\u05d0\u05e8\u05e7 \u05e4\u05d0\u05dc\u05d9\u05e6\u05d9\u05d9";
  const b = "\u05d3\u05d9 \u05e0\u05d9\u05d5 \u05d9\u05d0\u05e8\u05e7 \u05e1\u05d8\u05d9\u05d9\u05d8 \u05d4\u05d0\u05d8 \u05d2\u05e2\u05d6\u05d0\u05d2\u05d8 \u05d0\u05d6 \u05e2\u05e1 \u05d5\u05d5\u05e2\u05d8";
  assert.equal(titleDuplicatesBody(t, b), false);
});
