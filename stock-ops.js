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
  const BIN_CAPACITY = 60;   // spools a bin holds comfortably — same as the kettle and Wind & Box
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
      const bc = col(locT, ['Bin_Code']), bf = col(locT, ['Fiber']), br = col(locT, ['Reserved_For']),
        bm = col(locT, ['Max_Spools']);
      (locT.id || []).forEach((id, i) => {
        const code = String(arr(locT, bc)[i] || '').trim();
        if (!code) return;
        bins.push({ id, code, fiber: fiberCode(arr(locT, bf)[i]),
          reserved: !!refId(arr(locT, br)[i]), cap: num(arr(locT, bm)[i]) || BIN_CAPACITY });
        binById[id] = code;
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

    /* How full each bin is: everything filed to it — wound, hank, and thread
       not yet put away — the same count the kettle and Wind & Box use. Derived
       from the lots, never from a stored counter. */
    const binFill = {};
    lots.forEach(l => { if (l.binId) binFill[l.binId] = (binFill[l.binId] || 0) + l.onHand + l.hank + l.waiting; });

    return { cols: { L, A, WL, WO }, missing, recipes, customers, bins, binById, binFill, orders, lots,
      linesByRecipe, allocByLot };
  }

  /* ── Which bin ─────────────────────────────────────────────────────────
     The same rule the kettle and Wind & Box use, so stock ends up where it
     always has:
       1. where this colourway already lives, while that bin has room —
          keyed on the colourway NAME, so FF, E and cotton bag together;
       2. otherwise the emptiest bin for its fibre, skipping bins reserved
          for a customer;
       3. if every bin is full, the one with most room, flagged as tight.
     A bin holds BIN_CAPACITY spools unless Storage_Locations.Max_Spools says
     otherwise. This lot's own thread is left out of the fill it is checked
     against, so a lot is never "too big" for the bin it is already in. */
  function binFillFor(model, binId, lot) {
    let f = model.binFill[binId] || 0;
    if (lot && lot.binId === binId) f -= lot.onHand + lot.hank + lot.waiting;
    return Math.max(0, f);
  }
  function suggestBin(model, lot, qty) {
    const need = qty == null ? lot.waiting : qty;
    const byId = {}; model.bins.forEach(b => { byId[b.id] = b; });
    const cap = b => (b && b.cap) || BIN_CAPACITY;
    const key = lot.recipe.name.toLowerCase();
    const tally = {};
    model.lots.forEach(l => {
      if (l.id === lot.id || !l.binId || !byId[l.binId]) return;
      if (l.recipe.name.toLowerCase() !== key) return;
      const have = l.onHand + l.hank;
      if (have > 0) tally[l.binId] = (tally[l.binId] || 0) + have;
    });
    const knownId = Number((Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || [])[0]) || null;
    const known = knownId ? byId[knownId] : null;
    if (known && binFillFor(model, known.id, lot) + need <= cap(known)) {
      return { binId: known.id, reason: `where ${lot.recipe.name} already is`, tight: false };
    }
    const open = model.bins.filter(b => !b.reserved);
    let choices = open.filter(b => b.fiber && b.fiber === lot.fiber);
    if (!choices.length) choices = open;
    choices = choices.slice().sort((a, b) => (binFillFor(model, a.id, lot) - binFillFor(model, b.id, lot))
      || a.code.localeCompare(b.code, undefined, { numeric: true }));
    if (!choices.length) return { binId: lot.binId || null, reason: 'no bins set up', tight: true };
    const roomy = choices.find(b => binFillFor(model, b.id, lot) + need <= cap(b));
    if (!roomy) return { binId: choices[0].id, reason: 'every bin is full — this one has most room', tight: true };
    return { binId: roomy.id, tight: false,
      reason: known ? `${known.code} is full, so ${lot.recipe.name} moves here` : `emptiest ${lot.fiber || ''} bin`.replace('  ', ' ') };
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
    const sug = suggestBin(model, lot, left);
    return { orders, backWound: 0, backHank: left, binId: sug.binId, binWhy: sug.reason, binTight: sug.tight,
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


  /* ── Log a pot that is not on any order ───────────────────────────────────
     Creates the lot exactly as the kettle does — lot number, colourway,
     dyed spools as Spools_Made, yardage, fibre, date — so it lands in the Lot
     Desk's waiting list and is put away like any other lot. Marked as on the
     dry rack (not wet), so screens that still read drying status treat it as
     available rather than hiding it. */
  function lotNumberFor(existing) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const prefix = 'LOT-' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate()) + '-';
    let max = 0;
    existing.forEach(v => {
      const s = String(v || '');
      if (s.indexOf(prefix) === 0) { const n = parseInt(s.slice(prefix.length), 10); if (!isNaN(n) && n > max) max = n; }
    });
    return prefix + (max + 1);
  }
  async function logPot(docApi, recipe, spools) {
    const n = Math.round(num(spools));
    if (!recipe || (!recipe.id && !recipe.create)) throw new Error('Pick a colourway');
    if (n <= 0) throw new Error('Enter how many spools');
    /* The E version of an FF colourway, made on the spot: same dye, longer
       spool, so it needs a Recipes row only for its SKU and count. Written
       before the lot that points at it. Only E — cotton is a real recipe and
       is never conjured. */
    if (recipe.create) {
      const res = await docApi.applyUserActions([['AddRecord', 'Recipes', null, recipe.create]]);
      const newId = res && res.retValues && res.retValues[0];
      if (!newId) throw new Error('Could not create the E version');
      recipe = Object.assign({}, recipe, { id: newId, create: null });
    }
    const lotsT = await docApi.fetchTable('Production_Lots');
    const L = {
      lotNumber: col(lotsT, ['Lot_Number']), recipe: col(lotsT, ['Recipe']), date: col(lotsT, ['Date_Dyed']),
      fiber: col(lotsT, ['Fiber']), yards: col(lotsT, ['Total_Yards_Made']), made: col(lotsT, ['Spools_Made']),
      drying: col(lotsT, ['Drying_Status']), notes: col(lotsT, ['Notes']),
    };
    if (!L.lotNumber || !L.made) throw new Error('Production_Lots needs Lot_Number and Spools_Made');
    const lotNumber = lotNumberFor(arr(lotsT, L.lotNumber));
    const d = new Date();
    const f = { [L.lotNumber]: lotNumber, [L.made]: n };
    if (L.recipe) f[L.recipe] = recipe.id;
    if (L.yards) f[L.yards] = n * yardsPerSpool(recipe.fiber);
    if (L.fiber && recipe.fiber) f[L.fiber] = recipe.fiber;
    if (L.date) f[L.date] = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 1000;
    if (L.drying) f[L.drying] = 'Drying - Dry Rack';
    if (L.notes) f[L.notes] = 'Logged as a pot with no order';
    const res = await docApi.applyUserActions([['AddRecord', 'Production_Lots', null, f]]);
    return { lotId: res && res.retValues && res.retValues[0], lotNumber, spools: n };
  }

  /* The pop-up both pages use. Self-contained (it brings its own styles), so
     the Lot Desk and Morning Batch Planning show exactly the same thing. */
  async function openLogPot(docApi, onDone) {
    if (!document.getElementById('so-pot-style')) {
      const st = document.createElement('style'); st.id = 'so-pot-style';
      st.textContent = `
.so-ov{position:fixed;inset:0;background:rgba(26,22,20,.45);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:40px 14px}
.so-box{background:#fff;border-radius:10px;width:100%;max-width:420px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:Inter,sans-serif;color:#1A1614;color-scheme:light}
.so-box h4{font-family:'Libre Baskerville',serif;font-size:16px;margin:0 0 2px}
.so-box .so-sub{font-size:11.5px;color:#8B7D72;margin-bottom:12px}
.so-box label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8B7D72;margin:10px 0 4px}
.so-box input{width:100%;box-sizing:border-box;padding:9px 10px;border:1.5px solid #D4C9BC;border-radius:6px;font:inherit;font-size:14px;background:#fff;color:#1A1614}
.so-box input:focus{outline:none;border-color:#3A8B7A}
.so-box input.so-n{width:110px;font-family:'DM Mono',monospace;font-size:20px;text-align:center}
.so-list{border:1px solid #E8DFD4;border-radius:6px;margin-top:4px;max-height:230px;overflow:auto}
.so-opt{padding:7px 10px;cursor:pointer;border-bottom:1px solid #F3EDE5;font-size:13px;display:flex;gap:8px;align-items:center}
.so-opt:hover,.so-opt.on{background:#E5F2EF}
.so-opt small{margin-left:auto;font-family:'DM Mono',monospace;font-size:10.5px;color:#8B7D72}
.so-picked{padding:8px 10px;background:#E5F2EF;border-radius:6px;font-weight:600;font-size:13px;display:flex;gap:8px;align-items:center}
.so-picked a{margin-left:auto;font-weight:400;font-size:11px;color:#8B3A2A;cursor:pointer;text-decoration:underline}
.so-fib{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:4px;background:#E8DFD4;color:#6B5E52}
.so-row{display:flex;gap:8px;margin-top:14px;justify-content:flex-end}
.so-row button{font:inherit;font-size:12.5px;font-weight:600;padding:9px 16px;border-radius:6px;cursor:pointer;border:1px solid #3A8B7A;background:#3A8B7A;color:#fff}
.so-row button.so-x{background:#fff;color:#1A1614;border-color:#D4C9BC;font-weight:500}
.so-row button:disabled{opacity:.45;cursor:default}
.so-err{color:#8B3A2A;font-size:12px;margin-top:8px}`;
      document.head.appendChild(st);
    }
    const ov = document.createElement('div'); ov.className = 'so-ov';
    ov.innerHTML = `<div class="so-box"><h4>Log a pot</h4>
      <div class="so-sub">Thread dyed without an order. It goes to the Lot Desk to be put away.</div>
      <label>Colourway</label><div id="so-pick"><input id="so-q" placeholder="Type a colourway or SKU…" autocomplete="off"><div class="so-list" id="so-list"></div></div>
      <label>Spools dyed</label><input id="so-n" class="so-n" type="number" min="1" placeholder="0">
      <div class="so-err" id="so-err"></div>
      <div class="so-row"><button class="so-x" id="so-cancel">Cancel</button><button id="so-go" disabled>Log pot</button></div></div>`;
    document.body.appendChild(ov);
    const $ = id => ov.querySelector('#' + id);
    const close = () => ov.remove();
    $('so-cancel').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });

    let recipes = [], chosen = null, hi = 0, shown = [];
    try {
      const t = await docApi.fetchTable('Recipes');
      const n = col(t, ['Recipe_Name']), k = col(t, ['SKU_Base']), fb = col(t, ['Fiber_Type']), md = col(t, ['Dye_Method']);
      recipes = (t.id || []).map((id, i) => ({ id, name: String(arr(t, n)[i] || ''), sku: String(arr(t, k)[i] || ''),
        fiber: fiberCode(arr(t, fb)[i]), method: md ? arr(t, md)[i] : null })).filter(r => r.sku && r.name);
      // FF colourways with no E row yet: offer "— E (new)", created on save.
      if (n && k && fb) {
        const hasE = new Set(recipes.filter(r => r.fiber === 'EN').map(r => r.name.toLowerCase()));
        recipes.filter(r => r.fiber === 'FFN' && r.sku.indexOf('_') > 0 && !hasE.has(r.name.toLowerCase())).forEach(r => {
          const sku = 'EN' + r.sku.slice(r.sku.indexOf('_'));
          const create = { [n]: r.name, [k]: sku, [fb]: 'E Nylon' };
          if (md && r.method) create[md] = r.method;
          recipes.push({ id: null, name: r.name, sku, fiber: 'EN', isNew: true, create });
        });
      }
      recipes.sort((a, b) => a.name.localeCompare(b.name) || (a.isNew ? 1 : 0) - (b.isNew ? 1 : 0));
    } catch (e) { $('so-err').textContent = 'Could not read Recipes'; }

    const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const ready = () => { $('so-go').disabled = !(chosen && num($('so-n').value) > 0); };
    const drawList = () => {
      const q = fold($('so-q').value).trim();
      shown = (q ? recipes.filter(r => fold(r.name).includes(q) || fold(r.sku).includes(q)) : recipes).slice(0, 12);
      hi = Math.min(hi, Math.max(0, shown.length - 1));
      $('so-list').innerHTML = shown.map((r, i) => `<div class="so-opt ${i === hi ? 'on' : ''}" data-i="${i}">${esc(r.name)}
        ${r.fiber ? `<span class="so-fib">${esc(r.fiber)}</span>` : ''}${r.isNew ? '<span class="so-fib" style="background:#F5EDD8;color:#B07D2A">new</span>' : ''}<small>${esc(r.sku)}</small></div>`).join('')
        || '<div class="so-opt" style="cursor:default;color:#8B7D72">No match</div>';
      $('so-list').querySelectorAll('[data-i]').forEach(el => el.onclick = () => choose(shown[Number(el.dataset.i)]));
    };
    const choose = (r) => {
      if (!r) return;
      chosen = r;
      $('so-pick').innerHTML = `<div class="so-picked">${esc(r.name)} ${r.fiber ? `<span class="so-fib">${esc(r.fiber)}</span>` : ''}
        <span style="font-family:'DM Mono',monospace;font-size:10.5px;color:#6B5E52">${esc(r.sku)}</span><a id="so-change">change</a></div>
        ${r.isNew ? `<div style="font-size:11px;color:#B07D2A;margin-top:5px">No E version of ${esc(r.name)} yet — it will be created (same dye as the FF, SKU ${esc(r.sku)}).</div>` : ''}`;
      $('so-change').onclick = () => { chosen = null; $('so-pick').innerHTML = `<input id="so-q" placeholder="Type a colourway or SKU…" autocomplete="off"><div class="so-list" id="so-list"></div>`; wire(); ready(); };
      $('so-n').focus(); ready();
    };
    const wire = () => {
      const q = $('so-q');
      q.oninput = () => { hi = 0; drawList(); };
      q.onkeydown = e => {
        if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, shown.length - 1); drawList(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); drawList(); e.preventDefault(); }
        else if (e.key === 'Enter') { choose(shown[hi]); e.preventDefault(); }
        else if (e.key === 'Escape') close();
      };
      drawList(); q.focus();
    };
    wire();
    $('so-n').oninput = ready;
    $('so-n').onkeydown = e => { if (e.key === 'Enter' && !$('so-go').disabled) $('so-go').click(); if (e.key === 'Escape') close(); };
    $('so-go').onclick = async () => {
      $('so-go').disabled = true; $('so-err').textContent = '';
      try {
        const r = await logPot(docApi, chosen, $('so-n').value);
        close();
        if (onDone) onDone(r, chosen);
      } catch (e) {
        console.error('Log pot failed', e);
        $('so-err').textContent = (e && e.message) || 'Could not log it — nothing was added';
        ready();
      }
    };
  }

  root.StockOps = { load, defaultPlan, suggestBin, binFillFor, putAwayActions, applyPutAway, logPot, openLogPot,
    orderBinCode, fiberCode, esc, num, ORDER_STATUS_HANK, ORDER_STATUS_WOUND };
})(typeof window !== 'undefined' ? window : globalThis);
