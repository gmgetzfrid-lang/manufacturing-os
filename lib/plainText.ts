// plainText - a person's text as typed, without the list marks a paste from
// a document brings along ("o\t", "•", "1."), one line each.

export const plainText = (t: string) => t.split("\n").map((l) => l.replace(/^\s*(?:[o•▪◦*-]|\d+[.)])\s+/, "").trim()).filter(Boolean).join("\n");
