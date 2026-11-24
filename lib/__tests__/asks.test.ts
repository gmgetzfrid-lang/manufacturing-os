import { describe, it, expect } from "vitest";
import { askForNotification, withAsk, withoutAsk, readAsk, daysFromToday, dueWords } from "@/lib/asks";

describe("askForNotification", () => {
  it("maps each kind that waits on someone to what the landing asks", () => {
    expect(askForNotification("review_due")).toBe("review");
    expect(askForNotification("owner_behind")).toBe("review");
    expect(askForNotification("ack_requested")).toBe("ack");
    expect(askForNotification("review_requested")).toBe("signoff");
    expect(askForNotification("review_invalidated")).toBe("signoff");
    expect(askForNotification("review_complete")).toBe("publish");
    expect(askForNotification("ack_overdue")).toBe("chase");
    expect(askForNotification("markup_request")).toBe("markup");
    expect(askForNotification("checkout_released")).toBe("checkout");
    expect(askForNotification("hold_opened")).toBe("hold");
    expect(askForNotification("access_recert_due")).toBe("recert");
    expect(askForNotification("request_pending_approval")).toBe("turn");
  });
  it("tells a distribution confirmation apart from a read-and-understood one", () => {
    expect(askForNotification("ack_requested", { ackRequest: true })).toBe("dist");
    expect(askForNotification("doc_superseded", { ackRequest: true, versionId: "v" })).toBe("dist");
    expect(askForNotification("doc_superseded")).toBeNull();
  });
  it("asks nothing for news", () => {
    expect(askForNotification("library_doc_added")).toBeNull();
    expect(askForNotification("project_comment")).toBeNull();
  });
});

describe("withAsk", () => {
  it("adds the ask and the notification to the link, keeping what it had", () => {
    expect(withAsk("/documents/L1?doc=D1", "review", "N1")).toBe("/documents/L1?doc=D1&ask=review&n=N1");
    expect(withAsk("/requests/T1?c=C9#c-C9", "turn")).toBe("/requests/T1?c=C9&ask=turn#c-C9");
    expect(withAsk("/documents/L1", "recert")).toBe("/documents/L1?ask=recert");
  });
  it("replaces an ask already there", () => {
    expect(withAsk("/documents/L1?doc=D1&ask=ack&n=OLD", "review", "N2")).toBe("/documents/L1?doc=D1&ask=review&n=N2");
  });
  it("leaves the link alone when there is nothing to ask or it isn't ours", () => {
    expect(withAsk("/documents/L1?doc=D1", null)).toBe("/documents/L1?doc=D1");
    expect(withAsk("https://example.com/x", "review")).toBe("https://example.com/x");
  });
  it("takes the ask off again", () => {
    expect(withoutAsk("?doc=D1&ask=review&n=N1&folderId=F")).toBe("doc=D1&folderId=F");
  });
  it("reads only asks it knows", () => {
    expect(readAsk("review")).toBe("review");
    expect(readAsk("delete-everything")).toBeNull();
    expect(readAsk(null)).toBeNull();
  });
});

describe("due dates in words", () => {
  const now = new Date("2026-11-24T10:00:00");
  it("counts whole days from today", () => {
    expect(daysFromToday("2026-11-24", now)).toBe(0);
    expect(daysFromToday("2026-11-12", now)).toBe(-12);
    expect(daysFromToday(null, now)).toBeNull();
  });
  it("says overdue with the date and how long", () => {
    expect(dueWords("2026-11-12", now)).toEqual({ text: "Overdue since Nov 12 (12 days)", late: true, soon: false });
    expect(dueWords("2026-11-23", now)?.text).toBe("Overdue since Nov 23 (1 day)");
  });
  it("says when it is due ahead", () => {
    expect(dueWords("2026-11-24", now)?.text).toBe("Due today, Nov 24");
    expect(dueWords("2026-11-29", now)).toEqual({ text: "Due Nov 29 (in 5 days)", late: false, soon: true });
    expect(dueWords("2027-02-01", now)?.text).toBe("Due Feb 1, 2027 (in 69 days)");
  });
});
