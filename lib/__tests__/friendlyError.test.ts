import { describe, it, expect } from "vitest";
import { explainError, friendlyError, errorKind } from "@/lib/friendlyError";

describe("friendlyError", () => {
  it("turns the PostgREST single-row error into plain words", () => {
    const e = { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows" };
    expect(errorKind(e)).toBe("not-found");
    expect(friendlyError(e)).not.toMatch(/JSON/);
  });

  it("reads network failures", () => {
    expect(errorKind(new TypeError("Failed to fetch"))).toBe("network");
    expect(errorKind(new TypeError("Load failed"))).toBe("network");
    expect(explainError(new TypeError("Failed to fetch")).retry).toBe(true);
  });

  it("reads HTTP statuses", () => {
    expect(errorKind({ status: 401, message: "x" })).toBe("signin");
    expect(errorKind({ status: 403 })).toBe("access");
    expect(errorKind({ status: 404 })).toBe("not-found");
    expect(errorKind({ status: 500 })).toBe("server");
    expect(errorKind({ status: 503 })).toBe("server");
  });

  it("reads database codes", () => {
    expect(errorKind({ code: "42501", message: "new row violates row-level security policy" })).toBe("access");
    expect(errorKind({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe("conflict");
    expect(errorKind({ code: "23503", message: "update or delete violates foreign key constraint" })).toBe("in-use");
  });

  it("keeps a message the app wrote for people", () => {
    expect(explainError(new Error("Pick a file first.")).message).toBe("Pick a file first.");
  });

  it("hides machine-made messages it doesn't know", () => {
    const f = explainError(new Error("Cannot read properties of undefined (reading 'id')"));
    expect(f.message).toBe("Something went wrong.");
    expect(f.next).toMatch(/Try again/);
  });

  it("always says what to do next", () => {
    for (const e of [{ status: 401 }, { status: 500 }, "x", null, new Error("boom {json}")]) expect(explainError(e).next.length).toBeGreaterThan(5);
  });
});
