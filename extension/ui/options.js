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
    const redir = await rpc({ type: 'redirect-uri' });
    setText('#redirect-uri', redir.uri || '(unavailable in this browser)');
    $('#copy-redirect').addEventListener('click', () => navigator.clipboard.writeText(redir.uri || ''));

    const stored = await new Promise(r => api.storage.local.get(['oauthClientId','signedIn','user','sheet','folder'], r));
    if (stored.oauthClientId) $('#client-id').value = stored.oauthClientId;
    renderUser(stored);
    renderTarget(stored);

    $('#save-client-id').addEventListener('click', async () => {
        const v = ($('#client-id').value || '').trim();
        await rpc({ type: 'set-client-id', clientId: v });
        alert('Saved.');
    });
    $('#signin').addEventListener('click', async () => {
        const r = await rpc({ type: 'sign-in' });
        if (!r.ok) { alert('Sign-in failed: ' + (r.message || '')); return; }
        const s = await new Promise(rr => api.storage.local.get(null, rr));
        renderUser(s);
        loadSheets(); loadFolders();
    });
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

function renderUser(s) {
    if (s.signedIn && s.user) {
        setText('#who', 'Signed in as ' + (s.user.email || s.user.name || '(unknown)'));
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
