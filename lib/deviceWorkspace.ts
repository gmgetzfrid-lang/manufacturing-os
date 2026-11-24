// The workspace this device last signed in to, by NAME, for the sign-in
// page's title block ("Workspace: Kern Energy"). Written when a sign-in
// picks a membership; only ever shown on this device.
export const ORG_NAME_KEY = "manufacturingos.orgName";

export function rememberWorkspaceName(name: string | null | undefined): void {
  try { if (name) localStorage.setItem(ORG_NAME_KEY, name); } catch { /* private window */ }
}
