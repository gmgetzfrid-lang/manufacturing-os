import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { MATERIALS_TABLE_SQL, sqlEditorUrl, supabaseProjectRef } from "@/lib/setupSql";

const statements = (sql: string) => sql.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).map((l) => l.trimEnd()).join("\n");

describe("the SQL a screen hands over", () => {
  it("is the migration file, word for word, without its comments", () => {
    const file = readFileSync(join(process.cwd(), "supabase/migrations/20261119_project_materials.sql"), "utf8");
    expect(MATERIALS_TABLE_SQL.trim()).toBe(statements(file).trim());
    expect(MATERIALS_TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS project_materials");
  });
  it("opens the SQL Editor of the project the app uses", () => {
    expect(supabaseProjectRef("https://cmntbaftnnhrqzzicpiu.supabase.co")).toBe("cmntbaftnnhrqzzicpiu");
    expect(supabaseProjectRef("not a url")).toBe(null);
    expect(sqlEditorUrl("abc")).toBe("https://supabase.com/dashboard/project/abc/sql/new");
  });
});
