/*  Options page logic. */
const api = (typeof browser !== 'undefined' ? browser : chrome);

function rpc(msg) {
    return new Promise(resolve => {
        api.runtime.sendMessage(msg, reply => resolve(reply || { ok: false, message: 'No reply' }));
    });
}

const $ = sel => document.querySelector(sel);
function setText(sel, t) { const el = $(sel); if (el) el.textContent = t; }

async function init() {
    // Try to discover the extension's redirect URI from multiple sources —
    // Safari is inconsistent about which one works:
    //   1. api.identity.getRedirectURL() called from the options page itself
    //   2. the background worker's redirect-uri RPC (what we did before)
    //   3. fallback: derive from location.origin (works in Safari Web
    //      Extensions, where options pages live on safari-web-extension://…)
    let redirectUri = '';
    try {
        if (api.identity && typeof api.identity.getRedirectURL === 'function') {
            redirectUri = api.identity.getRedirectURL() || '';
        }
    } catch (e) {}
    if (!redirectUri) {
        const rpcResp = await rpc({ type: 'redirect-uri' });
        if (rpcResp && rpcResp.uri) redirectUri = rpcResp.uri;
    }
    if (!redirectUri && location.origin && /^safari-web-extension:\/\//i.test(location.origin)) {
        // Safari exposes the extension origin as e.g.
        //   safari-web-extension://ABC1234…
        // The matching Google-accepted redirect URI is the same host on
        // https://<uuid>.safari-web-extension.com/. We derive it here.
        const m = location.origin.match(/^safari-web-extension:\/\/([^/]+)/i);
        if (m) redirectUri = `https://${m[1]}.safari-web-extension.com/`;
    }
    if (redirectUri) {
        setText('#redirect-uri', redirectUri);
    } else {
        // Last-resort: let the user paste it in manually.
        const el = $('#redirect-uri');
        if (el) {
            el.innerHTML = '<input id="redirect-uri-manual" type="text" placeholder="Click Sign-in below — the error page Google shows will include the redirect URI; paste it here" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;">';
        }
    }
    $('#copy-redirect').addEventListener('click', () => {
        const toCopy = document.getElementById('redirect-uri-manual')
            ? document.getElementById('redirect-uri-manual').value
            : redirectUri;
        if (toCopy) navigator.clipboard.writeText(toCopy);
    });

    const stored = await new Promise(r => api.storage.local.get(['oauthClientId','signedIn','user','sheet','folder'], r));
    if (stored.oauthClientId) $('#client-id').value = stored.oauthClientId;
    renderUser(stored);
    renderTarget(stored);

    $('#save-client-id').addEventListener('click', async () => {
        const v = ($('#client-id').value || '').trim();
        await rpc({ type: 'set-client-id', clientId: v });
        alert('Saved.');
    });
    $('#signin').addEventListener('click', signInFromOptionsPage);
    $('#signout').addEventListener('click', async () => {
        await rpc({ type: 'sign-out' });
        const s = await new Promise(rr => api.storage.local.get(null, rr));
        renderUser(s);
    });

    $('#sheet-reload').addEventListener('click', loadSheets);
    $('#folder-reload').addEventListener('click', loadFolders);
    $('#sheet-filter').addEventListener('input', filterList.bind(null, '#sheet-list', '#sheet-filter'));
    $('#folder-filter').addEventListener('input', filterList.bind(null, '#folder-list', '#folder-filter'));

    $('#sheet-create').addEventListener('click', async () => {
        const title = prompt('Name for the new spreadsheet:', 'Listing Collector');
        if (!title) return;
        const r = await rpc({ type: 'create-spreadsheet', title });
        if (!r.ok) return alert('Create failed: ' + (r.message || ''));
        await loadSheets();
        chooseSheet({ id: r.spreadsheet.spreadsheetId, name: title });
    });
    $('#folder-create').addEventListener('click', async () => {
        const name = prompt('Name for the new Drive folder:', 'Listing Images');
        if (!name) return;
        const r = await rpc({ type: 'create-folder', name });
        if (!r.ok) return alert('Create failed: ' + (r.message || ''));
        await loadFolders();
        chooseFolder({ id: r.folder.id, name });
    });

    $('#test-btn').addEventListener('click', runTest);

    if (stored.signedIn) { loadSheets(); loadFolders(); }
}

// Options-page OAuth driver. Uses browser.identity.launchWebAuthFlow from
// THIS page (not the background worker) so that Safari's internal
// interception of the magic https://<uuid>.safari-web-extension.com/
// redirect URI works — that address is not a real DNS host, it's only
// recognized inside the identity API.
async function signInFromOptionsPage() {
    const resp = await rpc({ type: 'auth-url' });
    if (!resp.ok) { alert('Cannot build auth URL: ' + (resp.message || '(no message)')); return; }
    const authUrl  = resp.url;
    const redirect = resp.redirect || '';
    if (!api.identity || typeof api.identity.launchWebAuthFlow !== 'function') {
        // Fallback path for Safari Web Extensions where launchWebAuthFlow
        // isn't exposed: open Google's consent URL in a new tab, let the
        // user complete sign-in, and have them paste the resulting
        // "Safari Can't Find the Server" URL back here. That URL contains
        // the #access_token=… fragment we need.
        await manualSignInFlow(authUrl, redirect);
        return;
    }
    let redirected;
    try {
        redirected = await new Promise((resolve, reject) => {
            api.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (r) => {
                if (api.runtime && api.runtime.lastError) return reject(new Error(api.runtime.lastError.message || 'launchWebAuthFlow error'));
                if (!r) return reject(new Error('Sign-in cancelled or no redirect returned.'));
                resolve(r);
            });
        });
    } catch (e) {
        alert('Sign-in failed: ' + (e && e.message ? e.message : e) +
              (redirect ? '\n\nMake sure this exact URL is listed under Authorized redirect URIs in Google Cloud Credentials:\n\n' + redirect : ''));
        return;
    }
    const saved = await rpc({ type: 'save-redirect', redirected });
    if (!saved.ok) { alert('Sign-in failed while saving token: ' + (saved.message || '')); return; }
    // Small delay so storage.local.set() has flushed before we re-read.
    await new Promise(r => setTimeout(r, 150));
    const s = await new Promise(rr => api.storage.local.get(null, rr));
    // Fallback: if storage somehow hasn't caught up yet, trust the
    // background's reply.user as the source of truth.
    if (!s.signedIn && saved.user) {
        s.signedIn = true;
        s.user = saved.user;
    }
    renderUser(s);
    loadSheets(); loadFolders();
}

async function manualSignInFlow(authUrl, redirect) {
    // We can't window.open() here because Safari's popup blocker fires
    // unless the click is DIRECTLY on a real anchor. So we render a plain
    // <a> that the user clicks manually, then instruct them how to paste
    // the result URL back.
    const host = document.getElementById('step-signin') || document.body;
    let form = document.getElementById('uec-manual-signin');
    if (form) form.remove();
    form = document.createElement('div');
    form.id = 'uec-manual-signin';
    form.style.cssText = 'margin-top:12px;padding:12px 14px;border:2px dashed #1f7ae0;border-radius:10px;background:rgba(31,122,224,0.05);';
    form.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;">Manual sign-in</div>
        <ol style="margin:0 0 10px 18px;padding:0;font-size:13px;line-height:1.6;">
            <li>Click <b>Open Google sign-in</b> below. A new tab opens — sign in &amp; approve.</li>
            <li>You will land on a page that says <b>"Safari Can't Find the Server"</b>. That's expected.</li>
            <li>Select and copy the <b>entire URL</b> from Safari's address bar on that error page (starts with <code>https://</code>, ends with <code>scope=…</code>).</li>
            <li>Come back to this tab and paste it into the box below, then click <b>Save token</b>.</li>
        </ol>
        <div class="row">
            <a id="uec-manual-open" class="primary" href="${authUrl}" target="_blank" rel="noopener"
                style="display:inline-block;text-decoration:none;padding:8px 12px;border-radius:8px;background:#1f7ae0;color:#fff;font-weight:600;">
                Open Google sign-in
            </a>
        </div>
        <div class="row" style="margin-top:10px;">
            <input id="uec-manual-url" type="text" placeholder="Paste the URL from the &ldquo;Safari Can't Find the Server&rdquo; page here">
            <button id="uec-manual-save" class="primary">Save token</button>
        </div>
        <div id="uec-manual-status" class="muted" style="margin-top:6px;"></div>
    `;
    host.appendChild(form);

    document.getElementById('uec-manual-save').addEventListener('click', async () => {
        const redirected = (document.getElementById('uec-manual-url').value || '').trim();
        const statusEl = document.getElementById('uec-manual-status');
        if (!redirected) { statusEl.textContent = 'Paste the URL first.'; return; }
        if (redirected.indexOf('access_token=') < 0) {
            statusEl.textContent = 'That URL does not contain an access token. Make sure you copied the full URL from the "Safari Can\'t Find the Server" page, not the Google sign-in page.';
            return;
        }
        statusEl.textContent = 'Saving token…';
        const saved = await rpc({ type: 'save-redirect', redirected });
        if (!saved.ok) { statusEl.textContent = 'Error: ' + (saved.message || ''); return; }
        statusEl.textContent = 'Signed in. Refreshing…';
        await new Promise(r => setTimeout(r, 200));
        const s = await new Promise(rr => api.storage.local.get(null, rr));
        if (!s.signedIn && saved.user) { s.signedIn = true; s.user = saved.user; }
        renderUser(s);
        loadSheets(); loadFolders();
        form.remove();
    });
}

// Also re-render the user line whenever storage changes — covers the
// case where the token was saved out-of-band (e.g. via Web Inspector).
if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(async () => {
        const s = await new Promise(r => api.storage.local.get(null, r));
        renderUser(s);
    });
}

function renderUser(s) {
    if (s.signedIn) {
        const who = (s.user && (s.user.email || s.user.name)) || '(email unavailable)';
        setText('#who', 'Signed in as ' + who);
        $('#signin').hidden = true;
        $('#signout').hidden = false;
    } else {
        setText('#who', 'Not signed in.');
        $('#signin').hidden = false;
        $('#signout').hidden = true;
    }
}
function renderTarget(s) {
    setText('#cur-sheet',  s.sheet  && s.sheet.name  ? s.sheet.name  : 'none');
    setText('#cur-folder', s.folder && s.folder.name ? s.folder.name : 'none');
}

async function loadSheets() {
    const ul = $('#sheet-list'); ul.innerHTML = '<li class="muted">Loading…</li>';
    const r = await rpc({ type: 'list-spreadsheets' });
    if (!r.ok) { ul.innerHTML = '<li class="err">' + (r.message || 'Failed to load') + '</li>'; return; }
    ul.innerHTML = '';
    (r.files || []).forEach(f => {
        const li = document.createElement('li');
        li.dataset.name = f.name.toLowerCase();
        li.innerHTML = `<span class="nm">${escapeHtml(f.name)}</span> <span class="muted">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ''}</span>`;
        li.addEventListener('click', () => chooseSheet({ id: f.id, name: f.name }));
        ul.appendChild(li);
    });
    markSelected();
}
async function loadFolders() {
    const ul = $('#folder-list'); ul.innerHTML = '<li class="muted">Loading…</li>';
    const r = await rpc({ type: 'list-folders' });
    if (!r.ok) { ul.innerHTML = '<li class="err">' + (r.message || 'Failed to load') + '</li>'; return; }
    ul.innerHTML = '';
    (r.files || []).forEach(f => {
        const li = document.createElement('li');
        li.dataset.name = f.name.toLowerCase();
        li.innerHTML = `<span class="nm">${escapeHtml(f.name)}</span>`;
        li.addEventListener('click', () => chooseFolder({ id: f.id, name: f.name }));
        ul.appendChild(li);
    });
    markSelected();
}
function filterList(listSel, inputSel) {
    const q = ($(inputSel).value || '').toLowerCase().trim();
    $(listSel).querySelectorAll('li').forEach(li => {
        const name = li.dataset.name || '';
        li.hidden = q && !name.includes(q);
    });
}
async function chooseSheet(s) {
    const cur = await new Promise(r => api.storage.local.get(['folder'], r));
    await rpc({ type: 'set-target', sheet: s, folder: cur.folder || null });
    setText('#cur-sheet', s.name);
    markSelected();
}
async function chooseFolder(f) {
    const cur = await new Promise(r => api.storage.local.get(['sheet'], r));
    await rpc({ type: 'set-target', sheet: cur.sheet || null, folder: f });
    setText('#cur-folder', f.name);
    markSelected();
}
async function markSelected() {
    const s = await new Promise(r => api.storage.local.get(['sheet','folder'], r));
    document.querySelectorAll('#sheet-list li').forEach(li => {
        li.classList.toggle('sel', s.sheet && li.querySelector('.nm') && li.querySelector('.nm').textContent === s.sheet.name);
    });
    document.querySelectorAll('#folder-list li').forEach(li => {
        li.classList.toggle('sel', s.folder && li.querySelector('.nm') && li.querySelector('.nm').textContent === s.folder.name);
    });
}
async function runTest() {
    const out = $('#test-out'); out.textContent = 'Running…';
    const listing = {
        site: 'test', capturedAt: new Date().toISOString(),
        title: 'Test listing', url: 'https://example.com/itm/0', price: '$0',
        seller: 'test-seller', itemNumber: '0', country: 'United States',
        image: 'https://via.placeholder.com/200x200.png?text=Listing+Collector'
    };
    const r = await rpc({ type: 'save-listing', mode: 'ebay-search', site: 'ebay', listing, pageUrl: location.href });
    out.textContent = JSON.stringify(r, null, 2);
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

init();
