# PourScout browser extension (RadioWorkflow + Meta ad detection)

Two things from inside a PourScout lead, without switching tabs:
- **RadioWorkflow lookup** — the account's **owner** (which rep has it),
  **prospect/client status**, and contact.
- **Meta ad detection** — checks the **Meta Ad Library** for active ads and
  auto-sets the lead's "Running ads" flag (which boosts campaign-fit scores).

Both run in *your* browser using *your* session/IP, so there's no CORS,
Cloudflare, or bot-block problem, and no cookies are ever stored on a server.

> **Reinstall after updating:** v1.1 adds the `facebook.com` permission. After
> pulling, remove the old temporary add-on and load it again so the new
> permission takes effect. The Meta detection is best-effort — Meta's Ad Library
> is an unofficial endpoint, so if it ever stops returning a count, the manual
> "Running ads?" toggle on the lead still works.

## How it works
- A content script is injected only on `pourscout.com` (and `localhost` for dev).
- When you click **RadioWorkflow** on a lead, PourScout asks the extension to run
  the lookup; the background worker fetches
  `radioworkflow.com/app/listeners/lookup_accounts.php` with your session cookies
  and returns the matching accounts.
- You must be **logged into RadioWorkflow in the same browser** for it to work.

## Install — Firefox (you're on Firefox)
Temporary (clears on restart — fine for testing):
1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `extension/manifest.json`.

Permanent: the add-on must be signed by Mozilla (`web-ext sign`, or submit to AMO
as an unlisted add-on) and installed from the signed `.xpi`. Ask if you want this
packaged.

## Install — Chrome / Edge
1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.

## Using it
1. Open RadioWorkflow in any tab and sign in.
2. In PourScout, open a lead and click **RadioWorkflow** (next to the Research links).
3. If you see "extension not detected," reload the PourScout tab after installing.
   If you see "not logged in," sign into RadioWorkflow and retry.

## Files
- `manifest.json` — MV3 manifest (host permission for radioworkflow.com).
- `background.js` — performs the lookup + normalizes the response.
- `content.js` — bridges window messages between PourScout and the background worker.
