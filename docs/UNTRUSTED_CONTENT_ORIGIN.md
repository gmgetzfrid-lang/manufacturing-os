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

Nothing else changes: people open and download contractor files exactly as
before; only the address in the browser's download bar is different.

## When to do it

**Only after** the app version that reads this setting through the download
links is live. The setting is read by `lib/untrustedContent.ts`. The workspace
data export (`lib/dataExport.ts`, the per-file links in an Admin's export)
already uses it. The two places that hand out everyday download links —
`app/api/storage/download-url/route.ts` and
`app/api/storage/resolve/route.ts` — start using it once they call
`signStorageGet` (handed over on projects-tab `GAP-401`). Until then the
setting changes only the export's links. Ask whoever deploys the app, or check
the release notes, before you start.

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

You do **not** need to change anything in Cloudflare: the address in step 2 is
one your storage already answers on, with the same keys the app already holds.

## How to check it worked

1. Sign in to the app as someone who can see a project's **Intake** tab.
2. Open a project that has a contractor submission, and open or download that
   file.
3. It should open or download exactly as before.
4. Optional: right-click the download and copy its link. It should start with
   the address from step 2 (your account ID, then `.r2.cloudflarestorage.com/`,
   then the bucket name). A file your organization uploaded itself (not through
   an intake link) still starts with `https://<bucket name>.<account ID>…` —
   that is expected.

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
