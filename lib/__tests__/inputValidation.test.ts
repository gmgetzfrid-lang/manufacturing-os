// lib/__tests__/inputValidation.test.ts
//
// Pure-function tests for the Postgres error translator. A bug
// here means users see raw SQL errors instead of plain-language
// messages — the whole point of the defensive input layer.

import { describe, it, expect } from "vitest";
import { translatePostgresError, tidyWhitespace, requiredField } from "@/lib/inputValidation";

describe("translatePostgresError", () => {
  it("translates 23505 (unique violation) with entity + field context", () => {
    const err = { code: "23505", message: 'duplicate key value violates unique constraint "assets_org_id_tag_normalized_key"' };
    const out = translatePostgresError(err, { entity: "asset", field: "tag" });
    expect(out.code).toBe("23505");
    expect(out.heading).toMatch(/asset already exists/i);
    expect(out.message).toMatch(/with that tag/i);
  });

  it("includes the constraint name when present", () => {
    const err = { code: "23505", message: 'violates unique constraint "documents_library_docnumber_uniq"' };
    const out = translatePostgresError(err, { entity: "document" });
    expect(out.message).toContain("documents_library_docnumber_uniq");
  });

  it("translates 23503 (FK violation)", () => {
    const err = { code: "23503", message: "violates foreign key constraint" };
    const out = translatePostgresError(err, { entity: "hold" });
    expect(out.heading).toMatch(/referenced/i);
    expect(out.message).toMatch(/hold/);
  });

  it("translates 23502 (not-null violation)", () => {
    const err = { code: "23502", message: "null value in column..." };
    const out = translatePostgresError(err, { field: "name" });
    expect(out.heading).toMatch(/required/i);
    expect(out.heading).toContain("name");
  });

  it("translates 23514 (check constraint)", () => {
    const err = { code: "23514", message: "check constraint failed" };
    const out = translatePostgresError(err);
    expect(out.heading).toMatch(/not allowed/i);
  });

  it("translates 42501 (permission denied)", () => {
    const err = { code: "42501", message: "permission denied" };
    const out = translatePostgresError(err);
    expect(out.heading).toMatch(/not permitted/i);
    expect(out.message).toMatch(/admin/i);
  });

  it("translates 42P01 (missing table)", () => {
    const err = { code: "42P01", message: "relation does not exist" };
    const out = translatePostgresError(err);
    expect(out.heading).toMatch(/database/i);
    expect(out.message).toMatch(/migrations/i);
  });

  it("extracts the code from the message when not on the err object", () => {
    const err = new Error("ERROR: 23505: duplicate key value");
    const out = translatePostgresError(err, { entity: "thing" });
    expect(out.code).toBe("23505");
  });

  it("falls back to the raw message for unknown codes", () => {
    const err = { code: "99999", message: "weird unknown error" };
    const out = translatePostgresError(err, { entity: "asset" });
    expect(out.heading).toMatch(/couldn't save asset/i);
    expect(out.message).toContain("weird unknown error");
  });

  it("handles string errors", () => {
    const out = translatePostgresError("some raw error");
    expect(out.message).toBe("some raw error");
  });

  it("handles null / undefined", () => {
    expect(translatePostgresError(null).message).toBeTruthy();
    expect(translatePostgresError(undefined).message).toBeTruthy();
  });
});

describe("tidyWhitespace", () => {
  it("trims and collapses internal whitespace", () => {
    expect(tidyWhitespace("  hello   world  ")).toBe("hello world");
  });
  it("collapses tabs and newlines as whitespace", () => {
    expect(tidyWhitespace("a\t\tb\nc")).toBe("a b c");
  });
});

describe("requiredField", () => {
  it("returns null when value is non-empty", () => {
    expect(requiredField("hi", "Field")).toBeNull();
  });
  it("rejects empty / whitespace-only values", () => {
    expect(requiredField("", "Field")).toMatch(/required/);
    expect(requiredField("   ", "Field")).toMatch(/required/);
  });
  it("enforces minLength", () => {
    expect(requiredField("ab", "Field", { minLength: 3 })).toMatch(/at least 3/);
    expect(requiredField("abc", "Field", { minLength: 3 })).toBeNull();
  });
  it("enforces maxLength", () => {
    expect(requiredField("abcdef", "Field", { maxLength: 5 })).toMatch(/5 characters or fewer/);
    expect(requiredField("abcde", "Field", { maxLength: 5 })).toBeNull();
  });
});
