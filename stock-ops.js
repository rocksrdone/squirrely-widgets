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
    const [lotsT, allocT, wolT, woT, recT, custT, locT, taskT] = await Promise.all([
      fetch('Production_Lots'), fetch('Lot_Allocations'), fetch('Work_Order_Lines'),
      fetch('Work_Orders'), fetch('Recipes'), optional('Customers'), optional('Storage_Locations'),
      optional('Worker_Tasks'),
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
    const allocByLot = {}, allocByLine = {}, allocListByLot = {};
    (allocT.id || []).forEach((id, i) => {
      const q = num(arr(allocT, A.qty)[i]);
      const lot = refId(arr(allocT, A.lot)[i]);
      const line = refId(arr(allocT, A.line)[i]);
      if (lot) allocByLot[lot] = (allocByLot[lot] || 0) + q;
      if (lot) (allocListByLot[lot] = allocListByLot[lot] || []).push({ qty: q,
        bin: String(arr(allocT, A.orderBin)[i] || ''), status: String(arr(allocT, A.status)[i] || '') });
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

    // Job progress per lot, so a put-away lot shows whether it was physically done.
    const jobsByLot = {};
    const TC = taskCols(taskT);
    if (TC && TC.lot) (taskT.id || []).forEach((id, i) => {
      const lot = refId(arr(taskT, TC.lot)[i]);
      if (!lot) return;
      const st = String(arr(taskT, TC.status)[i] || '');
      const j = jobsByLot[lot] = jobsByLot[lot] || { open: 0, done: 0, problem: 0 };
      if (st === 'To do') j.open++; else if (st === 'Problem') j.problem++; else j.done++;
    });
    // Jobs a worker flagged — the Lot Desk lists these for fixing.
    const problems = [];
    const taskRows = TC && TC.lot ? (taskT.id || []).map((id, i) => ({ id, lotId: refId(arr(taskT, TC.lot)[i]) })) : [];
    if (TC) (taskT.id || []).forEach((id, i) => {
      if (String(arr(taskT, TC.status)[i] || '') !== 'Problem') return;
      const g = (c) => c ? arr(taskT, c)[i] : null;
      const found = g(TC.found);
      problems.push({ id, type: String(g(TC.type) || ''), text: String(g(TC.instruction) || ''),
        lotId: refId(g(TC.lot)), recipeId: refId(g(TC.recipe)), qty: g(TC.qty) == null ? null : num(g(TC.qty)),
        form: String(g(TC.form) || ''), bin: String(g(TC.bin) || ''), sku: String(g(TC.sku) || ''),
        storeQty: g(TC.storeQty), found: found == null || found === '' ? null : num(found),
        note: String(g(TC.note) || ''), created: num(g(TC.created)) });
    });

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
        made, madeStored: madeRaw, onHand, hank, broken, alloc, notes: String(arr(lotsT, L.notes)[i] || ''),
        vendor: num(arr(lotsT, L.vendor)[i]), store: num(arr(lotsT, L.store)[i]),
        binId: typeof binRaw === 'number' ? binRaw : refId(binRaw),
        binCode: typeof binRaw === 'string' ? binRaw : (binById[refId(binRaw)] || ''),
        waiting: Math.max(0, made - alloc - onHand - broken),
        allocs: allocListByLot[id] || [],
        jobs: jobsByLot[id] || { open: 0, done: 0, problem: 0 },
      });
    });

    /* How full each bin is: everything filed to it — wound, hank, and thread
       not yet put away — the same count the kettle and Wind & Box use. Derived
       from the lots, never from a stored counter. */
    const binFill = {};
    lots.forEach(l => { if (l.binId) binFill[l.binId] = (binFill[l.binId] || 0) + l.onHand + l.hank + l.waiting; });

    return { cols: { L, A, WL, WO, T: taskCols(taskT) }, missing, recipes, customers, bins, binById, binFill, orders, lots, problems, taskRows,
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

    /* A job for whoever does it physically. Grist is already right once this
       saves; the job is the bag actually landing where Grist says it is. */
    const T = model.cols.T;
    if (T) {
      const tag = `${lot.lotNumber} ${lot.recipe.name}${lot.fiber ? ' ' + lot.fiber : ''}`;
      toOrders.forEach(o => {
        const ln = lines[o.lineId];
        const form = o.form === 'wound' ? 'Wound' : 'Hank';
        acts.push(['AddRecord', 'Worker_Tasks', null, taskFields(T, {
          type: 'Put away', lotId: lot.id, recipeId: lot.recipe.id, qty: Math.round(num(o.qty)), form,
          bin: (ln && ln.bin) || '', sku: lot.recipe.sku,
          instruction: `${tag}: ${Math.round(num(o.qty))} ${form.toLowerCase()} → ${ln ? `order ${ln.order.number} ${ln.order.customerName}` : 'order'}${ln && ln.bin ? ` (bin ${ln.bin})` : ''}`,
        })]);
      });
      const binCode = model.binById[plan.binId] || '';
      [['Wound', bw], ['Hank', bh]].forEach(([form, q]) => {
        if (!q) return;
        acts.push(['AddRecord', 'Worker_Tasks', null, taskFields(T, {
          type: 'Put away', lotId: lot.id, recipeId: lot.recipe.id, qty: q, form, bin: binCode, sku: lot.recipe.sku,
          instruction: `${tag}: ${q} ${form.toLowerCase()} → back stock bin ${binCode || '(no bin)'}`,
        })]);
      });
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
      if (a[0] === 'AddRecord' && ret[i]) undo.unshift(['RemoveRecord', a[1], ret[i]]);
    });
    return undo;
  }

  /* ── Worker jobs (Worker_Tasks) ────────────────────────────────────────── */
  function taskCols(t) {
    if (!t) return null;
    const c = {
      created: col(t, ['Created']), type: col(t, ['Type']), instruction: col(t, ['Instruction']),
      lot: col(t, ['Lot']), recipe: col(t, ['Recipe']), qty: col(t, ['Qty']), form: col(t, ['Form']),
      bin: col(t, ['Bin']), sku: col(t, ['SKU']), storeQty: col(t, ['Store_Qty']), status: col(t, ['Status']),
      found: col(t, ['Found_Qty']), note: col(t, ['Worker_Note']), doneAt: col(t, ['Done_At']),
    };
    return c.type && c.instruction && c.status ? c : null;
  }
  function taskFields(T, j) {
    const f = {};
    const put = (k, v) => { if (T[k] && v != null && v !== '') f[T[k]] = v; };
    put('created', Math.floor(Date.now() / 1000));
    put('type', j.type); put('instruction', j.instruction); put('lot', j.lotId); put('recipe', j.recipeId);
    put('qty', j.qty); put('form', j.form); put('bin', j.bin); put('sku', j.sku); put('storeQty', j.storeQty);
    put('status', 'To do');
    return f;
  }
  async function loadTaskCols(docApi) {
    try { return taskCols(await docApi.fetchTable('Worker_Tasks')); } catch (e) { return null; }
  }

  /* ── PDF helper, shared ───────────────────────────────────────────────── */
  const PDF_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js',
  ];
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script'); el.src = src; el.onload = resolve;
      el.onerror = () => reject(new Error('could not load the PDF library')); document.head.appendChild(el);
    });
  }
  async function pdfLib() {
    if (!(root.jspdf && root.jspdf.jsPDF)) await loadScript(PDF_LIBS[0]);
    if (!root.jspdf.jsPDF.API.autoTable) await loadScript(PDF_LIBS[1]);
    return root.jspdf.jsPDF;
  }
  function pdfSafe(s) {
    return String(s == null ? '' : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-').replace(/\u2192/g, '->').replace(/\u00D7/g, 'x')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '?');
  }
  function downloadPdf(doc, name) {
    const url = URL.createObjectURL(doc.output('blob'));
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function ymd(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

  /* ── End-of-day: pots logged with "Log a pot" (not on the day's list) ─────
     One row per lot, with room to note the bag label. Lots are found by the
     note Log a pot writes, dyed on the chosen day. */
  async function extraPots(docApi, day) {
    const [lotsT, recT, locT] = await Promise.all([docApi.fetchTable('Production_Lots'),
      docApi.fetchTable('Recipes'), docApi.fetchTable('Storage_Locations').catch(() => null)]);
    const L = { num: col(lotsT, ['Lot_Number']), rec: col(lotsT, ['Recipe']), date: col(lotsT, ['Date_Dyed']),
      notes: col(lotsT, ['Notes']), made: col(lotsT, ['Spools_Made']), on: col(lotsT, ['On_Hand_Spools']),
      hank: col(lotsT, ['Hank_Est_Spools']), fib: col(lotsT, ['Fiber']), bin: col(lotsT, ['Storage_Bin']) };
    const rn = col(recT, ['Recipe_Name']), rs = col(recT, ['SKU_Base']);
    const recs = {}; (recT.id || []).forEach((id, i) => { recs[id] = { name: arr(recT, rn)[i], sku: arr(recT, rs)[i] }; });
    const bins = {}; if (locT) { const bc = col(locT, ['Bin_Code']); (locT.id || []).forEach((id, i) => { bins[id] = arr(locT, bc)[i]; }); }
    const want = ymd(day);
    const out = [];
    (lotsT.id || []).forEach((id, i) => {
      if (!/logged as a pot with no order/i.test(String(arr(lotsT, L.notes)[i] || ''))) return;
      const d = num(arr(lotsT, L.date)[i]);
      if (!d || new Date(d * 1000).toISOString().slice(0, 10) !== want) return;
      const r = recs[refId(arr(lotsT, L.rec)[i])] || {};
      const binId = refId(arr(lotsT, L.bin)[i]);
      out.push({ lot: arr(lotsT, L.num)[i], name: r.name || '', sku: r.sku || '', fiber: arr(lotsT, L.fib)[i] || '',
        spools: num(arr(lotsT, L.made)[i]) + num(arr(lotsT, L.hank)[i]), bin: bins[binId] || '' });
    });
    return out.sort((a, b) => String(a.lot).localeCompare(String(b.lot), undefined, { numeric: true }));
  }
  async function printExtraPots(docApi, day) {
    day = day || new Date();
    const rows = await extraPots(docApi, day);
    if (!rows.length) return 0;
    const JsPDF = await pdfLib();
    const doc = new JsPDF({ unit: 'pt', format: 'letter' });
    const M = 36, W = doc.internal.pageSize.getWidth();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('Extra pots', M, M + 6);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(139, 125, 114);
    doc.text(pdfSafe(`Logged ${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} - not on the day's list. Label these bags.`), M, M + 22);
    doc.setTextColor(26, 22, 20);
    doc.autoTable({
      startY: M + 34, margin: { left: M, right: M },
      head: [['Lot', 'Colourway', 'Fibre', 'SKU', 'Spools', 'Bin', 'Labelled']],
      body: rows.map(r => [r.lot, pdfSafe(r.name), r.fiber, r.sku, String(r.spools), r.bin || '-', '']),
      theme: 'grid', styles: { font: 'helvetica', fontSize: 10, cellPadding: 6, lineColor: [212, 201, 188], lineWidth: 0.5, valign: 'middle' },
      headStyles: { fillColor: [26, 22, 20], textColor: 255, fontSize: 8.5 },
      columnStyles: { 0: { font: 'courier', fontSize: 9 }, 1: { fontStyle: 'bold' }, 3: { font: 'courier', fontSize: 8.5, textColor: [139, 125, 114] },
        4: { halign: 'center', fontStyle: 'bold' }, 5: { halign: 'center' }, 6: { cellWidth: 52 } },
      didDrawCell: h => { if (h.section === 'body' && h.column.index === 6) { const c = h.cell; doc.setDrawColor(26, 22, 20); doc.rect(c.x + c.width / 2 - 6, c.y + c.height / 2 - 6, 12, 12); } },
    });
    downloadPdf(doc, `extra-pots-${ymd(day)}.pdf`);
    return rows.length;
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


  /* ── Vendor store: check, set, and links ──────────────────────────────────
     Talks to "SS - Vendor Stock (check and set)". Check first shows what the
     store has; Set sends the new number with the one you were shown, and
     Shopify refuses if the store moved in between — so a sale made while you
     looked is never overwritten. Nothing is sent without a click. */
  const VENDOR_STOCK_URL = 'https://squirrelystash.app.n8n.cloud/webhook/vendor-stock';
  async function vendorCall(body) {
    let r;
    try {
      r = await fetch(VENDOR_STOCK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), cache: 'no-store' });
    } catch (e) { return { ok: false, error: 'Could not reach n8n — is the "SS - Vendor Stock" workflow imported and active?' }; }
    if (r.status === 404) return { ok: false, error: 'The "SS - Vendor Stock (check and set)" workflow is not imported or not active in n8n yet.' };
    if (!r.ok) return { ok: false, error: `n8n answered ${r.status}.` };
    try { return await r.json(); } catch (e) { return { ok: false, error: 'n8n sent back something unreadable.' }; }
  }
  function vendorCheck(sku) { return vendorCall({ mode: 'check', sku }); }
  function vendorSet(sku, quantity, expect) { return vendorCall({ mode: 'set', sku, quantity, expect }); }

  /* ── Bring Grist in line after the vendor store was set to a different number ──
     delta = new store number − what Grist expected. The kind says WHY, because
     that decides which counts move:
       fewer:  hank  → those hanks aren't there: Hank −n, Vendor −n
               wound → those spools aren't there: On hand −n, Broken +n, Vendor −n
                       (Broken keeps the lot's "still waiting" sum unchanged)
               hold  → they're there, just not for the vendor store: Vendor −n
       more:   general → list n from unlisted stock: Vendor +n
               hank    → found n more hanks: Hank +n, Vendor +n
               wound   → found n more spools: On hand +n, Made +n, Vendor +n
     Newest lots are taken from first. Nothing changes unless all n fit. */
  async function vendorGristFix(docApi, sku, delta, kind) {
    const [lotsT, recT] = await Promise.all([docApi.fetchTable('Production_Lots'), docApi.fetchTable('Recipes')]);
    const rs = col(recT, ['SKU_Base']);
    const want = String(sku || '').trim().toUpperCase();
    const recIds = (recT.id || []).filter((id, i) => String(arr(recT, rs)[i] || '').trim().toUpperCase() === want);
    if (!recIds.length) return { ok: false, error: `No recipe in Grist has the SKU ${sku}.` };
    const C = { recipe: col(lotsT, ['Recipe']), date: col(lotsT, ['Date_Dyed']), v: col(lotsT, ['Vendor_Stock_Spools']),
      s: col(lotsT, ['Store_Stock_Spools']), oh: col(lotsT, ['On_Hand_Spools']), hank: col(lotsT, ['Hank_Est_Spools']),
      made: col(lotsT, ['Spools_Made']), broken: col(lotsT, ['Broken_Spools']), notes: col(lotsT, ['Notes']),
      lot: col(lotsT, ['Lot_Number']) };
    if (!C.v) return { ok: false, error: 'Production_Lots has no Vendor_Stock_Spools column.' };
    const g = (c, i) => num(arr(lotsT, c)[i]);
    const rows = (lotsT.id || []).map((id, i) => ({ id, i, rec: refId(arr(lotsT, C.recipe)[i]) }))
      .filter(r => recIds.includes(r.rec))
      .map(r => ({ id: r.id, lot: String(arr(lotsT, C.lot)[r.i] || ''), date: num(arr(lotsT, C.date)[r.i]),
        v: g(C.v, r.i), s: g(C.s, r.i), oh: g(C.oh, r.i), hank: g(C.hank, r.i), made: g(C.made, r.i),
        broken: g(C.broken, r.i), notes: String(arr(lotsT, C.notes)[r.i] || '') }))
      .sort((a, b) => (b.date - a.date) || (b.id - a.id));
    if (!rows.length) return { ok: false, error: `No lots of ${sku} in Grist.` };

    let need = Math.abs(delta);
    const plan = [];          // { row, fields, text }
    const step = (row, x, fields, text) => { if (x > 0) { plan.push({ row, fields, text }); need -= x; } };
    if (delta < 0) {
      for (const r of rows) {
        if (!need) break;
        if (kind === 'hank') { const x = Math.min(need, r.hank, r.v); step(r, x, { hank: r.hank - x, v: r.v - x }, `−${x} hank (not there)`); }
        else if (kind === 'wound') {
          if (!C.broken) return { ok: false, error: 'Production_Lots has no Broken_Spools column.' };
          const x = Math.min(need, r.oh, r.v); step(r, x, { oh: r.oh - x, broken: r.broken + x, v: r.v - x }, `−${x} wound (not there)`);
        }
        else { const x = Math.min(need, r.v); step(r, x, { v: r.v - x }, `${x} taken off the vendor store`); }
      }
    } else if (kind === 'general') {
      for (const r of rows) {
        if (!need) break;
        const x = Math.min(need, Math.max(0, r.oh + r.hank - r.v - r.s));
        step(r, x, { v: r.v + x }, `${x} more listed on the vendor store`);
      }
    } else {
      const r = rows[0];
      step(r, need, kind === 'wound' ? { oh: r.oh + need, made: r.made + need, v: r.v + need } : { hank: r.hank + need, v: r.v + need },
        `+${need} ${kind === 'wound' ? 'wound' : 'hank'} found`);
    }
    if (need > 0) {
      const what = { hank: 'hank listed on the vendor store', wound: 'wound listed on the vendor store', hold: 'listed on the vendor store',
        general: 'unlisted spools to add' }[kind] || 'room';
      return { ok: false, error: `Grist doesn't have ${Math.abs(delta)} ${what} for ${sku} — fix the lot by hand.` };
    }
    const key = { v: C.v, oh: C.oh, hank: C.hank, made: C.made, broken: C.broken };
    const day = new Date().toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    const actions = [], undo = [];
    for (const p of plan) {
      const upd = {}, old = {};
      for (const k in p.fields) { upd[key[k]] = p.fields[k]; old[key[k]] = p.row[k]; }
      if (C.notes) { upd[C.notes] = (p.row.notes ? p.row.notes + '\n' : '') + `${day} vendor store count: ${p.text}`; old[C.notes] = p.row.notes; }
      actions.push(['UpdateRecord', 'Production_Lots', p.row.id, upd]);
      undo.push(['UpdateRecord', 'Production_Lots', p.row.id, old]);
    }
    await docApi.applyUserActions(actions);
    return { ok: true, text: plan.map(p => `${p.row.lot}: ${p.text}`).join(' · '), undo };
  }

  /* ── Correct one lot's shelf count (from a job problem) ──────────────────
     form 'Hank' | 'Wound'; delta = found − expected.
       more hank:   Hank +n            (+ Vendor +n when list)
       more wound:  On hand +n, Made +n (+ Vendor +n when list)  — Made keeps "waiting" at 0
       fewer hank:  Hank −n
       fewer wound: On hand −n, Broken +n                           — Broken keeps "waiting" at 0
     When fewer, the vendor listing drops only as far as needed so it never
     lists more than is on the shelf. Returns { ok, text, undo, vendorBefore, vendorAfter }. */
  async function lotCountFix(docApi, lotId, form, delta, list) {
    const t = await docApi.fetchTable('Production_Lots');
    const i = (t.id || []).indexOf(lotId);
    if (i < 0) return { ok: false, error: 'That lot is no longer in Grist.' };
    const C = { v: col(t, ['Vendor_Stock_Spools']), s: col(t, ['Store_Stock_Spools']), oh: col(t, ['On_Hand_Spools']),
      hank: col(t, ['Hank_Est_Spools']), made: col(t, ['Spools_Made']), broken: col(t, ['Broken_Spools']),
      notes: col(t, ['Notes']), lot: col(t, ['Lot_Number']) };
    const g = (c) => num(arr(t, c)[i]);
    const r = { v: g(C.v), s: g(C.s), oh: g(C.oh), hank: g(C.hank), made: g(C.made), broken: g(C.broken) };
    const wound = /wound/i.test(form);
    const n = Math.abs(Math.round(delta));
    if (!n) return { ok: false, error: 'Nothing to change.' };
    const nx = Object.assign({}, r);
    if (delta > 0) {
      if (wound) { nx.oh += n; nx.made += n; } else nx.hank += n;
      if (list) nx.v += n;
    } else {
      if (wound) {
        if (r.oh < n) return { ok: false, error: `Grist only has ${r.oh} wound on this lot.` };
        if (!C.broken) return { ok: false, error: 'Production_Lots has no Broken_Spools column.' };
        nx.oh -= n; nx.broken += n;
      } else {
        if (r.hank < n) return { ok: false, error: `Grist only has ${r.hank} hank on this lot.` };
        nx.hank -= n;
      }
      nx.v = Math.min(r.v, Math.max(0, nx.oh + nx.hank - r.s));
    }
    const key = { v: C.v, oh: C.oh, hank: C.hank, made: C.made, broken: C.broken };
    const upd = {}, old = {};
    for (const k in key) if (key[k] && nx[k] !== r[k]) { upd[key[k]] = nx[k]; old[key[k]] = r[k]; }
    const text = `${delta > 0 ? '+' : '−'}${n} ${wound ? 'wound' : 'hank'}${nx.v !== r.v ? ` · vendor ${r.v} → ${nx.v}` : ''}`;
    if (C.notes) {
      const prev = String(arr(t, C.notes)[i] || '');
      const day = new Date().toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
      upd[C.notes] = (prev ? prev + '\n' : '') + `${day} count fixed from job problem: ${text}`;
      old[C.notes] = prev;
    }
    await docApi.applyUserActions([['UpdateRecord', 'Production_Lots', lotId, upd]]);
    return { ok: true, text, lot: String(arr(t, C.lot)[i] || ''), undo: [['UpdateRecord', 'Production_Lots', lotId, old]],
      vendorBefore: r.v, vendorAfter: nx.v };
  }

  /* ── Fix a lot by hand: set what's really on the shelf ────────────────────
     want = { wound, hank, vendor }. Wound going down → the difference goes to
     Broken; going up → Made goes up by the same. Either way the lot's "still
     waiting" sum doesn't move, so it never pops back onto the waiting list.
     Vendor is capped at what's on the shelf less the retail store's share. */
  function lotSetActions(lot, want, why) {
    const w = Math.max(0, Math.round(num(want.wound))), h = Math.max(0, Math.round(num(want.hank)));
    const cap = Math.max(0, w + h - lot.store);
    const v = Math.min(Math.max(0, Math.round(num(want.vendor))), cap);
    const upd = {}, old = {}, said = [];
    const put = (c, nv, ov) => { if (nv !== ov) { upd[c] = nv; old[c] = ov; } };
    if (w < lot.onHand) { put('Broken_Spools', lot.broken + (lot.onHand - w), lot.broken); said.push(`wound ${lot.onHand} → ${w}`); }
    if (w > lot.onHand) { put('Spools_Made', lot.made + (w - lot.onHand), lot.madeStored); said.push(`wound ${lot.onHand} → ${w}`); }
    put('On_Hand_Spools', w, lot.onHand);
    put('Hank_Est_Spools', h, lot.hank); if (h !== lot.hank) said.push(`hank ${lot.hank} → ${h}`);
    put('Vendor_Stock_Spools', v, lot.vendor); if (v !== lot.vendor) said.push(`vendor ${lot.vendor} → ${v}`);
    if (!w && !h && lot.binId) put('Storage_Bin', 0, lot.binId);
    if (!said.length) return null;
    const day = new Date().toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
    const text = said.join(', ') + (why ? ` (${why})` : '');
    put('Notes', (lot.notes ? lot.notes + '\n' : '') + `${day} counts fixed: ${text}`, lot.notes || '');
    return { acts: [['UpdateRecord', 'Production_Lots', lot.id, upd]], undo: [['UpdateRecord', 'Production_Lots', lot.id, old]],
      text, vendorAfter: v, capped: num(want.vendor) > cap };
  }
  /* A lot entered twice: remove it and its jobs. Refused while orders hold its spools. */
  function lotDeleteActions(model, lot) {
    if (lot.allocs.length) return { error: `${lot.lotNumber} has spools on ${lot.allocs.length} order line${lot.allocs.length === 1 ? '' : 's'} — move or remove those first.` };
    const acts = [];
    const T = model.cols.T;
    if (T && T.lot) model.taskRows.filter(t => t.lotId === lot.id).forEach(t => acts.push(['RemoveRecord', 'Worker_Tasks', t.id]));
    acts.push(['RemoveRecord', 'Production_Lots', lot.id]);
    return { acts };
  }

  function openVendorStock(sku, opts) {
    opts = opts || {};
    if (!document.getElementById('so-vs-style')) {
      const st = document.createElement('style'); st.id = 'so-vs-style';
      st.textContent = `
.so-ov{position:fixed;inset:0;background:rgba(26,22,20,.45);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:40px 14px}
.so-box{background:#fff;border-radius:10px;width:100%;max-width:440px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:Inter,sans-serif;color:#1A1614;color-scheme:light}
.so-box h4{font-family:'Libre Baskerville',serif;font-size:16px;margin:0 0 2px}
.so-sub{font-size:11.5px;color:#8B7D72;margin-bottom:12px;font-family:'DM Mono',monospace}
.vs-nums{display:flex;gap:10px;margin-bottom:12px}
.vs-n{flex:1;border:1px solid #E8DFD4;border-radius:8px;padding:8px 10px;background:#F7F3EE}
.vs-n b{display:block;font-family:'DM Mono',monospace;font-size:24px}
.vs-n span{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8B7D72}
.vs-set{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.vs-set input{width:90px;padding:8px;border:1.5px solid #D4C9BC;border-radius:6px;font-family:'DM Mono',monospace;font-size:18px;text-align:center;background:#fff;color:#1A1614}
.vs-btn{font:inherit;font-size:12.5px;font-weight:600;padding:9px 14px;border-radius:6px;cursor:pointer;border:1px solid #5B4A8B;background:#5B4A8B;color:#fff}
.vs-btn.ghost{background:#fff;color:#1A1614;border-color:#D4C9BC;font-weight:500}
.vs-btn:disabled{opacity:.45;cursor:default}
.vs-links{display:flex;gap:12px;margin-top:14px;font-size:12.5px;flex-wrap:wrap}
.vs-links a{color:#5B4A8B;font-weight:600}
.vs-msg{margin-top:10px;font-size:12.5px}
.vs-msg.bad{color:#8B3A2A;font-weight:600}.vs-msg.ok{color:#3A8B7A;font-weight:600}
.vs-fix{margin-top:12px;padding-top:12px;border-top:1px solid #E8DFD4}
.vs-fix-q{font-size:13px;font-weight:600;margin-bottom:8px}
.vs-fix-b{display:flex;flex-direction:column;gap:6px}.vs-fix-b .vs-btn{text-align:left}`;
      document.head.appendChild(st);
    }
    const ov = document.createElement('div'); ov.className = 'so-ov';
    ov.innerHTML = `<div class="so-box"><h4 id="vs-t">${esc(opts.title || sku)}</h4><div class="so-sub" id="vs-s">${esc(sku)} · vendor store</div>
      <div id="vs-body"><div class="vs-msg">Checking the vendor store…</div></div>
      <div class="vs-links" id="vs-links"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="vs-btn ghost" id="vs-close">Close</button></div></div>`;
    document.body.appendChild(ov);
    const $ = id => ov.querySelector('#' + id);
    const close = () => ov.remove();
    $('vs-close').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });

    const draw = (r) => {
      if (r.title) $('vs-t').textContent = r.title;
      $('vs-s').textContent = `${sku} · vendor store${r.status ? ' · ' + String(r.status).toLowerCase() : ''}`;
      $('vs-links').innerHTML = (r.adminUrl ? `<a href="${esc(r.adminUrl)}" target="_blank" rel="noopener">Edit in Shopify admin ↗</a>` : '')
        + (r.storeUrl ? `<a href="${esc(r.storeUrl)}" target="_blank" rel="noopener">View on the store ↗</a>` : '');
      if (!r.ok && r.available == null) { $('vs-body').innerHTML = `<div class="vs-msg bad">${esc(r.error || 'Could not check.')}</div>`; return; }
      const target = opts.target == null ? r.available : opts.target;
      $('vs-body').innerHTML = `<div class="vs-nums">
          <div class="vs-n"><b>${r.available == null ? '?' : esc(r.available)}</b><span>vendor store now</span></div>
          ${opts.target != null ? `<div class="vs-n"><b>${esc(opts.target)}</b><span>${esc(opts.targetLabel || 'Grist says')}</span></div>` : ''}
        </div>
        <div class="vs-set"><span style="font-size:12px">Set it to</span><input id="vs-q" type="number" min="0" value="${esc(target)}">
          <button class="vs-btn" id="vs-go">Set</button><button class="vs-btn ghost" id="vs-re">Check again</button></div>
        <div class="vs-msg ${r.ok ? '' : 'bad'}" id="vs-msg">${r.ok ? (r.available === target ? 'Already matches.' : '') : esc(r.error || '')}</div>`;
      $('vs-re').onclick = check;
      $('vs-go').onclick = async () => {
        const q = Math.round(Number($('vs-q').value));
        if (!(q >= 0)) { $('vs-msg').className = 'vs-msg bad'; $('vs-msg').textContent = 'Enter a number, 0 or more.'; return; }
        $('vs-go').disabled = true; $('vs-msg').className = 'vs-msg'; $('vs-msg').textContent = `Setting ${sku} to ${q}…`;
        const s = await vendorSet(sku, q, r.available);
        if (s.ok && s.set) {
          $('vs-body').querySelector('.vs-n b').textContent = s.available;
          $('vs-msg').className = 'vs-msg ok';
          $('vs-msg').textContent = `Vendor store now shows ${s.available} ✓`;
          if (opts.onSet) opts.onSet(s.available);
          const delta = Number(s.available) - Number(opts.target);
          if (opts.target != null && delta && Number.isFinite(delta)) offerGristFix(delta);
        } else {
          $('vs-msg').className = 'vs-msg bad';
          $('vs-msg').textContent = s.error || 'Not set.';
          $('vs-go').disabled = false;
          if (s.stale) setTimeout(check, 600);
        }
      };
    };
    /* The store now differs from what Grist expected — ask why, then fix Grist to match. */
    const offerGristFix = (delta) => {
      const docApi = opts.docApi || (root.grist && root.grist.docApi);
      if (!docApi) return;
      const n = Math.abs(delta);
      const choices = delta < 0
        ? [['hank', `${n} hank not there`], ['wound', `${n} wound not there`], ['hold', `They're there — just don't list them`]]
        : [['general', `List ${n} more of what's on the shelf`], ['hank', `Found ${n} more hank`], ['wound', `Found ${n} more wound`]];
      const box = document.createElement('div'); box.className = 'vs-fix';
      box.innerHTML = `<div class="vs-fix-q">Grist expected ${esc(opts.target)}. Update Grist for the ${n} ${delta < 0 ? 'fewer' : 'more'}?</div>
        <div class="vs-fix-b">${choices.map(([k, t]) => `<button class="vs-btn ghost" data-fix="${k}">${esc(t)}</button>`).join('')}
        <button class="vs-btn ghost" data-fix="">Leave Grist as is</button></div><div class="vs-msg" id="vs-fixmsg"></div>`;
      $('vs-body').appendChild(box);
      box.querySelectorAll('[data-fix]').forEach(b => b.addEventListener('click', async () => {
        const kind = b.dataset.fix;
        const msg = box.querySelector('#vs-fixmsg');
        if (!kind) { box.querySelector('.vs-fix-b').remove(); box.querySelector('.vs-fix-q').textContent = 'Grist left as is.'; return; }
        box.querySelectorAll('[data-fix]').forEach(x => { x.disabled = true; });
        msg.className = 'vs-msg'; msg.textContent = 'Updating Grist…';
        let r;
        try { r = await vendorGristFix(docApi, sku, delta, kind); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
        if (!r.ok) {
          msg.className = 'vs-msg bad'; msg.textContent = r.error;
          box.querySelectorAll('[data-fix]').forEach(x => { x.disabled = false; });
          return;
        }
        box.querySelector('.vs-fix-b').remove();
        box.querySelector('.vs-fix-q').textContent = 'Grist updated ✓';
        msg.className = 'vs-msg ok';
        msg.innerHTML = `${esc(r.text)} <a href="#" id="vs-fixundo" style="color:#5B4A8B;margin-left:6px">undo</a>`;
        msg.querySelector('#vs-fixundo').onclick = async (e) => {
          e.preventDefault();
          await docApi.applyUserActions(r.undo);
          msg.className = 'vs-msg'; msg.textContent = 'Grist change undone.';
          if (opts.onGrist) opts.onGrist();
        };
        if (opts.onGrist) opts.onGrist();
      }));
    };
    const check = async () => { $('vs-body').innerHTML = '<div class="vs-msg">Checking the vendor store…</div>'; draw(await vendorCheck(sku)); };
    check();
  }

  root.StockOps = { vendorCheck, vendorSet, vendorGristFix, lotCountFix, lotSetActions, lotDeleteActions, openVendorStock, taskCols, taskFields, loadTaskCols, pdfLib, pdfSafe, downloadPdf, ymd, extraPots, printExtraPots,
    load, defaultPlan, suggestBin, binFillFor, putAwayActions, applyPutAway, logPot, openLogPot,
    orderBinCode, fiberCode, esc, num, ORDER_STATUS_HANK, ORDER_STATUS_WOUND };
})(typeof window !== 'undefined' ? window : globalThis);
