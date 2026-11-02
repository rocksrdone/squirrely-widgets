/* ══ Push photos to a store — the one shared picker ═══════════════════════
   Used by photo-gallery.html and recipe-builder.html. Pick a recipe's photos
   in order, pick a store, and "SS - Push Store Photos" in n8n puts them on
   that store's listing for the recipe's SKU. The first photo picked becomes
   the main image.

   Retail ALWAYS replaces every photo on the listing: the retail photo must
   match what is in stock, so an old photo left behind is a wrong photo.
   Vendor replaces by default, or can add to what is there, because a vendor
   listing may show several lots to show how a colourway varies.

   After a push that worked, the photos' On_Retail_Store / On_Vendor_Store
   flags (Product_Photos) are set to match, when those columns exist, so
   Recipe Builder shows what is live where. A replace clears the flag on the
   recipe's other photos for that store; an add only sets it.

   Needs settings.js (for the webhook key) and full document access.

     PhotoPush.openForRecipe(recipeId, { onDone })
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  const WEBHOOK_URL = 'https://squirrelystash.app.n8n.cloud/webhook/store-photos';
  const FLAG = { retail: 'On_Retail_Store', vendor: 'On_Vendor_Store' };
  const esc = s => (s == null ? '' : String(s)).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const findCol = (t, names) => Object.keys(t || {}).find(k => names.some(n => norm(n) === norm(k))) || null;
  const col = (t, c) => (c && Array.isArray(t[c]) ? t[c] : []);
  const refId = v => typeof v === 'number' ? v : (Array.isArray(v) && v[0] === 'R' ? v[1] : null);

  const S = { recipe: null, photos: [], order: [], store: 'retail', mode: 'replace', busy: false, cols: {}, onDone: null };

  function css() {
    if (document.getElementById('ppush-css')) return;
    const st = document.createElement('style'); st.id = 'ppush-css';
    st.textContent = `
      .ppush-bg { position: fixed; inset: 0; background: rgba(26,22,20,.5); z-index: 9000; display: flex;
        align-items: flex-start; justify-content: center; padding: 24px 12px; overflow: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; color: #1A1614; }
      .ppush { background: #FDFBF7; border-radius: 10px; max-width: 720px; width: 100%; padding: 14px 16px 16px; }
      .ppush h2 { font-size: 16px; margin: 0 0 2px; } .ppush .sub { font-size: 12px; color: #8B7D72; margin-bottom: 10px; }
      .ppush .seg { display: inline-flex; border: 1.5px solid #E8DFD4; border-radius: 7px; overflow: hidden; margin: 0 8px 8px 0; }
      .ppush .seg button { font: inherit; font-size: 12.5px; font-weight: 600; padding: 7px 12px; border: 0; background: #fff; cursor: pointer; color: #1A1614; }
      .ppush .seg button.on { background: #2A6B6B; color: #fff; }
      .ppush .note { font-size: 11.5px; color: #8B7D72; margin: 2px 0 10px; line-height: 1.4; }
      .ppush .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
      .ppush .tile { position: relative; border: 2px solid #E8DFD4; border-radius: 7px; overflow: hidden; cursor: pointer; background: #F3EEE7; }
      .ppush .tile.on { border-color: #2A6B6B; }
      .ppush .tile img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
      .ppush .tile .n { position: absolute; top: 5px; left: 5px; min-width: 22px; height: 22px; border-radius: 11px; background: #2A6B6B;
        color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; padding: 0 5px; }
      .ppush .tile .cap { font-size: 10.5px; padding: 3px 5px; color: #6B5E52; display: flex; gap: 4px; flex-wrap: wrap; }
      .ppush .tile .cap b { font-weight: 600; color: #2A6B6B; }
      .ppush .bar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; align-items: center; }
      .ppush .bar .msg { flex: 1; font-size: 12px; }
      .ppush .btn { font: inherit; font-size: 12.5px; font-weight: 600; padding: 8px 13px; border-radius: 6px; cursor: pointer;
        border: 1.5px solid #E8DFD4; background: #fff; color: #1A1614; }
      .ppush .btn.go { background: #2A6B6B; border-color: #2A6B6B; color: #fff; } .ppush .btn:disabled { opacity: .45; cursor: default; }
      .ppush .ok { color: #2A6B6B; } .ppush .bad { color: #8B3A2A; } .ppush a { color: #2A6B6B; }`;
    document.head.appendChild(st);
  }

  async function load(recipeId) {
    const [rt, pt] = await Promise.all([grist.docApi.fetchTable('Recipes'), grist.docApi.fetchTable('Product_Photos')]);
    const ri = (rt.id || []).indexOf(recipeId);
    if (ri < 0) throw new Error('recipe not found');
    S.recipe = { id: recipeId, name: String(col(rt, findCol(rt, ['Recipe_Name']))[ri] || ''),
      sku: String(col(rt, findCol(rt, ['SKU_Base']))[ri] || '').trim(), fiber: String(col(rt, findCol(rt, ['Fiber_Type']))[ri] || '') };
    const c = S.cols = { recipe: findCol(pt, ['Recipe']), url: findCol(pt, ['Nextcloud_URL']), fav: findCol(pt, ['Is_Favorite']),
      date: findCol(pt, ['Lot_Date']), status: findCol(pt, ['Status']), file: findCol(pt, ['Source_Filename']),
      retail: findCol(pt, [FLAG.retail]), vendor: findCol(pt, [FLAG.vendor]) };
    S.photos = (pt.id || []).map((id, i) => ({ id, recipe: refId(col(pt, c.recipe)[i]), url: String(col(pt, c.url)[i] || '').trim(),
      fav: !!col(pt, c.fav)[i], date: col(pt, c.date)[i], status: String(col(pt, c.status)[i] || ''),
      file: String(col(pt, c.file)[i] || ''), retail: !!col(pt, c.retail)[i], vendor: !!col(pt, c.vendor)[i] }))
      .filter(p => p.recipe === recipeId && p.url && !/reject/i.test(p.status))
      .sort((a, b) => (b.fav - a.fav) || ((b.date || 0) - (a.date || 0)));
  }

  /* Start from what is already live on that store, else the favourite. */
  function preselect() {
    const live = S.photos.filter(p => p[S.store]);
    const start = live.length ? live : S.photos.filter(p => p.fav).slice(0, 1);
    S.order = (start.length ? start : S.photos.slice(0, 1)).map(p => p.id);
  }

  function render(msg) {
    const r = S.recipe, replace = S.store === 'retail' || S.mode === 'replace';
    const el = document.getElementById('ppush-box');
    el.innerHTML = `
      <h2>Push photos to a store</h2>
      <div class="sub">${esc(r.name)} ${esc(r.fiber)} · <b>${esc(r.sku || 'no SKU')}</b></div>
      <div><span class="seg">
          <button data-store="retail" class="${S.store === 'retail' ? 'on' : ''}">Retail store</button>
          <button data-store="vendor" class="${S.store === 'vendor' ? 'on' : ''}">Vendor store</button></span>
        ${S.store === 'vendor' ? `<span class="seg">
          <button data-mode="replace" class="${S.mode === 'replace' ? 'on' : ''}">Replace all</button>
          <button data-mode="add" class="${S.mode === 'add' ? 'on' : ''}">Add to existing</button></span>` : ''}</div>
      <div class="note">${S.store === 'retail'
        ? 'Retail always replaces every photo on the listing — it must match what is in stock.'
        : replace ? 'Every photo now on the vendor listing is removed and these take their place.'
                  : 'These are added after the photos already on the vendor listing.'}
        Tap photos in the order you want them; <b>1</b> is the main image.</div>
      <div class="grid">${S.photos.map(p => {
        const n = S.order.indexOf(p.id);
        const d = p.date ? new Date(Number(p.date) * 1000).toLocaleDateString(undefined, { timeZone: 'UTC' }) : '';
        return `<div class="tile ${n >= 0 ? 'on' : ''}" data-pick="${p.id}">
          ${n >= 0 ? `<span class="n">${n + 1}</span>` : ''}<img loading="lazy" src="${esc(p.url)}" alt="">
          <div class="cap">${p.fav ? '<b>★</b>' : ''}${p.retail ? '<b>retail</b>' : ''}${p.vendor ? '<b>vendor</b>' : ''}<span>${esc(d)}</span></div></div>`;
      }).join('') || '<div class="note">No product photos are linked to this recipe.</div>'}</div>
      <div class="bar"><span class="msg">${msg || ''}</span>
        <button class="btn" data-act="close">${S.done ? 'Close' : 'Cancel'}</button>
        <button class="btn go" data-act="push" ${S.busy || !S.order.length || !r.sku ? 'disabled' : ''}>${S.busy ? 'Pushing…'
          : `Push ${S.order.length || ''} to ${S.store}${replace ? ' (replace)' : ' (add)'}`}</button></div>`;
  }

  async function push() {
    const r = S.recipe, replace = S.store === 'retail' || S.mode === 'replace';
    const picked = S.order.map(id => S.photos.find(p => p.id === id)).filter(Boolean);
    const what = `${picked.length} photo${picked.length === 1 ? '' : 's'} to the ${S.store} listing for ${r.sku}`;
    if (!confirm(replace ? `Replace ALL photos on the ${S.store} listing for ${r.sku} with these ${picked.length}?` : `Add ${what}?`)) return;
    S.busy = true; render();
    try {
      const res = await fetch(WEBHOOK_URL, { method: 'POST',
        headers: window.SSSettings ? await SSSettings.hookHeaders({ 'Content-Type': 'application/json' }) : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store: S.store, mode: replace ? 'replace' : 'add', sku: r.sku,
          images: picked.map((p, i) => ({ url: p.url, alt: `${r.name} ${r.fiber}`.trim() + (i ? ` (${i + 1})` : '') })) }) });
      if (res.status === 401 || res.status === 403) throw new Error('n8n refused the Webhook_Key');
      if (res.status === 404) throw new Error('the "SS - Push Store Photos" workflow is not active in n8n');
      if (!res.ok) throw new Error('the workflow answered ' + res.status);
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'the push failed');
      await setFlags(picked, replace);
      S.busy = false; S.done = true;
      const parts = [`${d.added} photo${d.added === 1 ? '' : 's'} sent`, d.removed ? `${d.removed} old removed` : '',
        d.failed ? `<span class="bad">${d.failed} failed to process</span>` : ''].filter(Boolean).join(', ');
      render(`<span class="ok">✓ ${parts}.</span> Shopify finishes processing in a minute. <a href="${esc(d.admin_url)}" target="_blank" rel="noopener">Open in Shopify</a>`);
      if (S.onDone) try { S.onDone(d); } catch (e) { console.warn(e); }
    } catch (e) {
      S.busy = false;
      render(`<span class="bad">✗ ${esc((e && e.message) || e)}</span>`);
    }
  }

  /* Record what is live where. Skipped quietly when the flag columns do not
     exist yet — Recipe Builder offers to add them. */
  async function setFlags(picked, replace) {
    const c = S.cols[S.store];
    if (!c) return;
    const on = new Set(picked.map(p => p.id));
    const acts = S.photos.filter(p => on.has(p.id) ? !p[S.store] : (replace && p[S.store]))
      .map(p => ['UpdateRecord', 'Product_Photos', p.id, { [c]: on.has(p.id) }]);
    if (!acts.length) return;
    try { await grist.docApi.applyUserActions(acts); S.photos.forEach(p => { if (on.has(p.id)) p[S.store] = true; else if (replace) p[S.store] = false; }); }
    catch (e) { console.warn('Photo push: could not record store flags', e); }
  }

  function close() { const bg = document.getElementById('ppush-bg'); if (bg) bg.remove(); }

  async function openForRecipe(recipeId, opts) {
    css(); close();
    Object.assign(S, { recipe: null, photos: [], order: [], store: 'retail', mode: 'replace', busy: false, done: false, onDone: (opts || {}).onDone || null });
    const bg = document.createElement('div'); bg.id = 'ppush-bg'; bg.className = 'ppush-bg';
    bg.innerHTML = '<div class="ppush" id="ppush-box"><div class="sub">Loading photos…</div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', e => {
      if (e.target === bg) return close();
      const t = e.target.closest('[data-store],[data-mode],[data-pick],[data-act]');
      if (!t || S.busy) return;
      if (t.dataset.store) { S.store = t.dataset.store; S.done = false; if (!S.order.length) preselect(); render(); }
      else if (t.dataset.mode) { S.mode = t.dataset.mode; render(); }
      else if (t.dataset.pick) {
        const id = Number(t.dataset.pick), i = S.order.indexOf(id);
        if (i >= 0) S.order.splice(i, 1); else S.order.push(id);
        S.done = false; render();
      } else if (t.dataset.act === 'close') close();
      else if (t.dataset.act === 'push') push();
    });
    try { await load(recipeId); preselect(); render(S.recipe.sku ? '' : '<span class="bad">This recipe has no SKU, so there is no listing to push to.</span>'); }
    catch (e) { document.getElementById('ppush-box').innerHTML = `<div class="bad">Could not load photos: ${esc(e.message || e)}</div><div class="bar"><button class="btn" data-act="close">Close</button></div>`; }
  }

  window.PhotoPush = { openForRecipe, close };
})();
