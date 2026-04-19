# Listing Collector — Safari Web Extension: Setup

This is the click-by-click guide to take the Safari Web Extension in `extension/`
from source → running on your iPhone for free (sideloaded with your own Apple ID).

You will end up with:

- An installable Safari extension on your iPhone **and** your Mac.
- A **"Sign in with Google"** flow — no more pasting Sheet IDs or Drive folder IDs into config.
- **Pickers** that list all your existing Google Sheets and Drive folders so you can choose the defaults.
- The same overlay / checkbox / enrichment UI the userscript had.

The flow has three parts:

1. One-time Google Cloud setup (OAuth client ID).
2. Convert the extension to an Xcode project.
3. Install on your Mac, then sideload to your iPhone.

---

## 0. Prerequisites

- A Mac running a recent macOS (Ventura 13.4+ recommended) with **Xcode** installed from the App Store.
- Your iPhone, a Lightning/USB-C cable, and the same Apple ID on both devices.
- A free Apple ID is fine (no $99 Developer Program required for this option).

---

## 1. Create a Google OAuth Client ID

1. Go to <https://console.cloud.google.com>. Sign in with the Google account whose Sheet/Drive you want to use.
2. Top-left project picker → **New Project** → name it e.g. **Listing Collector** → **Create**. Wait a few seconds, then click the toast to switch into the new project.
3. Left nav → **APIs & Services → Library**. Search and **Enable** these three:
   - **Google Sheets API**
   - **Google Drive API**
   - **(Optional) Google Picker API** (we don't need it but it's harmless).
4. Left nav → **APIs & Services → OAuth consent screen**.
   - User Type: **External** → Create.
   - App name: **Listing Collector**. User support email: your address. Developer contact: your address. Save.
   - **Scopes** step: click **Add or Remove Scopes** → filter by `drive` and `spreadsheets` → check
     - `.../auth/drive.file`
     - `.../auth/drive.metadata.readonly`
     - `.../auth/spreadsheets`
     - `.../auth/userinfo.email` and `.../auth/userinfo.profile` (these appear automatically when you select the first ones).
     Save.
   - **Test users** step: add your own Google email address. Save.
   - You can leave the app in *Testing* mode forever — it just means you (and any test users you add) can sign in without the "Google hasn't verified this app" warning never going away. You do NOT need to submit for verification.
5. Left nav → **APIs & Services → Credentials** → **+ Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: **Listing Collector extension**.
   - **Authorized redirect URIs** — you need to paste the extension's redirect URL here. You don't have it yet because the extension isn't installed. Leave this empty for now; we'll come back after step 3.
   - Click **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). Save it somewhere — we'll paste it into the extension settings later.

---

## 2. Convert the extension folder to an Xcode project

Apple ships a tool that takes a plain Web Extension folder and wraps it in the Xcode boilerplate Safari needs.

1. Open **Terminal** on your Mac.
2. `cd` into wherever you cloned this repo, then into the `extension/` folder:

   ```bash
   cd path/to/Userscript/extension
   ```

3. Run the converter:

   ```bash
   xcrun safari-web-extension-converter --project-location ../safari-app --app-name "Listing Collector" --bundle-identifier com.yourname.listingcollector --macos-only false --ios-only false --no-open .
   ```

   Replace `yourname` with your own reverse-domain style string — it only has to be unique to you (e.g. `com.jsmith.listingcollector`). The tool will:
   - Create a new Xcode project at `../safari-app/Listing Collector/` with:
     - A small macOS container app.
     - A small iOS container app.
     - Two extension targets that both reference the files in `extension/` by path, so when you edit `content.js`, `background.js`, etc., Xcode picks up the changes.

4. Open it in Xcode:

   ```bash
   open "../safari-app/Listing Collector/Listing Collector.xcodeproj"
   ```

---

## 3. Sign both targets with your free Apple ID

Xcode needs your Apple ID so it can sign the app it installs on your phone.

1. In Xcode's menu bar: **Xcode → Settings → Accounts** → **+** at the bottom-left → **Apple ID** → sign in with the same Apple ID that's on your iPhone. Close the Settings window.
2. In the left sidebar of Xcode, click the blue project root node (**Listing Collector**).
3. You'll see targets listed: **Listing Collector** (iOS), **Listing Collector (macOS)**, **Listing Collector Extension** (iOS), **Listing Collector Extension (macOS)**. For each of the four:
   - Click the target → **Signing & Capabilities** tab.
   - Check **Automatically manage signing**.
   - **Team**: pick your Apple ID entry (will say "Personal Team" for a free account).
   - If the Bundle Identifier is flagged as taken (it shouldn't be, with a unique `com.yourname.` prefix), tweak it — e.g. `com.yourname.listingcollector2`. Do the same prefix for every target.

---

## 4. Build & install on your Mac

1. In the top-left Xcode toolbar scheme selector, pick **Listing Collector (macOS) → My Mac**.
2. Press the ▶ Run button. A tiny app with a big button opens and says "Listing Collector's extension is currently off. You can turn it on in Safari Extensions preferences."
3. Open **Safari → Settings → Extensions** (⌘,). Enable **Listing Collector**. When prompted about websites, choose **Always Allow on Every Website** (or at minimum allow `etsy.com` and `ebay.com`).
4. Go to <https://www.etsy.com/search?q=lamp> or <https://www.ebay.com/sch/i.html?_nkw=lamp>. You should see the round blue **List** toggle bottom-right, exactly like the userscript.

## 5. Configure the extension (one-time)

1. Right-click the extension icon in Safari's toolbar (or if hidden: View → Customize Toolbar and drag it out) → **Preferences** or **Manage Extensions → Options**.
2. You're in the Settings page built into the extension. Three steps:

   **Step 1 — OAuth Client ID**
   - Copy the **Redirect URI** shown (it looks like `https://<random-id>.safari-web-extension.com/`). This is the Apple-issued address Safari uses for the auth callback.
   - In a second tab, go back to your Google Cloud **OAuth client** from Part 1, step 5. Click **Edit**, add that Redirect URI under **Authorized redirect URIs**, **Save**.
   - Back in the Settings page: paste the OAuth **Client ID** and click **Save**.

   **Step 2 — Sign in with Google**
   - Click **Sign in with Google**. Approve the consent screen.
   - The page now shows "Signed in as you@example.com".

   **Step 3 — Target Spreadsheet & Drive Folder**
   - Under **Spreadsheet**, the list of your existing Google Sheets appears. Click one to select it, or press **+ New sheet** to create one named whatever you want.
   - Under **Drive folder for images**, same thing. Pick an existing folder or create e.g. **Listing Images**.

3. Hit **Run test**. You should see `{ "status": "added", "tab": "eBay Search" }`. Check the sheet — there should be a row with a placeholder image.

Done on Mac. Onto iPhone.

---

## 6. Sideload to your iPhone

1. Plug your iPhone into the Mac with a cable. Unlock it. If it's the first time the Mac sees it, accept the "Trust this computer" prompt.
2. In Xcode's toolbar scheme selector, pick **Listing Collector (iOS) → [your iPhone name]**.
3. ▶ Run. Xcode will say "Build succeeded", copy the app to your phone, and launch a minimal container app there. You only need the app to exist; close it.
4. On the iPhone:
   - **Settings → Safari → Extensions → Listing Collector** → toggle it **On**.
   - Under "Allowed Websites", set **All Websites → Allow** (or at minimum Etsy and eBay → Allow).
5. Still on the iPhone, open **Settings → General → VPN & Device Management → [your Apple ID, under "Developer App"]** → **Trust**. This is the mandatory extra confirmation Apple asks for any app signed with a free Apple ID.
6. Open Safari on the iPhone. Visit <https://www.ebay.com/sch/i.html?_nkw=lamp>. You should see the floating **List** button appear.
7. Tap it → **Settings** link. Paste the same OAuth Client ID again (the settings page is per-device). Sign in. Pick the same Sheet and Folder. Run the test.

---

## 7. The 7-day re-signing dance (free Apple ID only)

A free-Apple-ID signed app expires **7 days** after it was built. When it does, the extension will stop appearing on your iPhone and you'll see "Unable to Verify App" if you open the container. To refresh:

1. Plug the iPhone into the Mac.
2. Open the Xcode project.
3. Pick **Listing Collector (iOS) → [iPhone]** again, and press ▶.

That's it. No code change needed, just a rebuild. On the Mac the same certificate also expires but in practice you'll rarely notice because you usually re-run it yourself while changing things.

If you don't want the weekly chore, upgrade to the $99/year Apple Developer Program (same Apple ID, different tier): the cert lasts a year. No code change.

---

## Common issues

- **"Unable to install / Untrusted Developer" on iPhone**: you skipped Part 6 step 5 (Settings → General → VPN & Device Management → Trust).
- **Extension is installed but the List button never appears**: Safari → Settings → Extensions → Listing Collector → Allowed Websites → set to **Allow** (or Always Allow). Then reload the Etsy/eBay page.
- **Sign-in window opens then closes immediately with "Not signed in."**: the Redirect URI in Google Cloud doesn't match the one in the Settings page exactly. Copy-paste it fresh, including the trailing `/`.
- **"Access blocked — This app is not verified"**: you're signed into a Google account that isn't on the Test Users list, OR you're using a Workspace account with strict admin policies. Add your email under OAuth consent screen → Test Users; or use a personal Gmail.
- **Save writes the row but the image cell shows a broken icon in the Sheet for ~60 seconds**: that's Google caching `=IMAGE()`. Normal. If it never loads, confirm the row's image URL starts with `https://drive.google.com/uc?export=view&id=...` and open it in your browser — you should see the image. If you don't, re-check that the folder isn't hidden under a restricted shared drive.
