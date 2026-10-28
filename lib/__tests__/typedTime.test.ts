// Typing a time into the time box: the ways people write it.

import { describe, it, expect } from "vitest";
import { parseTypedTime } from "@/lib/typedTime";

describe("a typed time", () => {
  it("with AM/PM, however it's written", () => {
    expect(parseTypedTime("10:30 PM", false)).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("1030p", false)).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("10p", false)).toEqual({ h: 22, m: 0 });
    expect(parseTypedTime("7:15am", true)).toEqual({ h: 7, m: 15 });
    expect(parseTypedTime("12a", true)).toEqual({ h: 0, m: 0 });
    expect(parseTypedTime("12 pm", false)).toEqual({ h: 12, m: 0 });
  });
  it("24-hour", () => {
    expect(parseTypedTime("22:30", false)).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("2230", false)).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("0", true)).toEqual({ h: 0, m: 0 });
    expect(parseTypedTime("14", false)).toEqual({ h: 14, m: 0 });
  });
  it("1-12 with no AM/PM keeps the AM/PM it had", () => {
    expect(parseTypedTime("7", true)).toEqual({ h: 19, m: 0 });
    expect(parseTypedTime("730", false)).toEqual({ h: 7, m: 30 });
    expect(parseTypedTime("12", false)).toEqual({ h: 0, m: 0 });
  });
  it("nothing until it's a whole time", () => {
    for (const s of ["", "10:", "10:3", "25:00", "10:75", "13p", "0a", "abc", "12345"]) expect(parseTypedTime(s, false)).toBeNull();
  });
});
