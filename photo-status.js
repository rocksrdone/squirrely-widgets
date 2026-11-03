/* photo-status.js — "does this order need a photo, and where is it?"

   One answer, read the same way at every station, so nobody has to ask.

   An order wants photos when Work_Orders.Send_Photos says Yes, or is blank
   and the customer has Wants_Product_Photos on. "No" on the order switches a
   photo customer off for that one order.

   Each order LINE (one colourway) then sits in one state:
     needed   — nobody has set a spool aside yet. The winder picks the best one.
     command  — Photo_Status "At command": a spool is out of the order, waiting
                for its picture. Packing must wait for it to come back.
     done     — a photo for this colourway is shared to this order (a
                Photo_Shares row), or Photo_Status is "Done".
     skip     — Photo_Status "Not needed" (command decided).
     none     — the order doesn't want photos.

   Shared photos are matched to a line by recipe, falling back to colourway
   name, so picking an older photo that still looks right counts as done. */
(function () {
  const AT = 'At command', DONE = 'Done', SKIP = 'Not needed';

  function getRefId(r) {
    if (r == null) return null;
    if (typeof r === 'number') return r || null;
    if (Array.isArray(r)) return r.length > 1 ? Number(r[1]) || null : null;
    if (typeof r === 'object' && 'id' in r) return Number(r.id) || null;
    return Number(r) || null;
  }
  const col = (t, c) => (t && Array.isArray(t[c])) ? t[c] : [];
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // "FF Nylon - Pink Flamingo" and "Pink Flamingo" are the same colourway.
  const bare = s => norm(String(s || '').replace(/^.*?-\s+/, ''));

  async function load(docApi) {
    const [wo, wol, cust, rec, shares, photos] = await Promise.all([
      docApi.fetchTable('Work_Orders'),
      docApi.fetchTable('Work_Order_Lines'),
      docApi.fetchTable('Customers'),
      docApi.fetchTable('Recipes'),
      docApi.fetchTable('Photo_Shares').catch(() => null),
      docApi.fetchTable('Product_Photos').catch(() => null),
    ]);
    const hasCol = Array.isArray(wol.Photo_Status);

    const custWants = {}, custCode = {};
    col(cust, 'id').forEach((id, i) => {
      custWants[id] = !!col(cust, 'Wants_Product_Photos')[i];
      custCode[id] = String(col(cust, 'Code')[i] || '').trim();
    });
    const recName = {}, recBySku = {};
    col(rec, 'id').forEach((id, i) => {
      recName[id] = col(rec, 'Recipe_Name')[i] || '';
      const s = norm(col(rec, 'SKU_Base')[i]); if (s) recBySku[s] = id;
    });

    const orders = {};
    col(wo, 'id').forEach((id, i) => {
      const ov = String(col(wo, 'Send_Photos')[i] || '');
      const cid = getRefId(col(wo, 'Customer')[i]);
      orders[id] = {
        id, wanted: ov === 'Yes' ? true : ov === 'No' ? false : !!custWants[cid],
        override: ov, customerWants: !!custWants[cid],
        link: String(col(wo, 'Photo_Share_URL')[i] || ''),
        linkMade: Number(col(wo, 'Photo_Share_Made')[i]) || 0,
        orderNumber: col(wo, 'Order_Number')[i] || '',
        customerCode: custCode[cid] || '',
        customerName: col(wo, 'Customer_Name')[i] || '',
        active: String(col(wo, 'Status')[i] || '') === 'Active',
        folder: '', lines: [],
      };
    });

    // What has been shared to each order: recipe ids and bare colourway names.
    const photoRec = {}, photoName = {};
    if (photos) col(photos, 'id').forEach((id, i) => {
      photoRec[id] = getRefId(col(photos, 'Recipe')[i]);
      photoName[id] = bare(col(photos, 'Colorway_Name')[i]);
    });
    const sharedTo = {};
    if (shares) col(shares, 'id').forEach((id, i) => {
      const w = getRefId(col(shares, 'Work_Order')[i]); if (!w) return;
      const p = getRefId(col(shares, 'Photo')[i]);
      const s = sharedTo[w] = sharedTo[w] || { recipes: new Set(), names: new Set(), count: 0 };
      s.count++;
      if (photoRec[p]) s.recipes.add(photoRec[p]);
      if (photoName[p]) s.names.add(photoName[p]);
      const dest = String(col(shares, 'Dest_Path')[i] || '');
      if (orders[w] && dest.includes('/') && !orders[w].folder) orders[w].folder = dest.replace(/\/[^/]*$/, '');
    });

    const lines = {};
    col(wol, 'id').forEach((id, i) => {
      const w = getRefId(col(wol, 'Work_Order')[i]);
      const o = orders[w]; if (!o) return;
      const rid = getRefId(col(wol, 'Recipe')[i]) || recBySku[norm(col(wol, 'SKU')[i])] || null;
      const st = hasCol ? String(col(wol, 'Photo_Status')[i] || '') : '';
      const sh = sharedTo[w];
      const shared = !!sh && ((rid && sh.recipes.has(rid)) || (rid && sh.names.has(bare(recName[rid]))));
      let state;
      if (!o.wanted) state = 'none';
      else if (st === SKIP) state = 'skip';
      else if (shared || st === DONE) state = st === AT ? 'command' : 'done';
      else if (st === AT) state = 'command';
      else state = 'needed';
      // A spool still "At command" is out of the order even if a photo is
      // already shared — packing waits until command sends it back (Done).
      const L = { id, woId: w, recipeId: rid, name: recName[rid] || '', status: st, shared, state };
      lines[id] = L; o.lines.push(L);
    });
    Object.values(orders).forEach(o => {
      // No photo shared yet: the folder the share workflow WOULD use, so a link
      // can be made (and the folder created) before anything is in it.
      if (!o.folder) o.folder = orderFolder(o.customerCode, o.orderNumber);
      const c = { needed: 0, command: 0, done: 0, skip: 0 };
      o.lines.forEach(l => { if (c[l.state] != null) c[l.state]++; });
      o.counts = c;
      o.total = o.wanted ? o.lines.length - c.skip : 0;
      o.shareCount = (sharedTo[o.id] || {}).count || 0;
    });
    return { hasCol, orders, lines, order: id => orders[id], line: id => lines[id] };
  }

  /* Same rule as "SS - Share Photo to Vendor": vendor-share/<code lower>/
     order-<number without # ? % \>. Drafts stay "order-D53". */
  function orderFolder(code, number) {
    const c = String(code || '').trim().toLowerCase().replace(/[#?%\\]/g, '');
    const n = String(number || '').trim().replace(/[#?%\\]/g, '');
    return c && n ? `Squirrely Stash/product-photos/vendor-share/${c}/order-${n}` : '';
  }

  async function setLines(docApi, lineIds, status) {
    const ids = (lineIds || []).filter(Boolean);
    if (!ids.length) return;
    await docApi.applyUserActions([['BulkUpdateRecord', 'Work_Order_Lines', ids,
      { Photo_Status: ids.map(() => status || null) }]]);
  }

  /* Small, consistent wording for every station. */
  function lineBadge(L) {
    if (!L) return '';
    const m = {
      needed:  ['#7A4A00', '#FFF3D6', '📷 photo: set best spool aside'],
      command: ['#1F4E79', '#E3EEF9', '📷 1 spool at command'],
      done:    ['#2E5E1A', '#EAF3DE', '📷 photo done'],
      skip:    ['#6B5E52', '#F1EEEA', '📷 not needed'],
    }[L.state];
    if (!m) return '';
    return `<span class="ssp-badge" style="display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;color:${m[0]};background:${m[1]};white-space:nowrap">${m[2]}</span>`;
  }
  function orderSummary(o) {
    if (!o || !o.wanted) return { tone: 'none', text: 'No photos for this order' };
    const c = o.counts || {};
    if (!o.total) return { tone: 'done', text: 'Photos: nothing to photograph' };
    if (c.command) return { tone: 'wait', text: `📷 ${c.command} spool${c.command > 1 ? 's' : ''} at command for photos — wait for ${c.command > 1 ? 'them' : 'it'} before sealing` };
    if (c.needed) return { tone: 'todo', text: `📷 Photos: ${c.done} of ${o.total} done — ${c.needed} colourway${c.needed > 1 ? 's' : ''} still need a spool set aside` };
    return { tone: 'done', text: `📷 Photos: all ${o.total} done` };
  }
  function orderBanner(o) {
    const s = orderSummary(o);
    if (s.tone === 'none') return '';
    const pal = { wait: ['#8B3A2A', '#FBF2F0'], todo: ['#7A4A00', '#FFF3D6'], done: ['#2E5E1A', '#EAF3DE'] }[s.tone];
    return `<div class="ssp-banner" style="margin:4px 0;padding:5px 9px;border-radius:5px;font-size:11px;font-weight:600;color:${pal[0]};background:${pal[1]}">${s.text}</div>`;
  }

  /* The per-order share link. Made once, the first time it's asked for, by
     the "SS - Order Photo Link" workflow, then kept on Work_Orders so every
     later click just copies it. Needs at least one photo shared, because the
     folder doesn't exist in Nextcloud until then. */
  const LINK_HOOK = 'https://squirrelystash.app.n8n.cloud/webhook/order-photo-link';
  /* Links expire after Nextcloud's default (90 days). A link made more than
     85 days ago is replaced with a fresh one rather than handed out dead.
     A link with no recorded date (made before dates were kept) is kept. */
  const LINK_DAYS = 85;
  async function ensureLink(docApi, o) {
    const stale = o.link && o.linkMade && (Date.now() / 1000 - o.linkMade) > LINK_DAYS * 86400;
    if (o.link && !stale) return o.link;
    if (!o.folder) throw new Error('This order has no customer code, so it has no folder.');
    const headers = window.SSSettings ? await SSSettings.hookHeaders({ 'Content-Type': 'application/json' })
                                      : { 'Content-Type': 'application/json' };
    const r = await fetch(LINK_HOOK, { method: 'POST', headers, body: JSON.stringify({ folder_path: o.folder, work_order_id: o.id, order_number: o.orderNumber }) });
    if (!r.ok) throw new Error('Link workflow returned ' + r.status);
    const j = await r.json().catch(() => ({}));
    const url = j.url || (j.ocs && j.ocs.data && j.ocs.data.url) || '';
    if (!url) throw new Error('Link workflow gave no url');
    await docApi.applyUserActions([['UpdateRecord', 'Work_Orders', o.id, { Photo_Share_URL: url, Photo_Share_Made: Date.now() / 1000 }]]);
    o.link = url;
    return url;
  }

  window.SSPhotos = { AT, DONE, SKIP, load, setLines, lineBadge, orderSummary, orderBanner, ensureLink, orderFolder };
})();
