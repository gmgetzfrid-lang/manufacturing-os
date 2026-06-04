# Turn on full-fidelity .mpp import (one-time, click-only)

After this, anyone can drop a Microsoft Project **.mpp** file and get
**everything** — dependencies, resources/contractors, custom columns, exact
dates — with no export step.

You only do this once. **No terminal/commands needed.** It takes ~10 minutes.

Why it's a separate step: reading a `.mpp` completely needs a tool (MPXJ) that
runs in Java, and the main app runs on Vercel (which can't run Java). So we run
a tiny helper online. The repo already contains it (`docker/mpxj-converter`)
and a one-click deploy config (`render.yaml`).

---

## Part 1 — Put the helper online (Render, free)

1. Go to **https://render.com** and **Sign up** with your **GitHub** account
   (free; no credit card for the free tier).
2. Click **New +** (top right) → **Blueprint**.
3. **Connect** your GitHub and pick the **manufacturing-os** repository.
4. Render reads `render.yaml` automatically and shows a service called
   **mpxj-converter**. Click **Apply** / **Create**.
5. Wait for the build to finish (a few minutes — it says **Live** when done).
6. Click the **mpxj-converter** service. Near the top you'll see its web
   address, like `https://mpxj-converter-xxxx.onrender.com` — **copy it.**
7. In that service, open the **Environment** tab. You'll see a value named
   **MPXJ_TOKEN** (Render generated a long random one). Click to reveal it and
   **copy that value too.** (It's just a password so only your app can use the
   helper.)

> Free tier note: the helper "sleeps" after 15 min idle, so the **first** .mpp
> import after a quiet period takes ~20 seconds to wake up. Every import after
> is instant. (If that ever bugs you, Render's $7/mo "Starter" plan keeps it
> always on — optional.)

---

## Part 2 — Tell the app where the helper is (Vercel)

1. Go to your project on **https://vercel.com** → **Settings** →
   **Environment Variables**.
2. Add two variables:

   | Name | Value |
   |------|-------|
   | `MPP_CONVERTER_URL` | the web address from Part 1 step 6 (make sure it ends with a `/`) |
   | `MPP_CONVERTER_TOKEN` | the **MPXJ_TOKEN** value you copied in Part 1 step 7 |

   > ⚠️ The names differ on purpose: Render calls it `MPXJ_TOKEN`, the app calls
   > it `MPP_CONVERTER_TOKEN`. **The *value* must be identical** — copy it
   > exactly.
3. Click **Save**, then redeploy the app (Vercel → **Deployments** → the latest
   one → **⋯** → **Redeploy**).

---

## Done

Drop a `.mpp` in the schedule importer. You'll now see the dependency lines,
the resource/contractor column, your custom columns, and exact dates — and the
"best-effort" warning disappears on its own because real data is coming back.

If a step doesn't look like the description (Render and Vercel tweak their UIs),
tell me what you see and I'll point you to the right button.
