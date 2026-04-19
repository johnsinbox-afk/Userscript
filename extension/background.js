/*  Listing Collector — background service worker.
 *
 *  Responsibilities:
 *    • OAuth 2.0 sign-in with Google (launchWebAuthFlow).
 *    • Background cross-origin fetch (content script can't do that from
 *      the Etsy/eBay origin on its own without host permissions on each,
 *      but we declared them, so technically content could; we still
 *      proxy here so everything goes through one place).
 *    • Save flow: upload image to Drive, append row to the user's Sheet
 *      with =IMAGE(driveUrl), dedupe by listing URL, create per-mode
 *      tabs on first use.
 *    • Expose a tiny RPC surface for the options page (pick spreadsheet,
 *      pick folder, test, sign-out).
 */

// ── Cross-browser shim ───────────────────────────────────────────────
const api = (typeof browser !== 'undefined' ? browser : chrome);

// ── Schema: one entry per mode, defines the tab name + ordered columns.
//   __image is the special column that holds =IMAGE(driveUrl).
const SCHEMA = {
    'etsy-search': {
        tab: 'Etsy',
        cols: [
            ['Captured','capturedAt'], ['Site','site'], ['Seller','seller'], ['Owner','owner'],
            ['Account Age','accountAge'], ['Shop Sales','shopSales'], ['Shop Rating','shopRating'],
            ['Reviews','shopReviews'], ['Admirers','shopAdmirers'], ['Shop Location','shopLocation'],
            ['Listing #','itemNumber'], ['Title','title'], ['URL','url'], ['Price','price'],
            ['Favorites','favorites'], ['Tags','tags'], ['Materials','materials'],
            ['Ships From','country'], ['Image','__image']
        ]
    },
    'ebay-search': {
        tab: 'eBay Search',
        cols: [
            ['Captured','capturedAt'], ['Site','site'], ['Seller','seller'],
            ['Feedback','sellerFeedbackScore'], ['Positive %','sellerPositivePct'],
            ['Item #','itemNumber'], ['Title','title'], ['URL','url'], ['Price','price'],
            ['Available','available'], ['Sold','sold'], ['Condition','condition'],
            ['Handling','handlingTime'], ['Returns','returns'],
            ['Ships From','country'], ['Image','__image']
        ]
    },
    'ebay-store': {
        tab: 'eBay Store',
        cols: [
            ['Captured','capturedAt'], ['Site','site'], ['Seller','seller'],
            ['Item #','itemNumber'], ['Title','title'], ['URL','url'], ['Price','price'],
            ['Available','available'], ['Sold','sold'], ['Condition','condition'],
            ['Image','__image']
        ]
    },
    'ebay-research': {
        tab: 'eBay Research',
        cols: [
            ['Captured','capturedAt'], ['Site','site'], ['Seller','seller'],
            ['Item #','itemNumber'], ['Title','title'], ['URL','url'],
            ['Avg Price','avgPrice'], ['Avg Shipping','avgShipping'],
            ['Total Sold','totalSold'], ['Sales','sales'], ['Last Sold','lastSold'],
            ['Condition','condition'], ['Feedback','sellerFeedbackScore'],
            ['Positive %','sellerPositivePct'], ['Image','__image']
        ]
    }
};

// ── OAuth ────────────────────────────────────────────────────────────
const OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/spreadsheets'
].join(' ');

function getClientId() {
    // Stored client id takes precedence so the user can override without
    // rebuilding the extension. Falls back to manifest's oauth2.client_id.
    return new Promise(resolve => {
        api.storage.local.get(['oauthClientId'], v => {
            if (v && v.oauthClientId) return resolve(v.oauthClientId);
            try {
                const cid = (api.runtime.getManifest().oauth2 || {}).client_id || '';
                resolve(cid);
            } catch (e) { resolve(''); }
        });
    });
}
function redirectUri() {
    // launchWebAuthFlow redirects back to a per-extension URL under the
    // browser's redirect domain; works identically in Safari Web
    // Extensions, Chrome, Firefox (with manifest v3) and Edge.
    try { return api.identity.getRedirectURL(); } catch (e) { return ''; }
}

function startSignIn() {
    return new Promise(async (resolve, reject) => {
        const clientId = await getClientId();
        if (!clientId || clientId.startsWith('YOUR_OAUTH')) {
            return reject(new Error('OAuth client ID is not configured. Open Settings → paste your Google OAuth client ID.'));
        }
        const url = 'https://accounts.google.com/o/oauth2/v2/auth' +
            '?client_id=' + encodeURIComponent(clientId) +
            '&redirect_uri=' + encodeURIComponent(redirectUri()) +
            '&response_type=token' +
            '&scope=' + encodeURIComponent(OAUTH_SCOPES) +
            '&include_granted_scopes=true' +
            '&prompt=consent';
        api.identity.launchWebAuthFlow({ url, interactive: true }, redirected => {
            if (api.runtime.lastError || !redirected) {
                return reject(new Error((api.runtime.lastError && api.runtime.lastError.message) || 'Sign-in cancelled.'));
            }
            const m = /[#&?]access_token=([^&]+)/.exec(redirected);
            const exp = /[#&?]expires_in=(\d+)/.exec(redirected);
            if (!m) return reject(new Error('No access token in redirect.'));
            const token = decodeURIComponent(m[1]);
            const expiresAt = Date.now() + ((exp ? parseInt(exp[1], 10) : 3600) - 60) * 1000;
            api.storage.local.set({ token, expiresAt, signedIn: true }, async () => {
                const who = await fetchMe(token).catch(() => null);
                if (who) api.storage.local.set({ user: who });
                resolve({ token, user: who });
            });
        });
    });
}
function signOut() {
    return new Promise(resolve => {
        api.storage.local.remove(['token', 'expiresAt', 'signedIn', 'user'], () => resolve(true));
    });
}
function getToken(interactiveIfMissing) {
    return new Promise(async (resolve, reject) => {
        api.storage.local.get(['token', 'expiresAt'], async v => {
            if (v.token && v.expiresAt && Date.now() < v.expiresAt) return resolve(v.token);
            if (!interactiveIfMissing) return reject(new Error('Not signed in.'));
            try { const r = await startSignIn(); resolve(r.token); }
            catch (e) { reject(e); }
        });
    });
}
async function fetchMe(token) {
    try {
        const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

// ── Google API helpers ───────────────────────────────────────────────
async function gapi(url, opts = {}, retry = true) {
    const token = await getToken(false).catch(() => null);
    if (!token) throw new Error('Not signed in. Open the Listing Collector options and press Sign in.');
    const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (resp.status === 401 && retry) {
        await signOut();
        const r = await startSignIn();
        return gapi(url, opts, false);
    }
    if (!resp.ok) {
        let body = ''; try { body = await resp.text(); } catch (e) {}
        throw new Error('API ' + resp.status + ': ' + body.slice(0, 200));
    }
    const ct = resp.headers.get('content-type') || '';
    return ct.includes('application/json') ? resp.json() : resp.text();
}
async function listSpreadsheets(pageToken) {
    const q = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    let url = 'https://www.googleapis.com/drive/v3/files' +
        '?q=' + q +
        '&fields=files(id,name,modifiedTime),nextPageToken' +
        '&orderBy=modifiedTime desc&pageSize=100';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    return gapi(url);
}
async function listFolders(parent, pageToken) {
    const parentQ = parent ? `'${parent}' in parents and ` : '';
    const q = encodeURIComponent(parentQ + "mimeType='application/vnd.google-apps.folder' and trashed=false");
    let url = 'https://www.googleapis.com/drive/v3/files' +
        '?q=' + q +
        '&fields=files(id,name,parents),nextPageToken' +
        '&orderBy=name&pageSize=200';
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    return gapi(url);
}
async function createSpreadsheet(title) {
    return gapi('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { title } })
    });
}
async function createFolder(name, parentId) {
    return gapi('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentId ? [parentId] : undefined
        })
    });
}
async function getSpreadsheetMeta(sheetId) {
    return gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(sheetId,title,index,gridProperties))`);
}
async function ensureTab(sheetId, tabName, headers) {
    const meta = await getSpreadsheetMeta(sheetId);
    const found = (meta.sheets || []).find(s => s.properties && s.properties.title === tabName);
    if (found) return found.properties;
    // Create it.
    const resp = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
    });
    const props = resp.replies[0].addSheet.properties;
    // Write headers and freeze row 1.
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=USER_ENTERED`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [headers] })
    });
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [{
                updateSheetProperties: {
                    properties: { sheetId: props.sheetId, gridProperties: { frozenRowCount: 1 } },
                    fields: 'gridProperties.frozenRowCount'
                }
            }]
        })
    });
    return props;
}
async function readExistingUrls(sheetId, tabName, urlColIdx /* 0-based */) {
    const col = String.fromCharCode(65 + urlColIdx); // A..Z. Schemas stay well under 26 columns.
    const range = `${tabName}!${col}2:${col}`;
    const resp = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`);
    return (resp.values || []).map(r => r[0]).filter(Boolean);
}
async function appendRow(sheetId, tabName, values) {
    return gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [values] })
    });
}
async function setRowHeight(sheetId, tabTitle, rowIndex0Based, pixels) {
    try {
        const meta = await getSpreadsheetMeta(sheetId);
        const s = (meta.sheets || []).find(s => s.properties && s.properties.title === tabTitle);
        if (!s) return;
        await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [{
                    updateDimensionProperties: {
                        range: { sheetId: s.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex0Based, endIndex: rowIndex0Based + 1 },
                        properties: { pixelSize: pixels }, fields: 'pixelSize'
                    }
                }]
            })
        });
    } catch (e) { /* best-effort */ }
}

// Upload an image from a remote URL into a Drive folder and return a
// publicly viewable =IMAGE()-friendly link.
async function uploadImageToDrive(imgUrl, folderId, fileName) {
    if (!imgUrl || !folderId) return '';
    let blob;
    try {
        const r = await fetch(imgUrl, { credentials: 'omit' });
        if (!r.ok) return imgUrl; // fall back to the source
        blob = await r.blob();
    } catch (e) { return imgUrl; }
    const token = await getToken(false);
    const meta = { name: fileName, parents: [folderId] };
    const boundary = '-------bnd' + Math.random().toString(36).slice(2);
    const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`
    ]);
    const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webContentLink', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body
    });
    if (!up.ok) return imgUrl;
    const file = await up.json();
    // Make publicly viewable so =IMAGE() renders.
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
    return `https://drive.google.com/uc?export=view&id=${file.id}`;
}

function safeFileName(listing) {
    const base = (listing.site || 'listing') + '_' + (listing.itemNumber || listing.title || 'item');
    return base.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
}

async function saveListing(msg) {
    // Look up saved target.
    const cfg = await new Promise(r => api.storage.local.get(['sheet', 'folder'], r));
    if (!cfg.sheet || !cfg.sheet.id || !cfg.folder || !cfg.folder.id) {
        return { status: 'error', message: 'No target sheet or folder set. Open the extension settings and pick them.' };
    }
    const schema = SCHEMA[msg.mode] || SCHEMA['ebay-search'];
    const headers = schema.cols.map(c => c[0]);
    const tabName = schema.tab;
    try {
        await ensureTab(cfg.sheet.id, tabName, headers);
    } catch (e) {
        return { status: 'error', message: 'Ensure tab failed: ' + e.message };
    }

    // Dedupe by URL.
    const urlIdx = schema.cols.findIndex(c => c[1] === 'url');
    if (urlIdx >= 0 && msg.listing.url) {
        try {
            const existing = await readExistingUrls(cfg.sheet.id, tabName, urlIdx);
            if (existing.indexOf(msg.listing.url) !== -1) return { status: 'duplicate' };
        } catch (e) { /* if the read fails, we still try to append */ }
    }

    // Upload image.
    let imageFormula = '';
    if (msg.listing.image) {
        try {
            const ext = guessExt(msg.listing.image);
            const driveUrl = await uploadImageToDrive(msg.listing.image, cfg.folder.id, safeFileName(msg.listing) + ext);
            if (driveUrl) imageFormula = `=IMAGE("${driveUrl.replace(/"/g, '""')}")`;
        } catch (e) { /* leave blank */ }
    }

    // Build row in schema order.
    const nowIso = new Date().toISOString();
    const L = Object.assign({}, msg.listing, {
        capturedAt: msg.listing.capturedAt || nowIso,
        site:       msg.site || msg.listing.site || ''
    });
    const row = schema.cols.map(([, k]) => k === '__image' ? imageFormula : (L[k] == null ? '' : L[k]));

    try {
        await appendRow(cfg.sheet.id, tabName, row);
        // Best-effort: bump the row's height so the inline image has room.
        try {
            const meta = await getSpreadsheetMeta(cfg.sheet.id);
            const tab = (meta.sheets || []).find(s => s.properties && s.properties.title === tabName);
            if (tab) {
                // Last row is lastRow; fetch approximate row count via values API would need another call.
                // Instead use batchUpdate to set height for the newest row which is at the bottom.
                const values = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${cfg.sheet.id}/values/${encodeURIComponent(tabName)}!A:A`);
                const lastRow0 = (values.values ? values.values.length : 1) - 1;
                if (lastRow0 > 0) await setRowHeight(cfg.sheet.id, tabName, lastRow0, 120);
            }
        } catch (e) {}
        return { status: 'added', tab: tabName };
    } catch (e) {
        return { status: 'error', message: e.message || String(e) };
    }
}
function guessExt(u) {
    const m = /\.(jpe?g|png|gif|webp)(?:\?|$)/i.exec(u || '');
    return m ? '.' + m[1].toLowerCase() : '.jpg';
}

// ── RPC ──────────────────────────────────────────────────────────────
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (!msg || !msg.type) return sendResponse({ ok: false, message: 'No type' });
            switch (msg.type) {
                case 'fetch': {
                    try {
                        const r = await fetch(msg.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
                        const text = await r.text();
                        sendResponse({ ok: r.ok, status: r.status, text });
                    } catch (e) {
                        sendResponse({ ok: false, message: e.message || String(e) });
                    }
                    return;
                }
                case 'sign-in': {
                    const r = await startSignIn();
                    sendResponse({ ok: true, user: r.user });
                    return;
                }
                case 'sign-out': {
                    await signOut();
                    sendResponse({ ok: true });
                    return;
                }
                case 'whoami': {
                    api.storage.local.get(['user', 'signedIn', 'sheet', 'folder'], v => sendResponse({ ok: true, ...v }));
                    return true;
                }
                case 'list-spreadsheets': {
                    const r = await listSpreadsheets(msg.pageToken);
                    sendResponse({ ok: true, ...r });
                    return;
                }
                case 'list-folders': {
                    const r = await listFolders(msg.parent || '', msg.pageToken);
                    sendResponse({ ok: true, ...r });
                    return;
                }
                case 'create-spreadsheet': {
                    const r = await createSpreadsheet(msg.title || 'Listing Collector');
                    sendResponse({ ok: true, spreadsheet: r });
                    return;
                }
                case 'create-folder': {
                    const r = await createFolder(msg.name || 'Listing Images', msg.parent);
                    sendResponse({ ok: true, folder: r });
                    return;
                }
                case 'set-target': {
                    api.storage.local.set({ sheet: msg.sheet, folder: msg.folder }, () => sendResponse({ ok: true }));
                    return true;
                }
                case 'set-client-id': {
                    api.storage.local.set({ oauthClientId: msg.clientId || '' }, () => sendResponse({ ok: true }));
                    return true;
                }
                case 'save-listing': {
                    const out = await saveListing(msg);
                    sendResponse(out);
                    return;
                }
                case 'open-options': {
                    api.runtime.openOptionsPage(); sendResponse({ ok: true });
                    return;
                }
                case 'redirect-uri': {
                    sendResponse({ ok: true, uri: redirectUri() });
                    return;
                }
                default:
                    sendResponse({ ok: false, message: 'Unknown type: ' + msg.type });
            }
        } catch (e) {
            sendResponse({ ok: false, message: e.message || String(e) });
        }
    })();
    return true; // async
});
