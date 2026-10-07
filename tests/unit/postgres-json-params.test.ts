import { describe, expect, it } from "vitest";

import { serializeJsonParam } from "../../src/server/db/postgres";

describe("postgres.js json/jsonb parameter serialisation", () => {
  it("passes already-serialised JSON text through untouched (it must not be stringified a second time)", () => {
    const text = JSON.stringify({ qualifyingThreshold: 123, nested: { a: [1, 2] } });
    expect(serializeJsonParam(text)).toBe(text);
    // the failure mode this guards against: a jsonb *string* whose content is JSON text
    expect(JSON.parse(serializeJsonParam(text))).toEqual({ qualifyingThreshold: 123, nested: { a: [1, 2] } });
  });

  it("still serialises real objects, arrays and primitives", () => {
    expect(serializeJsonParam({ a: 1 })).toBe('{"a":1}');
    expect(serializeJsonParam([1, "x"])).toBe('[1,"x"]');
    expect(serializeJsonParam(5)).toBe("5");
    expect(serializeJsonParam(null)).toBe("null");
  });
});
