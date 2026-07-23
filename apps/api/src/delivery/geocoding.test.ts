import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeocodeQuery, parseGeocodeResponse, NoopGeocodingProvider } from "./geocoding";

test("query builder joins non-empty parts, skips unit", () => {
  assert.equal(buildGeocodeQuery({ line1: "142 Elm St", city: "Springfield", region: "NJ", postal: "07000" }), "142 Elm St, Springfield, NJ, 07000");
  assert.equal(buildGeocodeQuery({ line1: "142 Elm St", city: "", region: null, postal: undefined as any }), "142 Elm St");
  assert.equal(buildGeocodeQuery({ line1: "  " }), "");
});

test("parses Nominatim response", () => {
  const r = parseGeocodeResponse("nominatim", [{ lat: "40.12", lon: "-74.34" }]);
  assert.deepEqual(r, { lat: 40.12, lng: -74.34 });
  assert.equal(parseGeocodeResponse("nominatim", []), null);
});

test("parses Mapbox response (center = [lng,lat])", () => {
  const r = parseGeocodeResponse("mapbox", { features: [{ center: [-74.34, 40.12] }] });
  assert.deepEqual(r, { lat: 40.12, lng: -74.34 });
  assert.equal(parseGeocodeResponse("mapbox", { features: [] }), null);
});

test("parses Google response", () => {
  const r = parseGeocodeResponse("google", { results: [{ geometry: { location: { lat: 40.12, lng: -74.34 } } }] });
  assert.deepEqual(r, { lat: 40.12, lng: -74.34 });
  assert.equal(parseGeocodeResponse("google", { results: [] }), null);
});

test("malformed / unknown responses return null (never throw)", () => {
  assert.equal(parseGeocodeResponse("nominatim", null), null);
  assert.equal(parseGeocodeResponse("mapbox", { nope: true }), null);
  assert.equal(parseGeocodeResponse("google", undefined), null);
  assert.equal(parseGeocodeResponse("nominatim" as any, { weird: 1 }), null);
});

test("noop provider yields null (default = no external calls)", async () => {
  assert.equal(await new NoopGeocodingProvider().geocode(), null);
});
