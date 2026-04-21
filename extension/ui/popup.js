const api = (typeof browser !== 'undefined' ? browser : chrome);
function rpc(msg){return new Promise(r=>api.runtime.sendMessage(msg,x=>r(x||{ok:false})));}
async function render(){
    const s = await new Promise(r => api.storage.local.get(['signedIn','user','sheet','folder'], r));
    const state = document.getElementById('state');
    const target = document.getElementById('target');
    const signout = document.getElementById('signout');
    if (!s.signedIn) {
        state.textContent = 'Not signed in to Google.';
        target.textContent = '';
        signout.hidden = true;
    } else {
        state.textContent = 'Signed in as ' + ((s.user && (s.user.email || s.user.name)) || '(unknown)');
        target.innerHTML = 'Saving to <b>' + (s.sheet && s.sheet.name || '(no sheet)') + '</b> · images in <b>' + (s.folder && s.folder.name || '(no folder)') + '</b>.';
        signout.hidden = false;
    }
}
document.getElementById('options').addEventListener('click', () => api.runtime.openOptionsPage());
document.getElementById('signout').addEventListener('click', async () => { await rpc({type:'sign-out'}); render(); });
render();
