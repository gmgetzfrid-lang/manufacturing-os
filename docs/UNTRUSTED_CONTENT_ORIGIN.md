# Serving contractor uploads from their own address (`UNTRUSTED_CONTENT_ORIGIN`)

**Who this is for:** the person who looks after the app's settings (on Vercel, or
wherever the app runs). No programming is needed. It takes about five minutes.

## What it does, in plain words

Files that contractors send through an intake link come from **outside** your
organization. The app already checks what every such file really is (only real
PDF, DWG, DXF, ZIP, and for redlines PNG / JPEG are accepted) and always hands
it out as a download rather than a web page.

This setting adds one more wall. When it is set, a contractor's file is handed
out from a **different web address** than the one your organization's
controlled drawings are handed out from — an address that belongs to the
storage service, where the app never puts its sign-in, its pages or its
scripts. Even a file that somehow slipped past the checks could then never run
next to the app or next to your controlled drawings.

One thing has to be confirmed once, after you set it, because nothing in the
app can check it ahead of time: some parts of the app fetch a contractor's
file from storage themselves, inside your browser, and storage must let them
do that from the new address too. Today that is the **Full ZIP** backup, which
is built inside your browser and fetches every file from storage itself. Once
the Intake tab switches over (see "When to do it"), the app's own document
viewer does the same every time someone opens a contractor drawing — in the
intake review, for example (its full-screen view and a marked-up download
fetch the file the same way). If storage does not allow it, the Full ZIP
misses those files and, after the switch-over, contractor drawings may fail to
display in the viewer. Step 5 of "How to check it worked" checks it, and it is
**required**: do not leave the setting in place unless step 5 passes.

## When to do it

Any time after the app version with `lib/untrustedContent.ts` is live. Today
the setting changes **only the links in the workspace data export** (Admin →
**Data export** → **Download JSON**, and the **Full ZIP**, which is built from
the same links). The everyday download links — the
**Intake** tab, the document viewer — keep coming from the usual address until
two small code changes land (`app/api/storage/download-url/route.ts` and
`app/api/storage/resolve/route.ts` start calling `signStorageGet`; recorded on
projects-tab `GAP-401`, owner: the integrator at the J16 / P6 merge). You can
set it before then, but only together with step 5 of "How to check it worked":
those links switch over on their own the day that change is deployed, and from
that day the app's viewer opens contractor files from the new address, which
works only if step 5 passed. If you set it early, run step 5 again after that
change is deployed, and open one contractor drawing from the **Intake** tab to
see it display.

## The steps

1. **Find your storage account ID.** It is the value already saved in the
   setting called `R2_ACCOUNT_ID` (Vercel: your project → **Settings →
   Environment Variables**, find `R2_ACCOUNT_ID`, click the eye icon to show
   it). You can also see it in the Cloudflare dashboard → **R2** → the right-hand
   panel says **Account ID**. It looks like a long string of letters and
   numbers, for example `3f9a1c…`.
2. **Write down the address.** It is exactly:

   `https://<your R2 account ID>.r2.cloudflarestorage.com`

   — replace `<your R2 account ID>` with the ID from step 1, copied exactly.
   Nothing after `.com`: no slash-and-folder, no bucket name, no port. This is
   the only address the app accepts here, because it is the one your storage
   answers on for the app's files; any other address is refused (see the last
   section).
3. **Add the setting.** Vercel: your project → **Settings → Environment
   Variables** → **Add New**:
   - **Key:** `UNTRUSTED_CONTENT_ORIGIN`
   - **Value:** the address from step 2
   - **Environments:** tick **Production** (and **Preview** if you use it)
   - **Save**.

   Self-hosted with Docker: add the line
   `UNTRUSTED_CONTENT_ORIGIN=https://<your R2 account ID>.r2.cloudflarestorage.com`
   to your `.env` file.
4. **Redeploy.** Vercel: **Deployments** → the newest deployment → **⋯** →
   **Redeploy**. (Docker: restart the app with the new `.env`.) The setting is
   read when the app starts.

You should not need to change anything in Cloudflare: the address in step 2 is
one your storage already answers on, with the same keys the app already holds.
The one thing that is not known in advance is whether storage lets a browser
fetch files from that address — for the **Full ZIP** backup today, and for the
app's document viewer once the Intake tab switches over. Step 5 below checks
it, and it is required.

## How to check it worked

Check it with the workspace export, the one place that uses the setting today:

1. Sign in to the app as an Admin and open **Admin → Data export**.
2. Click **Download JSON**. A file downloads.
3. Open that file in any text editor (Notepad, TextEdit) and search for
   `project-intake/` — that is how a contractor's file is named.
4. Next to it is a long link (`"presignedUrl"`). It should start with the
   address from step 2: your account ID, then `.r2.cloudflarestorage.com/`,
   then the bucket name. A file your organization uploaded itself (not through
   an intake link) still starts with `https://<bucket name>.<account ID>…` —
   that is expected.

If the contractor file's link still starts with `https://<bucket name>.…`, the
value was refused: the server log has one line starting with
`[untrustedContent]` that says why (see the last section).

5. **Check that the Full ZIP backup still gets contractor files (required).** Back on
   **Admin → Data export**, click **Download Full ZIP** and let it finish
   (allow several downloads if the browser asks). While it runs, the card
   shows how many files failed. When it is done, open the last zip part and
   then `backup-report.json` inside it: under `errors`, there should be **no**
   file whose name contains `project-intake/` or `project-costs/` followed by
   `quote-`. (Or open `files/orgs/…/project-intake/…` in the zip and see the
   contractor drawings there.)

   If those files are listed under `errors` (usually with a network error
   such as "Failed to fetch") while your organization's own files are in the
   zip, storage is not letting the browser read files from the new address.
   Undo the setting (next section) so the Full ZIP gets every file again —
   and so the app's viewer keeps opening contractor drawings once the Intake
   tab switches over — and pass the result on to whoever looks after the app
   (`GAP-401` records this check). Only opening a link from the JSON file
   directly in a browser tab does not depend on this check.

The **Intake** tab's own download links do not change yet (see "When to do
it"): a contractor file opened there still comes from the usual address, and
that is expected, not a sign the setting is broken. Once they do, open one
contractor drawing from the **Intake** tab in the app's viewer, and in its
full-screen view, and check that it displays; if it does not, undo the
setting.

## How to undo it

Delete the `UNTRUSTED_CONTENT_ORIGIN` setting (Vercel: **Settings → Environment
Variables** → the setting → **⋯** → **Remove**) and **Redeploy**. The app goes
straight back to handing contractor files out from the usual address. Nothing
is stored differently, so nothing needs cleaning up.

## If something is wrong with the value

The app checks the value when it hands out a link. It accepts **only** the
address from step 2, made from the app's own `R2_ACCOUNT_ID` setting. Anything
else — not `https://…`, anything after the address, the app's own address (or
an address under it), the address controlled drawings already use, a typo in
the account ID, another account's address, a custom domain, or any other
address — is ignored: the app keeps working exactly as before (contractor
files keep opening from the usual address) and writes one line to the server
log starting with `[untrustedContent]` saying what is wrong. If
`R2_ACCOUNT_ID` itself is not set, nothing can be checked, so the value is
ignored too.

Do **not** use a custom domain of your own here: storage does not accept signed
download links on custom domains, which is why the app refuses one.
