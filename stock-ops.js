/* ── stock-ops.js — the one place lot, allocation and bin writes are decided ──
   Loaded by the Lot Desk (and, later, the wind and box stations) with
     <script src="stock-ops.js"></script>
   so every screen that moves thread follows the same rules. Eight widgets
   each carrying their own copy of these rules is what produced lots stuck
   "drying", unaccounted spools and bins pointing nowhere.

   THE LOT ARITHMETIC this file keeps balanced (stock-model.md):
     Spools_Made − allocations − On_Hand_Spools − Broken_Spools = still waiting
   The kettle writes Spools_Made as the pot's dyed count, so a fresh lot is
   "waiting" by exactly that much until it is put away.

   Put away, per lot, one save:
     · to an order   → an allocation on that order's line, counted at once.
                       Hank: "Unwound - Bagged". Wound: "Wound - Needs Labels".
                       Order_Bin set to the customer bin, O-<CODE>-<ORDER>.
     · back stock, wound → On_Hand +n (listed on the vendor store if ticked)
     · back stock, hank  → Hank_Est +n, and Spools_Made −n: hank was never
                       wound, and the stock model keeps it out of Made until it
                       is (winding it later adds it back).
   A count that differs from the dyed amount corrects Spools_Made, so the lot
   never reads as having lost or gained thread it did not. */
(function (root) {
  'use strict';

  const ORDER_STATUS_HANK = 'Unwound - Bagged';
  const ORDER_STATUS_WOUND = 'Wound - Needs Labels';
  const DONE_ALLOC = /pack|ship|sent|deliver|complete|fulfil/i;
  const RELEASED_ORDER = 'Active';

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function col(t, cands) {
    const keys = Object.keys(t || {});
    for (const cand of cands) {
      const want = cand.toLowerCase().replace(/[^a-z0-9]/g, '');
      const hit = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === want);
      if (hit) return hit;
    }
    return null;
  }
  function arr(t, c) { return c && Array.isArray(t[c]) ? t[c] : []; }
  function refId(v) {
    if (typeof v === 'number') return v || null;
    if (Array.isArray(v)) return v[1] || null;
    if (v && typeof v === 'object' && 'rowId' in v) return v.rowId;
    return null;
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function fiberCode(f) {
    const s = String(f || '').trim().toUpperCase();
    if (!s) return '';
    if (/^(FFN|FFC|EN|BW|CN)$/.test(s)) return s;
    if (/E\s*NYLON/.test(s)) return 'EN';
    if (/COTTON/.test(s)) return 'FFC';
    if (/NYLON/.test(s)) return 'FFN';
    return s;
  }
  function yardsPerSpool(fiber) { return fiberCode(fiber) === 'EN' ? 150 : 100; }
  function orderBinCode(customerCode, orderNumber) {
    const c = String(customerCode || '').trim().toUpperCase();
    const o = String(orderNumber || '').trim().replace(/^#/, '');
    return c && o ? `O-${c}-${o}` : '';
  }

  /* Everything a put-away decision needs, read once. */
  async function load(docApi) {
    const fetch = (n) => docApi.fetchTable(n);
    const optional = (n) => docApi.fetchTable(n).catch(() => null);
    const [lotsT, allocT, wolT, woT, recT, custT, locT] = await Promise.all([
      fetch('Production_Lots'), fetch('Lot_Allocations'), fetch('Work_Order_Lines'),
      fetch('Work_Orders'), fetch('Recipes'), optional('Customers'), optional('Storage_Locations'),
    ]);

    const L = {
      lotNumber: col(lotsT, ['Lot_Number']), recipe: col(lotsT, ['Recipe']),
      date: col(lotsT, ['Date_Dyed']), fiber: col(lotsT, ['Fiber']),
      yards: col(lotsT, ['Total_Yards_Made']), made: col(lotsT, ['Spools_Made']),
      onHand: col(lotsT, ['On_Hand_Spools']), hank: col(lotsT, ['Hank_Est_Spools']),
      vendor: col(lotsT, ['Vendor_Stock_Spools']), store: col(lotsT, ['Store_Stock_Spools']),
      broken: col(lotsT, ['Broken_Spools']), bin: col(lotsT, ['Storage_Bin']),
      drying: col(lotsT, ['Drying_Status']), notes: col(lotsT, ['Notes']),
    };
    const A = {
      lot: col(allocT, ['Lot']), qty: col(allocT, ['Qty_Spools']), status: col(allocT, ['Status']),
      line: col(allocT, ['Work_Order_Line']), customer: col(allocT, ['Customer']),
      orderBin: col(allocT, ['Order_Bin']), source: col(allocT, ['Stock_Source']),
    };
    const WL = {
      wo: col(wolT, ['Work_Order']), qty: col(wolT, ['Qty_Needed']), recipe: col(wolT, ['Recipe']),
      sku: col(wolT, ['SKU']), queue: col(wolT, ['Queue_Status']), makeFresh: col(wolT, ['Make_Fresh']),
    };
    const WO = {
      status: col(woT, ['Status']), number: col(woT, ['Order_Number']), customer: col(woT, ['Customer']),
      customerName: col(woT, ['Customer_Name']), due: col(woT, ['Due_Date']),
    };
    const R = { name: col(recT, ['Recipe_Name']), sku: col(recT, ['SKU_Base']), fiber: col(recT, ['Fiber_Type']) };

    const missing = [];
    [['Production_Lots.Spools_Made', L.made], ['Production_Lots.On_Hand_Spools', L.onHand],
     ['Production_Lots.Hank_Est_Spools', L.hank], ['Lot_Allocations.Lot', A.lot],
     ['Lot_Allocations.Qty_Spools', A.qty], ['Lot_Allocations.Work_Order_Line', A.line]]
      .forEach(([n, c]) => { if (!c) missing.push(n); });

    const recipes = {};
    (recT.id || []).forEach((id, i) => {
      recipes[id] = { id, name: String(arr(recT, R.name)[i] || `Recipe #${id}`),
        sku: String(arr(recT, R.sku)[i] || ''), fiberName: String(arr(recT, R.fiber)[i] || ''),
        fiber: fiberCode(arr(recT, R.fiber)[i]) };
    });
    const customers = {};
    if (custT) {
      const cn = col(custT, ['Customer_Name']), cc = col(custT, ['Code']);
      (custT.id || []).forEach((id, i) => {
        customers[id] = { id, name: String(arr(custT, cn)[i] || ''), code: String(arr(custT, cc)[i] || '') };
      });
    }
    const bins = []; const binById = {};
    if (locT) {
      const bc = col(locT, ['Bin_Code']);
      (locT.id || []).forEach((id, i) => {
        const code = String(arr(locT, bc)[i] || '').trim();
        if (!code) return;
        bins.push({ id, code }); binById[id] = code;
      });
    }

    const orders = {};
    (woT.id || []).forEach((id, i) => {
      const cid = refId(arr(woT, WO.customer)[i]);
      const cust = customers[cid] || null;
      orders[id] = {
        id, status: String(arr(woT, WO.status)[i] || ''),
        number: String(arr(woT, WO.number)[i] || `WO ${id}`).replace(/^#/, ''),
        customerId: cid, customerName: String(arr(woT, WO.customerName)[i] || (cust && cust.name) || ''),
        customerCode: cust ? cust.code : '', due: num(arr(woT, WO.due)[i]),
      };
    });

    // Allocations: totals per lot (all statuses — the arithmetic counts them
    // all) and per order line (what is already covered).
    const allocByLot = {}, allocByLine = {};
    (allocT.id || []).forEach((id, i) => {
      const q = num(arr(allocT, A.qty)[i]);
      const lot = refId(arr(allocT, A.lot)[i]);
      const line = refId(arr(allocT, A.line)[i]);
      if (lot) allocByLot[lot] = (allocByLot[lot] || 0) + q;
      if (line) allocByLine[line] = (allocByLine[line] || 0) + q;
    });

    // Open order lines per recipe: released orders, still short.
    const linesByRecipe = {};
    const recipeBySku = {};
    Object.values(recipes).forEach(r => { if (r.sku) recipeBySku[r.sku.toUpperCase()] = r.id; });
    (wolT.id || []).forEach((id, i) => {
      const o = orders[refId(arr(wolT, WL.wo)[i])];
      if (!o || o.status !== RELEASED_ORDER) return;
      if (/cancel/i.test(String(arr(wolT, WL.queue)[i] || ''))) return;
      const rid = refId(arr(wolT, WL.recipe)[i]) || recipeBySku[String(arr(wolT, WL.sku)[i] || '').toUpperCase()];
      if (!rid) return;
      const need = num(arr(wolT, WL.qty)[i]);
      const short = need - (allocByLine[id] || 0);
      if (short <= 0) return;
      (linesByRecipe[rid] = linesByRecipe[rid] || []).push({
        lineId: id, order: o, need, short,
        bin: orderBinCode(o.customerCode, o.number),
      });
    });
    Object.values(linesByRecipe).forEach(list => list.sort((a, b) =>
      ((a.order.due || 9e12) - (b.order.due || 9e12)) || String(a.order.number).localeCompare(String(b.order.number))));

    const lots = [];
    (lotsT.id || []).forEach((id, i) => {
      const rid = refId(arr(lotsT, L.recipe)[i]);
      const recipe = recipes[rid] || { id: rid, name: rid ? `Recipe #${rid}` : '(no colourway)', sku: '', fiber: '', fiberName: '' };
      const hank = num(arr(lotsT, L.hank)[i]);
      const madeRaw = num(arr(lotsT, L.made)[i]);
      // Older lots carry yardage but no spool count. Never for a hank lot —
      // its yardage is the hank, and counting it again would double it.
      const fiber = fiberCode(arr(lotsT, L.fiber)[i]) || recipe.fiber;
      const made = madeRaw || (!hank && L.yards ? Math.round(num(arr(lotsT, L.yards)[i]) / yardsPerSpool(fiber)) : 0);
      const onHand = num(arr(lotsT, L.onHand)[i]);
      const broken = num(arr(lotsT, L.broken)[i]);
      const alloc = allocByLot[id] || 0;
      const binRaw = arr(lotsT, L.bin)[i];
      lots.push({
        id, recipe, fiber,
        lotNumber: String(arr(lotsT, L.lotNumber)[i] || `Lot #${id}`),
        date: num(arr(lotsT, L.date)[i]),
        made, madeStored: madeRaw, onHand, hank, broken, alloc,
        vendor: num(arr(lotsT, L.vendor)[i]), store: num(arr(lotsT, L.store)[i]),
        binId: typeof binRaw === 'number' ? binRaw : refId(binRaw),
        binCode: typeof binRaw === 'string' ? binRaw : (binById[refId(binRaw)] || ''),
        waiting: Math.max(0, made - alloc - onHand - broken),
      });
    });

    return { cols: { L, A, WL, WO }, missing, recipes, customers, bins, binById, orders, lots,
      linesByRecipe, allocByLot };
  }

  /* Where back stock of this colourway already lives, so a new lot joins
     its bag rather than starting another. Falls back to the kettle's pick. */
  function suggestBin(model, lot) {
    const key = lot.recipe.name.toLowerCase();
    const tally = {};
    model.lots.forEach(l => {
      if (l.id === lot.id || !l.binId) return;
      if (l.recipe.name.toLowerCase() !== key) return;
      const have = l.onHand + l.hank;
      if (have > 0) tally[l.binId] = (tally[l.binId] || 0) + have;
    });
    const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : (lot.binId || null);
  }

  /* A default split: open orders first (soonest due), the rest to back
     stock in hank. Only a starting point; every number is editable. */
  function defaultPlan(model, lot) {
    let left = lot.waiting;
    const orders = (model.linesByRecipe[lot.recipe.id] || []).map(ln => {
      const take = Math.min(ln.short, left);
      left -= take;
      return { lineId: ln.lineId, qty: take, form: 'hank' };
    });
    return { orders, backWound: 0, backHank: left, binId: suggestBin(model, lot),
      listVendor: true, shortMeans: 'later' };
  }

  /* Turn a plan into Grist actions plus their inverse, for undo.
     plan = { orders:[{lineId, qty, form:'hank'|'wound'}], backWound, backHank,
              binId, listVendor, shortMeans:'later'|'final' }            */
  function putAwayActions(model, lot, plan) {
    const { L, A } = model.cols;
    const lines = {};
    (model.linesByRecipe[lot.recipe.id] || []).forEach(ln => { lines[ln.lineId] = ln; });
    const toOrders = plan.orders.filter(o => num(o.qty) > 0);
    const ordered = toOrders.reduce((t, o) => t + num(o.qty), 0);
    const bw = Math.max(0, Math.round(num(plan.backWound)));
    const bh = Math.max(0, Math.round(num(plan.backHank)));
    const total = ordered + bw + bh;
    const diff = total - lot.waiting;           // + more than expected, − fewer
    const problems = [];
    if (!total) problems.push('Nothing to put away.');
    toOrders.forEach(o => { if (!lines[o.lineId]) problems.push('That order line is no longer open.'); });
    if ((bw || bh) && !plan.binId && L.bin) problems.push('Pick a bin for the back stock.');

    const acts = [], undo = [];
    toOrders.forEach(o => {
      const ln = lines[o.lineId];
      const f = { [A.lot]: lot.id, [A.qty]: Math.round(num(o.qty)), [A.line]: o.lineId };
      if (A.status) f[A.status] = o.form === 'wound' ? ORDER_STATUS_WOUND : ORDER_STATUS_HANK;
      if (A.customer && ln && ln.order.customerId) f[A.customer] = ln.order.customerId;
      if (A.orderBin && ln && ln.bin) f[A.orderBin] = ln.bin;
      acts.push(['AddRecord', 'Lot_Allocations', null, f]);
    });

    // Spools_Made: start from what the lot really holds, correct for a count
    // that differs, then take back-stock hank out (it has not been wound).
    let made = lot.made;
    if (diff > 0 || (diff < 0 && plan.shortMeans === 'final')) made += diff;
    made -= bh;
    const before = {}, after = {};
    const set = (c, oldV, newV) => { if (c && oldV !== newV) { before[c] = oldV; after[c] = newV; } };
    set(L.made, lot.madeStored, Math.max(0, made));
    set(L.onHand, lot.onHand, lot.onHand + bw);
    set(L.hank, lot.hank, lot.hank + bh);
    if (plan.listVendor) set(L.vendor, lot.vendor, lot.vendor + bw + bh);
    if ((bw || bh) && plan.binId && L.bin) set(L.bin, lot.binId || 0, plan.binId);
    if (Object.keys(after).length) {
      acts.push(['UpdateRecord', 'Production_Lots', lot.id, after]);
      undo.push(['UpdateRecord', 'Production_Lots', lot.id, before]);
    }
    return { acts, undo, problems, total, diff, ordered, bw, bh,
      stillWaiting: diff < 0 && plan.shortMeans !== 'final' ? -diff : 0 };
  }

  /* Apply, and return an undo that also removes the allocations it added. */
  async function applyPutAway(docApi, built) {
    const res = await docApi.applyUserActions(built.acts);
    const ret = (res && res.retValues) || [];
    const undo = built.undo.slice();
    built.acts.forEach((a, i) => {
      if (a[0] === 'AddRecord' && a[1] === 'Lot_Allocations' && ret[i]) undo.unshift(['RemoveRecord', 'Lot_Allocations', ret[i]]);
    });
    return undo;
  }

  root.StockOps = { load, defaultPlan, suggestBin, putAwayActions, applyPutAway,
    orderBinCode, fiberCode, esc, num, ORDER_STATUS_HANK, ORDER_STATUS_WOUND };
})(typeof window !== 'undefined' ? window : globalThis);
