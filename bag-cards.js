/* ══ Back stock bag cards — the one shared copy ════════════════════════════
   Used by bin-audit.html (every bag at once), jobs.html (the bags a job is
   about) and inventory-desk.html (the bags you pick). One file so the card,
   its numbers and its print layout cannot drift between the three.

   A back stock bag holds ONE colourway in ONE fibre, and fills up over months
   from however many dye lots. So the bag — not the lot — is the thing that has
   a count, and the card that lives in it is a ledger: every put-away or pull
   writes a line, and the right-hand column is always the answer. An audit then
   reads a bag without opening it and without summing anything.

   Deliberately NOT a per-lot slip: three lots of Butterscotch would put three
   slips in one bag, and "how many are in here" becomes arithmetic done
   standing at the shelf.

   Grouping is by recipe + fibre, not by bin: a colourway that has drifted
   across two bins is still one bag. Both bins are named on the card so the
   discrepancy is visible rather than silently merged. The split check spans
   the whole COLOURWAY, so it is always computed over every lot — printing one
   card still warns that its colourway is also sitting somewhere else.

   Back stock per lot = General + Store + Vendor stock columns (stock model v2),
   the same sum bin-audit has always used.

     const all = await BagCards.load();          // every bag with back stock
     const mine = all.filter(g => ids.has(g.recipeId));
     BagCards.print(mine, msg => toast(msg));
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function findColumn(t, cands) {
    const keys = Object.keys(t || {});
    for (const c of cands) { const hit = keys.find(k => norm(k) === norm(c)); if (hit) return hit; }
    return null;
  }
  const col = (t, c) => (c && t && Array.isArray(t[c]) ? t[c] : []);
  function getRefId(ref) {
    if (typeof ref === 'number') return ref || null;
    if (Array.isArray(ref) && ref[0] === 'R') return ref[1] || null;
    return null;
  }
  function shortDate(v) {
    if (!v) return '';
    const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  // Bins sort naturally: A1 before A2 before A10.
  function binSort(a, b) {
    const pa = String(a).match(/^([A-Za-z]*)(\d*)/), pb = String(b).match(/^([A-Za-z]*)(\d*)/);
    if (pa[1] !== pb[1]) return pa[1].localeCompare(pb[1]);
    const na = Number(pa[2] || 0), nb = Number(pb[2] || 0);
    if (na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  }
  // Lots write 'FFN'; other tables write 'FF Nylon'. Compare the meaning.
  function fiberKey(s) {
    const v = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!v) return '';
    if (v === 'FFN' || v === 'FFNYLON') return 'FFN';
    if (v === 'FFC' || v === 'FFCOTTON') return 'FFC';
    if (v === 'EN' || v === 'ENYLON') return 'EN';
    return v;
  }
  /* Local, not toISOString(): printing after 8pm Eastern would date the card
     tomorrow. */
  function localToday() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* lots: [{ recipeId, colorway, fiber, lotNumber, qty, date, bin }] — qty is
     the lot's back stock. Returns one group per recipe + fibre with qty > 0. */
  function groups(lots) {
    const by = {};
    (lots || []).forEach(l => {
      const qty = Math.max(0, Number(l.qty) || 0);
      if (qty <= 0) return;                  // nothing in a bag means no bag to label
      const fib = String(l.fiber || '').trim();
      const key = (l.recipeId || l.colorway) + '\u0000' + fiberKey(fib);
      const g = by[key] = by[key] || { recipeId: l.recipeId || null,
        colorway: l.colorway || ('Recipe #' + l.recipeId), fiber: fib, bins: [], lots: [], total: 0 };
      g.lots.push({ lot: l.lotNumber, qty, date: l.date, bin: l.bin });
      g.total += qty;
      if (l.bin && g.bins.indexOf(l.bin) === -1) g.bins.push(l.bin);
    });
    const binsByColorway = {};
    Object.values(by).forEach(g => {
      const s = binsByColorway[g.colorway] = binsByColorway[g.colorway] || new Set();
      g.bins.forEach(b => s.add(b));
    });
    return Object.values(by).map(g => {
      g.colorwayBins = [...(binsByColorway[g.colorway] || [])].sort(binSort);
      g.lots.sort((a, b) => (a.date || 0) - (b.date || 0));   // oldest first: the total ends at today
      g.bins.sort(binSort);
      return g;
    }).sort((a, b) => a.colorway.localeCompare(b.colorway) || a.fiber.localeCompare(b.fiber));
  }

  /* A card for a bag Grist holds nothing for yet — a put-away job whose spools
     are going into a bag that has no back stock recorded. All blank lines. */
  function emptyGroup(recipeId, colorway, fiber, bin) {
    return { recipeId: recipeId || null, colorway: colorway || 'Recipe #' + recipeId, fiber: fiber || '',
      bins: bin ? [bin] : [], colorwayBins: bin ? [bin] : [], lots: [], total: 0 };
  }

  /* Reads Production_Lots, Recipes and Storage_Locations and returns every bag
     group. Throws with a readable message if the lots table is unusable. */
  async function load() {
    const safe = async n => { try { return await grist.docApi.fetchTable(n); } catch (e) { return null; } };
    const [lotsT, recT, locT] = await Promise.all([safe('Production_Lots'), safe('Recipes'), safe('Storage_Locations')]);
    if (!lotsT) throw new Error('could not read Production_Lots');
    const L = {
      lot: findColumn(lotsT, ['Lot_Number']), recipe: findColumn(lotsT, ['Recipe']),
      general: findColumn(lotsT, ['General_Stock_Spools']), store: findColumn(lotsT, ['Store_Stock_Spools']),
      vendor: findColumn(lotsT, ['Vendor_Stock_Spools']), fiber: findColumn(lotsT, ['Fiber']),
      bin: findColumn(lotsT, ['Storage_Bin']), date: findColumn(lotsT, ['Date_Dyed']),
    };
    if (!L.recipe || !(L.general || L.store || L.vendor))
      throw new Error('Production_Lots has no Recipe or stock columns');
    const rec = {};
    if (recT) {
      const rn = findColumn(recT, ['Recipe_Name']), rf = findColumn(recT, ['Fiber_Type']);
      (recT.id || []).forEach((id, i) => { rec[id] = { name: String(col(recT, rn)[i] || ''), fiber: String(col(recT, rf)[i] || '') }; });
    }
    const binById = {};
    if (locT) {
      const bc = findColumn(locT, ['Bin_Code']);
      (locT.id || []).forEach((id, i) => { const c = String(col(locT, bc)[i] || '').trim(); if (c) binById[id] = c; });
    }
    const binOf = raw => (raw == null || raw === '') ? '' : typeof raw === 'number' ? (binById[raw] || '') : String(raw).trim();
    const n = (c, i) => Number(col(lotsT, c)[i]) || 0;
    const lots = (lotsT.id || []).map((id, i) => {
      const recipeId = getRefId(col(lotsT, L.recipe)[i]);
      const r = rec[recipeId] || { name: '', fiber: '' };
      return {
        recipeId, colorway: r.name || 'Recipe #' + recipeId,
        fiber: String(col(lotsT, L.fiber)[i] || r.fiber || ''),
        lotNumber: String(col(lotsT, L.lot)[i] || 'Lot #' + id),
        qty: n(L.general, i) + n(L.store, i) + n(L.vendor, i),
        date: col(lotsT, L.date)[i], bin: binOf(col(lotsT, L.bin)[i]),
      };
    });
    const out = groups(lots);
    out.recipes = rec;          // { id: { name, fiber } } for cards of bags with nothing recorded yet
    return out;
  }

  /* The cards for a set of recipes: each recipe's bag(s), or a blank ledger
     when Grist holds no back stock for it. bins: optional { recipeId: bin }. */
  async function forRecipes(recipeIds, bins) {
    const all = await load();
    const out = [];
    [...new Set(recipeIds.filter(Boolean))].forEach(rid => {
      const mine = all.filter(g => g.recipeId === rid);
      if (mine.length) out.push(...mine);
      else {
        const r = all.recipes[rid] || {};
        out.push(emptyGroup(rid, r.name, r.fiber, bins && bins[rid]));
      }
    });
    return out;
  }

  /* ROWS is what fits the printed card. More lots than this fold their oldest
     lines into one opening balance; the detail is in Grist either way. The
     split-bins warning costs rows, or the last line and footer get clipped. */
  const ROWS = 12, WARN_ROWS = 2;

  function cardHtml(g) {
    const allBins = g.colorwayBins || g.bins;
    const split = allBins.length > 1;
    const rowCount = ROWS - (split ? WARN_ROWS : 0);
    const lots = g.lots.slice();
    let opening = null;
    const room = rowCount - 4;              // always leave blank lines to write on
    if (lots.length > room) {
      const folded = lots.splice(0, lots.length - room + 1);
      opening = { qty: folded.reduce((s, x) => s + x.qty, 0), n: folded.length };
    }
    let running = opening ? opening.qty : 0, rows = '';
    if (opening) rows += `<tr><td></td><td class="lot">${opening.n} older lots</td>` +
      `<td class="n">${opening.qty}</td><td class="n"></td><td class="tot">${running}</td></tr>`;
    lots.forEach(l => {
      running += l.qty;
      rows += `<tr><td>${esc(shortDate(l.date) || '')}</td><td class="lot">${esc(l.lot)}</td>` +
        `<td class="n">${l.qty}</td><td class="n"></td><td class="tot">${running}</td></tr>`;
    });
    const used = (opening ? 1 : 0) + lots.length;
    for (let k = used; k < rowCount; k++)
      rows += '<tr><td></td><td class="lot"></td><td class="n"></td><td class="n"></td><td class="tot"></td></tr>';
    const foot = g.lots.length
      ? `Opening lines are what Grist held on ${esc(localToday())}.
         Count the bag. If it disagrees, write a correction line &mdash; the bag is right, not the screen.`
      : `Printed ${esc(localToday())} with nothing recorded in back stock yet. Write each put-away as a line.`;
    return `<div class="bc">
    <div class="bc-hd">BACK STOCK BAG</div>
    <div class="bc-top">
      <div class="bc-id">
        <div class="bc-name">${esc(g.colorway)}</div>
        <div class="bc-meta">${esc(g.fiber || 'fibre not set')}</div>
      </div>
      <div class="bc-bin"><div class="bc-binl">bin</div>
        <div class="bc-binb">${esc(g.bins.length ? g.bins.join(' / ') : '')}</div></div>
    </div>
    ${split ? `<div class="bc-warn">${esc(g.colorway)} is spread across ${esc(allBins.join(', '))}
         &mdash; one colourway lives in one bin. Bring it together, both fibres, a bag each.</div>` : ''}
    <table class="bc-t">
      <tr><th>date</th><th class="lot">lot</th><th class="n">in +</th><th class="n">out &minus;</th><th class="tot">= in bag</th></tr>
      ${rows}
    </table>
    <div class="bc-foot">${foot}</div>
  </div>`;
  }

  /* Four to a sheet, in reading order, in explicit pages so the guillotine
     cuts straight. A short last page stays short: a blank card invites a bag
     nothing in Grist knows about. */
  const PER_PAGE = 4;
  function pages(gs) {
    const out = [];
    for (let i = 0; i < gs.length; i += PER_PAGE)
      out.push('<div class="page">' + gs.slice(i, i + PER_PAGE).map(cardHtml).join('') + '</div>');
    return out.join('');
  }

  const CSS = `
      @page { size: Letter; margin: .25in; }
      * { box-sizing: border-box; }
      body { font-family: Helvetica, Arial, sans-serif; color: #000; margin: 0; }
      .page { display: flex; flex-wrap: wrap; align-content: flex-start;
              page-break-after: always; break-after: page; }
      .page:last-child { page-break-after: auto; break-after: auto; }
      /* 2 across x 2 down = 8in x 10in inside a Letter page at .25in margins. */
      .bc { width: 4in; height: 5in; padding: .16in .18in; outline: 1px dashed #B9B9B9;
            outline-offset: -.5px; display: flex; flex-direction: column; overflow: hidden;
            page-break-inside: avoid; break-inside: avoid; }
      .bc-hd { font-size: 8px; font-weight: bold; letter-spacing: 1.4px; }
      .bc-top { display: flex; align-items: flex-start; gap: .12in; margin-top: 2px; }
      .bc-id { flex: 1; min-width: 0; }
      .bc-name { font-size: 20px; font-weight: bold; line-height: 1.08; overflow-wrap: anywhere; }
      .bc-meta { font-size: 10px; color: #333; margin-top: 2px; }
      .bc-bin { flex: none; width: 1.05in; border: 2.5px solid #000; text-align: center; }
      .bc-binl { font-size: 8px; font-weight: bold; letter-spacing: 1px; background: #000; color: #fff;
                 text-transform: uppercase; padding: 1px 0; }
      .bc-binb { font-size: 20px; font-weight: bold; height: .36in; line-height: .36in; overflow: hidden; }
      .bc-warn { font-size: 8.5px; margin-top: 4px; padding: 2px 4px; border: 1px solid #000; }
      .bc-t { width: 100%; border-collapse: collapse; margin-top: 6px; table-layout: fixed; }
      .bc-t th { font-size: 7.5px; text-transform: uppercase; letter-spacing: .6px; color: #444;
                 text-align: left; border-bottom: 2px solid #000; padding-bottom: 1px; font-weight: bold; }
      .bc-t td { height: .255in; border-bottom: 1px solid #999; font-size: 11px;
                 overflow: hidden; white-space: nowrap; }
      .bc-t th:first-child, .bc-t td:first-child { width: .62in; }
      .bc-t .lot { width: .95in; }
      .bc-t .n { width: .52in; text-align: center; }
      .bc-t .tot { width: .8in; text-align: center; border-left: 2px solid #000;
                   font-weight: bold; padding-left: 3px; }
      .bc-t th.tot { font-weight: bold; }
      .bc-foot { font-size: 7.5px; color: #555; line-height: 1.35; margin-top: auto; padding-top: 4px; }`;

  /* A print window opened straight from the click. Browsers block a pop-up
     opened after an await, so a caller that has to load data first opens the
     window with this BEFORE loading and passes it to print(). */
  function openWindow(say) {
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { (say || (m => alert(m)))('Allow pop-ups to print bag cards'); return null; }
    w.document.write('<p style="font-family:sans-serif">Making bag cards…</p>');
    return w;
  }

  /* Fills and prints the window. say(msg) reports a problem to the caller;
     w is a window from openWindow(), or one is opened here. */
  function print(gs, say, w) {
    const tell = say || (m => alert(m));
    if (!gs || !gs.length) { if (w) w.close(); tell('No bag cards to print'); return false; }
    w = w || window.open('', '_blank', 'width=900,height=1000');
    if (!w) { tell('Allow pop-ups to print bag cards'); return false; }
    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Back stock bag cards</title>
    <style>${CSS}</style></head><body>${pages(gs)}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); }, 250);
    return true;
  }

  window.BagCards = { load, forRecipes, openWindow, groups, emptyGroup, cardHtml, pages, print, fiberKey, binSort };
})();
