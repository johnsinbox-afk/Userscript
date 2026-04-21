# Listing Collector — Safari Web Extension: Setup (Xcode 16.4)

Click-by-click guide to take the Safari Web Extension in `extension/` from
source → running on your Mac and your iPhone, signed with your free
Apple ID. Verified against **Xcode 16.4**.

You will end up with:

- An installable Safari extension on your iPhone **and** your Mac.
- A **"Sign in with Google"** flow — no more pasting Sheet IDs or Drive folder IDs into config.
- **Pickers** that list all your existing Google Sheets and Drive folders so you can choose the defaults.
- The same overlay / checkbox / enrichment / Facebook UI the userscript has, plus more.

Three parts: Google Cloud setup, Xcode project generation, iPhone sideload.

---

## 0. Prerequisites

- **macOS 14.5+** (Sonoma) or **macOS 15.x** (Sequoia). Xcode 16.4 requires this.
- **Xcode 16.4** already installed. Launch it once from Spotlight — the first launch asks you to accept the license and install additional tools. Let it finish.
- An **iPhone** on iOS 17 or iOS 18, with the same Apple ID signed in as your Mac.
- A Lightning/USB-C cable, or Wi-Fi debugging set up.
- A **free Apple ID** is fine — no $99 Developer Program required.

Open Terminal once and verify Xcode is the one being used:

```bash
xcode-select -p
# Expected:  /Applications/Xcode.app/Contents/Developer
```

If it says `/Library/Developer/CommandLineTools`, fix it:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

---

## 1. Create a Google OAuth Client ID

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com). Sign in with the Google account whose Sheet/Drive you want to use.
2. Top-left project picker → **New Project** → name it e.g. **Listing Collector** → **Create**. Wait a few seconds, click the toast to switch into the new project.
3. Left nav → **APIs & Services → Library**. Search and **Enable** these:
  - **Google Sheets API**
  - **Google Drive API**
4. Left nav → **APIs & Services → OAuth consent screen**.
  - User Type: **External** → Create.
  - App name: **Listing Collector**. User support email: yours. Developer contact: yours. **Save and continue**.
  - **Scopes** step: click **Add or Remove Scopes** → filter by `drive` and `spreadsheets` → check:
    - `.../auth/drive.file`
    - `.../auth/drive.metadata.readonly`
    - `.../auth/spreadsheets`
    - `.../auth/userinfo.email` and `.../auth/userinfo.profile` (show up automatically).
  - **Test users**: add your own Google email. **Save**.
  - Keep the app in *Testing* mode forever — means only you (and any test users you add) can sign in, but no review needed.
5. Left nav → **APIs & Services → Credentials** → **+ Create Credentials → OAuth client ID**.
  - Application type: **Web application**.
  - Name: **Listing Collector extension**.
  - **Authorized redirect URIs** — leave blank for now. We'll add the extension's redirect URI once we have it (end of Part 4).
  - Click **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). Save it — we'll paste it into the extension's Settings page later.

---

## 2. Generate the Xcode project from the `extension/` folder

Apple ships a tool that wraps a plain Web Extension folder in the Xcode boilerplate Safari needs.

1. Open **Terminal** on your Mac.
2. `cd` into this repo, then into `extension/`:
  ```bash
   cd path/to/Userscript/extension
  ```
3. Run the converter. Replace `jsmith` with anything unique to you (reverse-domain style). Xcode 16.4 uses the same flag names:
  ```bash
   xcrun safari-web-extension-converter . \
       --project-location ../safari-app \
       --app-name "Listing Collector" \
       --bundle-identifier com.jsmith.listingcollector \
       --copy-resources \
       --no-open
  ```
   Flag notes:
  - The **folder argument (`.`)** goes last — it's the path to the Web Extension source.
  - `**--copy-resources`** duplicates `manifest.json`, `content.js`, etc. into the Xcode project. Recommended: Xcode can edit and rebuild without touching your source tree. Omit it if you'd rather have the project reference the live files (useful during rapid iteration, but easy to accidentally delete from Xcode).
  - `--no-open` suppresses the auto-launch of Xcode so we can verify things first.
  - **Do not pass** `--macos-only false` or `--ios-only false` — those are toggles, not booleans. Passing them at all *enables* the restriction. Omit both to get both iOS and macOS targets (what we want).
4. Open the project:
  ```bash
   open "../safari-app/Listing Collector/Listing Collector.xcodeproj"
  ```

---

## 3. Sign every target with your free Apple ID

Xcode 16.4 menu paths:

1. **Xcode → Settings…** (`⌘,`) → **Accounts** → **+** (bottom-left) → **Apple ID** → sign in with the Apple ID that's on your iPhone. Close Settings.
2. In the left sidebar click the blue project root icon (**Listing Collector**). The central pane splits into Targets on the left and editor tabs at the top.
3. You'll see four targets:
  - **Listing Collector** (macOS container app)
  - **Listing Collector (iOS)** (iOS container app)
  - **Listing Collector Extension** (macOS extension)
  - **Listing Collector Extension (iOS)** (iOS extension)
   Xcode 16.4 sometimes names these **"Listing Collector"** + **"Listing Collector (iOS)"** + **"Listing Collector Extension"** + **"Listing Collector Extension (iOS)"** — exact names depend on the converter. Either way, you need to do the signing dance for **all four**:
  - Click the target.
  - Open the **Signing & Capabilities** tab (top of the editor pane).
  - Check **Automatically manage signing**.
  - **Team**: pick your Apple ID entry (it'll say "(Personal Team)" for a free account).
  - **Bundle Identifier**: should already have the `com.jsmith.listingcollector…` prefix you passed to the converter. If Xcode complains "Bundle Identifier is not available", append something to make it unique — e.g. `com.jsmith.listingcollector.v2`. Keep the same prefix across the four targets; only the suffix differs.
4. Xcode will show a red **"Automatic signing failed"** box the first time on each target — that's normal on a brand-new Personal Team. Wait a few seconds, the banner resolves itself once Apple issues the cert. If it sticks, click the "Try Again" link inside the banner.

---

## 4. Build & install on your Mac first (so we can fetch the redirect URI)

1. **Scheme selector** (top-left of the Xcode toolbar, next to the play button). Click the left half and pick **Listing Collector** (the macOS app, *not* "Extension"). Click the right half and pick **My Mac**.
2. Press ▶ Run. Xcode builds (~60 seconds the first time) and launches a small window with the message "Listing Collector's extension is currently off. You can turn it on in Safari Extensions preferences."
3. Open **Safari → Settings → Extensions** (`⌘,`). Enable **Listing Collector**. For **Allowed Websites**, choose either **Always Allow on Every Website** or at minimum allow `etsy.com`, `ebay.com`, and `facebook.com`.
4. Open a test page — e.g. [https://www.ebay.com/sch/i.html?_nkw=lamp](https://www.ebay.com/sch/i.html?_nkw=lamp). You should see the round blue **List** toggle bottom-right.

### Configure the extension

1. In Safari's toolbar click the small grey puzzle-piece, find **Listing Collector**, right-click → **Manage Extensions…** → on the extension's row click the **"</>"** or **Options** button; or simply visit `safari-web-extension://<generated-id>/ui/options.html` if Safari shows that URL.
  Easier path: click the **List** button on any Etsy/eBay page to open the overlay panel, then tap **Open settings** in its header — it takes you straight to the options page.
2. **Step 1 — OAuth Client ID**
  - The page shows **Redirect URI: `https://abcdef…safari-web-extension.com/`** — a URL Apple generated for this install of the extension.
  - Click **Copy**.
  - In your Google Cloud browser tab, go back to **APIs & Services → Credentials → [your OAuth client] → Edit**. Paste the URI under **Authorized redirect URIs**. **Save**. (It can take a minute to propagate.)
  - Back in the Settings page, paste your **Client ID** into the big text box and click **Save**.
3. **Step 2 — Sign in with Google**
  - Click **Sign in with Google**. Safari opens Google's consent screen. Click **Continue** past the "Google hasn't verified this app" warning (expected for Testing-mode apps). Approve.
  - The page refreshes and shows **"Signed in as [you@example.com](mailto:you@example.com)"**.
4. **Step 3 — Target Spreadsheet & Drive Folder**
  - Your existing Google Sheets appear in the list. Click one, or press **+ New sheet** and give it a name.
  - Same for **Drive folder for images**. Pick an existing one, or create **Listing Images**.
5. **Step 4 — Test**
  - Click **Run test**. You should see `{ "status": "added", "tab": "eBay Search" }` within a few seconds.
  - Open your Sheet. There should be a dummy row with a placeholder image rendered inline.

If the test works on Mac, the iPhone half is just copying the same config across.

---

## 5. Sideload to your iPhone

1. Plug iPhone in. Unlock it. If it's the first time your Mac sees this phone, accept "Trust this computer" on the phone.
2. In Xcode 16.4, **Window → Devices and Simulators** → pick your iPhone on the left → it should appear under "Connected". If it says "Preparing…", wait until done. If it says "iOS x.y is not supported by this version of Xcode", you need the matching iOS support bundle — Xcode 16.4 ships support for iOS 17 and iOS 18; older iOS needs an older Xcode.
3. Close Devices and Simulators.
4. **Scheme selector** → pick **Listing Collector (iOS)** + **[your iPhone name]** on the right.
5. ▶ Run. Xcode builds, copies the app, and launches a minimal container app on the phone. You can close that app — it exists only so the extension can live on the device.

### On the iPhone

1. **Settings → Safari → Extensions** → **Listing Collector** → toggle **On**.
2. Under **Allowed Websites**, set **All Websites → Allow** (or specifically allow Etsy, eBay, Facebook).
3. **Settings → General → VPN & Device Management** → under *Developer App* tap your Apple ID → **Trust**. (Only asked once per Apple ID on that phone.)
4. Open Safari. Visit [https://www.ebay.com/sch/i.html?_nkw=lamp](https://www.ebay.com/sch/i.html?_nkw=lamp) or [https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&view_all_page_id=](https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&view_all_page_id=). The **List** toggle should appear bottom-right.
5. Tap it → **Open settings** in the panel header.
  - The Redirect URI is **the same** as on Mac (`https://<id>.safari-web-extension.com/`). Apple uses the same per-extension ID across Macs and iPhones that share your Apple ID's developer team, so **you do NOT need to add a second redirect URI to Google Cloud**.
  - Paste the same **Client ID**. Click **Sign in with Google**. Pick the same **Sheet** and **Folder** (they're stored per-device for now).

If anything misbehaves here, say so and paste the exact error text.

---

## 6. The 7-day re-sign dance (free Apple ID only)

Apps signed with a free Apple ID expire **7 days** after build. When that happens, the extension will stop working on your iPhone and you'll see "Unable to Verify App" if you tap the container app. To refresh:

1. Plug iPhone in.
2. Open the Xcode project.
3. Scheme selector → **Listing Collector (iOS)** + **[iPhone]** → ▶. No code changes needed.

On Mac, the cert also expires but since you usually rebuild the Mac target on your own timetable you'll rarely notice.

If the weekly rebuild becomes annoying: **$99/year Apple Developer Program** upgrades the Personal Team to a full team, which issues year-long certs. Same Apple ID, no code change, no Google Cloud change — everything that worked on the free plan keeps working for a year.

---

## Common issues specific to Xcode 16.4

- **"Sandbox: xcode-select denied operation"** → you still have the old Command Line Tools path active. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- **"The bundle identifier is already taken"** during signing → append a suffix (e.g. `.v2`) to all four targets' bundle IDs; keep the prefix identical.
- **"Automatic signing failed – No profiles for 'com.jsmith.listingcollector' were found"** → usually resolves itself within ~30 s on a new Personal Team. If not, click the "Try Again" button in the banner.
- **Safari on Mac never shows the extension after ▶** → in Safari: Settings → Extensions → click on **Listing Collector** in the left list → toggle **On**. If it's not in the list at all, run the macOS scheme again and confirm the build succeeded.
- **iPhone build error: "Could not locate device support files"** → the phone is on a newer iOS than Xcode 16.4 supports (iOS 19 beta, etc.). Either downgrade the phone's iOS or upgrade to the next Xcode.
- **"This app is not available in your country" when signing in to Google** → you're on a Google Workspace account where the admin has blocked unverified apps. Use a personal Gmail, or ask the admin to allowlist your OAuth client ID.
- `**=IMAGE()` shows a broken thumbnail in the Sheet for ~60 s after saving** → that's Google caching. Normal. If it never loads, click the cell and confirm the URL starts with `https://drive.google.com/uc?export=view&id=`; open that URL in a browser. If it errors, the folder is on a Shared Drive with restricted sharing — move it to My Drive or change the folder's sharing to Anyone with the link.

---

## What to do when you update the extension source

If you ran the converter with `--copy-resources`, Xcode has its own copies of the extension files. To sync your changes:

1. Edit the files in `extension/`.
2. In Xcode, find the `Shared (Extension)` or `Resources` group in the left sidebar and **delete references** to the outdated files (choose "Remove Reference" not "Move to Trash").
3. Drag the updated files from Finder into the Xcode group. Tick "Copy items if needed".
4. ▶ Run again.

If you ran without `--copy-resources`, Xcode already references your repo files directly — just ▶ Run after editing.