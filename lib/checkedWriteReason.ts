// lib/checkedWriteReason.ts — why a follow-on write did not land, for a
// sentence whose lead-in already says what DID land (projects-tab SAF-22,
// J15e; DEC-90's J15 lesson: never "nothing was changed" after a write that
// landed).
//
// checkedWrite's own `error` is a whole sentence that ends "nothing was
// changed" — right for a write that is the person's whole act, wrong after
// "The folder was created, but …". `notLandedReason` gives the reason alone:
// the database's error in plain words (lib/userFacingError's embedded form),
// or, for a write that matched no row, the two causes PostgREST cannot tell
// apart.
//
//   const kept = keptAnswer();
//   const w = await checkedWrite(answered(supabase.from("t").update(p).eq("id", id).select("id"), kept));
//   if (!w.ok) setError(`The folder was created, but its permissions could not be applied: ${notLandedReason(kept, "folder index")}`);

import type { KeptAnswer } from "@/lib/checkedWriteAnswer";
import { userFacingError } from "@/lib/userFacingError";

export const NOT_MATCHED_REASON = "You may not have permission to do this, or someone else changed it first. Reload and try again.";

export function notLandedReason(kept: Pick<KeptAnswer, "error">, context: string): string {
  return kept.error ? userFacingError(kept.error, { embed: true, context }) : NOT_MATCHED_REASON;
}
