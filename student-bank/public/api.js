async function apiGet(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
}
async function apiPost(path, body) {
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || JSON.stringify(j));
    return j;
}

async function getAccount() {
    return apiGet('/account/' + encodeURIComponent(Auth.get()));
}
async function postTransfer(from, to, amount) {
    return apiPost('/transfer', { accountId: Auth.get(), from, to, amount });
}

async function accrueHYSA(days = 1) {
    return apiPost('/hysa/accrue', { accountId: Auth.get(), days });
}
async function registerAccount(accountId, name) {
    return apiPost('/register', { accountId, name });
}
window.getAccount = getAccount;
window.postTransfer = postTransfer;
window.accrueHYSA = accrueHYSA;
window.registerAccount = registerAccount;