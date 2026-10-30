// Typing a time into the time box: the ways people write it.

import { describe, it, expect } from "vitest";
import { parseTypedTime } from "@/lib/typedTime";

describe("a typed time", () => {
  it("with AM/PM, however it's written", () => {
    expect(parseTypedTime("10:30 PM")).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("1030p")).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("10p")).toEqual({ h: 22, m: 0 });
    expect(parseTypedTime("7:15am")).toEqual({ h: 7, m: 15 });
    expect(parseTypedTime("12a")).toEqual({ h: 0, m: 0 });
    expect(parseTypedTime("12 pm")).toEqual({ h: 12, m: 0 });
  });
  it("24-hour", () => {
    expect(parseTypedTime("22:30")).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("2230")).toEqual({ h: 22, m: 30 });
    expect(parseTypedTime("0")).toEqual({ h: 0, m: 0 });
    expect(parseTypedTime("14")).toEqual({ h: 14, m: 0 });
  });
  it("1-12 with no AM or PM is never guessed: it needs its a or p", () => {
    for (const s of ["7", "730", "1130", "11:30", "12"]) expect(parseTypedTime(s)).toBeNull();
    expect(parseTypedTime("1130p")).toEqual({ h: 23, m: 30 });
  });
  it("nothing until it's a whole time", () => {
    for (const s of ["", "10:", "10:3", "25:00", "10:75", "13p", "0a", "abc", "12345"]) expect(parseTypedTime(s)).toBeNull();
  });
});
