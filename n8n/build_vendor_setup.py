"""Builds vendor-setup.workflow.json (the n8n workflow behind the Vendor Setup widget).

Run:  python3 n8n/build_vendor_setup.py
Then import n8n/vendor-setup.workflow.json into n8n (Workflows → Import from file).
"""
import json, os, uuid

HERE = os.path.dirname(os.path.abspath(__file__))

SHOPIFY_CRED = {"shopifyAccessTokenApi": {"name": "Shopify Vendor API"}}
LOCKSMITH_CRED = {"httpHeaderAuth": {"name": "Locksmith Vendor Store"}}
SHOP = "$('Settings').first().json"

# ── Code node sources ────────────────────────────────────────────────────────

SETTINGS_JS = r"""
// ── Change these two if the store or API version changes ──
const SHOP = 'squirrelvender.myshopify.com';   // vendor store's myshopify domain
const API_VERSION = '2025-07';
const LOCKSMITH_SHOP = 'dcdc55-ee.myshopify.com';   // the store's permanent myshopify domain (what Locksmith knows it by)

const first = $input.first().json;
const body = first.body || first;
const action = ['check', 'setup', 'fix'].includes(body.action) ? body.action : 'check';
const vendors = (Array.isArray(body.vendors) ? body.vendors : [])
  .filter(v => v && v.code && v.name).slice(0, 10);
if (!vendors.length) throw new Error('No vendors were sent (each needs a name and a code).');
const tpl = String(body.template_lock_id || '').replace(/\D/g, '');
const LS = 'https://uselocksmith.com/api/unstable';

return [{ json: {
  shop: SHOP, lsShop: LOCKSMITH_SHOP, apiVersion: API_VERSION, action, vendors,
  fix: Array.isArray(body.fix) ? body.fix.map(String) : [],
  templateLockId: tpl,
  templateUrl: tpl ? `${LS}/locks/${tpl}.json` : `${LS}/shop.json`,
  collectionsBody: { query: `{
    collections(first: 250) {
      nodes { id legacyResourceId title handle
        ruleSet { appliedDisjunctively rules { column relation condition } } } }
    publications(first: 20) { nodes { id name } }
  }` },
} }];
"""

COMMON_JS = r"""
const LS = 'https://uselocksmith.com/api/unstable';
const lc = s => String(s == null ? '' : s).trim().toLowerCase();
const num = s => String(s == null ? '' : s).replace(/\D/g, '');
const lid = l => l == null ? undefined : (l.id ?? l._id ?? l.lock_id);
const unwrap = r => (r && (r.lock || (r.data && !Array.isArray(r.data) && lid(r.data) != null ? r.data : null))) || r;
const errText = e => {
  if (!e) return '';
  if (typeof e === 'string') return e;
  const m = [e.code, e.message, e.description].filter(Boolean).join(' — ');
  return m || JSON.stringify(e).slice(0, 300);
};
const gqlErr = r => r && r.errors ? (Array.isArray(r.errors) ? r.errors.map(e => e.message).join('; ') : JSON.stringify(r.errors).slice(0, 300)) : '';
"""

PER_VENDOR_JS = COMMON_JS + r"""
const S = $('Settings').first().json;

// Locksmith: every lock in the store (the list may arrive wrapped or as separate items)
const rawLocks = $('Locksmith: list locks').all().map(i => i.json);
let locks = [], listErr = '';
if (rawLocks.length === 1 && rawLocks[0] && rawLocks[0].error) listErr = errText(rawLocks[0].error);
else if (rawLocks.length === 1 && rawLocks[0] && rawLocks[0].id == null) {
  const r = rawLocks[0];
  locks = r.locks || r.data || [];
  if (!Array.isArray(locks)) locks = Object.values(locks);
} else locks = rawLocks;

// Locksmith: the template lock (a vendor whose lock is set up exactly right)
const tplRaw = $('Locksmith: template lock').first().json;
const template = S.templateLockId && tplRaw && !tplRaw.error ? unwrap(tplRaw) : null;
const templateErr = S.templateLockId && (!tplRaw || tplRaw.error) ? errText(tplRaw && tplRaw.error) || 'not found' : '';

// Shopify: smart collections + the Online Store publication
const colRes = $('Shopify: smart collections').first().json;
const cols = (colRes.data && colRes.data.collections && colRes.data.collections.nodes) || [];
const pubs = (colRes.data && colRes.data.publications && colRes.data.publications.nodes) || [];
const online = pubs.find(p => /online store/i.test(p.name || '')) || null;
const shopErr = colRes.error ? errText(colRes.error) : gqlErr(colRes);

const isTagRule = (c, tag) => c.ruleSet && (c.ruleSet.rules || []).some(r =>
  r.column === 'TAG' && r.relation === 'EQUALS' && lc(r.condition) === lc(tag));

const LOOKUP = `query($q: String!, $tq: String!, $cid: ID!, $hasCid: Boolean!, $colId: ID!, $hasCol: Boolean!) {
  byEmail: customers(first: 5, query: $q) { nodes { id legacyResourceId firstName lastName email phone tags } }
  byTag: customers(first: 10, query: $tq) { nodes { id legacyResourceId firstName lastName email tags } }
  byId: customer(id: $cid) @include(if: $hasCid) { id legacyResourceId firstName lastName email phone tags }
  col: collection(id: $colId) @include(if: $hasCol) { id legacyResourceId title handle
    ruleSet { appliedDisjunctively rules { column relation condition } }
    resourcePublications(first: 10) { nodes { isPublished publication { id name } } } }
}`;

return S.vendors.map((v0, idx) => {
  const code = String(v0.code).trim().toUpperCase();
  const tag = 'Vendor-' + code;
  const v = { ...v0, code, tag, email: String(v0.email || '').trim() };

  let col = null, colHow = '';
  if (num(v.collection_id)) { col = cols.find(c => String(c.legacyResourceId) === num(v.collection_id)); if (col) colHow = 'saved ID'; }
  if (!col) { col = cols.find(c => isTagRule(c, tag)); if (col) colHow = 'tag rule'; }
  if (!col) { col = cols.find(c => lc(c.title) === lc(v.name)); if (col) colHow = 'title'; }
  const otherTagCols = cols.filter(c => isTagRule(c, tag) && (!col || c.id !== col.id)).map(c => c.title);

  // Which lock belongs to this vendor
  let lockId = num(v.lock_id), lockHow = lockId ? 'saved ID' : '';
  const onCol = col ? locks.filter(l => new RegExp('(^|\\D)' + col.legacyResourceId + '(\\D|$)').test(JSON.stringify(l))) : [];
  const onTag = locks.filter(l => lc(JSON.stringify(l)).includes('"' + lc(tag) + '"'));
  if (!lockId && onCol.length) { lockId = String(lid(onCol[0])); lockHow = 'collection'; }
  if (!lockId && onTag.length) { lockId = String(lid(onTag[0])); lockHow = 'tag'; }
  const extraLocks = [...new Set([...onCol, ...onTag].map(l => String(lid(l))))].filter(id => id !== lockId);

  const cid = num(v.customer_id);
  const safeEmail = v.email.replace(/["\\]/g, '');
  return { json: {
    idx, v, col, colHow, otherTagCols, lockId, lockHow, extraLocks,
    lockDetailUrl: lockId ? `${LS}/locks/${lockId}.json` : `${LS}/shop.json`,
    lookupBody: { query: LOOKUP, variables: {
      q: safeEmail ? `email:"${safeEmail}"` : 'email:"__no_email__"',
      tq: `tag:"${tag}"`,
      cid: 'gid://shopify/Customer/' + (cid || '0'), hasCid: !!cid,
      colId: col ? col.id : 'gid://shopify/Collection/0', hasCol: !!col,
    } },
    onlinePubId: online ? online.id : '',
    template, templateErr, listErr, shopErr,
    lockDiag: `Locksmith listed ${locks.length} lock(s); none mention collection ${col ? col.legacyResourceId : '(none)'} or ${tag}.`
      + (locks.length ? '' : ' Raw answer: ' + JSON.stringify(rawLocks).slice(0, 300)),
  } };
});
"""

PLAN_JS = COMMON_JS + r"""
const S = $('Settings').first().json;
const ctxs = $('Per vendor').all().map(i => i.json);
const looks = $('Shopify: vendor lookup').all().map(i => i.json);
const dets = $input.all().map(i => i.json);

const want = part => S.action === 'setup'
  ? ['customer', 'collection', 'publish', 'lock'].includes(part)
  : S.action === 'fix' && (S.fix.length === 0 ? part !== 'lock_rebuild' : S.fix.includes(part));

function deepFind(o, key, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return undefined;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  for (const v of Object.values(o)) { const r = deepFind(v, key, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
function conditions(lock) {
  const out = [];
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 8) return;
    if (Array.isArray(o.conditions)) o.conditions.forEach(c => out.push(c));
    Object.values(o).forEach(v => walk(v, d + 1));
  })(lock, 0);
  return out;
}
function flat(o, pre = '', acc = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return acc;
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, pre + k + '.', acc);
    else if (!Array.isArray(v)) acc[pre + k] = v;
  }
  return acc;
}
const lockSettings = l => {
  if (!l) return {};
  const res = Array.isArray(l.resources) && l.resources[0] ? l.resources[0] : {};
  return { ...flat(l.options || {}, 'options.'), ...flat(res.resource_options || {}, 'resource_options.'),
           ...(l.enabled !== undefined ? { enabled: l.enabled } : {}) };
};
function phoneE164(p) {
  const s = String(p || '').trim(); if (!s) return '';
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 8 ? '+' + d : '';
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return '';
}
const hasTag = (c, tag) => (c.tags || []).some(t => lc(t) === lc(tag));

return ctxs.map((ctx, i) => {
  const v = ctx.v, tag = v.tag;
  const L = looks[i] || {}, d = L.data || {};
  const checks = [], notes = [], errors = [];
  const add = (part, status, label, detail = '', fix = '') => checks.push({ part, status, label, detail, fix });
  const ids = { customer_id: '', collection_id: '', lock_id: '' };

  // ── Customer ──
  const lookErr = L.error ? errText(L.error) : gqlErr(L);
  if (lookErr) errors.push('Shopify lookup: ' + lookErr);
  const byEmail = (d.byEmail && d.byEmail.nodes) || [];
  const byTag = ((d.byTag && d.byTag.nodes) || []).filter(c => hasTag(c, tag));
  let cust = d.byId || byEmail[0] || null, custHow = d.byId ? 'saved ID' : (byEmail[0] ? 'email' : '');
  if (!cust && byTag.length === 1) { cust = byTag[0]; custHow = 'tag'; }
  if (lookErr) {
    add('customer', 'bad', 'Could not look up the customer', lookErr);
  } else if (!cust) {
    add('customer', 'bad', 'No customer in the vendor store', v.email ? `Nobody has ${v.email}.` : 'There is no email in Grist.', v.email ? 'customer' : '');
  } else {
    ids.customer_id = String(cust.legacyResourceId || '');
    const who = [cust.firstName, cust.lastName].filter(Boolean).join(' ') || '(no name)';
    add('customer', 'ok', 'Customer found', `${who} · ${cust.email || 'no email'}${custHow !== 'email' ? ' (matched by ' + custHow + ')' : ''}`);
    if (v.email && lc(cust.email) !== lc(v.email))
      add('customer', 'warn', 'Email differs from Grist', `Store: ${cust.email || '(none)'} · Grist: ${v.email}`);
    if (!hasTag(cust, tag)) add('customer', 'bad', `Customer is missing the ${tag} tag`, 'Without it the lock keeps them out.', 'customer');
    else add('customer', 'ok', `Tagged ${tag}`);
    if (byEmail.length > 1) add('customer', 'warn', 'More than one customer has this email', byEmail.map(c => c.email).join(', '));
  }
  const others = byTag.filter(c => !cust || c.id !== cust.id);
  if (others.length) add('customer', 'bad', `Other customers also carry ${tag}`,
    'They can see this vendor’s collection: ' + others.map(c => c.email || c.id).join(', ') + '. Remove the tag from them in Shopify.');

  // ── Collection ──
  let col = d.col || null;
  let published = null;
  if (ctx.shopErr) add('collection', 'bad', 'Could not read collections', ctx.shopErr);
  else if (!col) {
    add('collection', 'bad', 'No collection for this vendor', `Expected a smart collection “${v.name}” with the rule: product tag equals ${tag}.`, 'collection');
  } else {
    ids.collection_id = String(col.legacyResourceId || '');
    const rules = (col.ruleSet && col.ruleSet.rules) || [];
    const ruleOk = rules.length === 1 && rules[0].column === 'TAG' && rules[0].relation === 'EQUALS' && rules[0].condition === tag;
    add('collection', 'ok', 'Collection found', `“${col.title}”${ctx.colHow !== 'saved ID' ? ' (matched by ' + ctx.colHow + ')' : ''}`);
    if (!col.ruleSet) add('collection', 'bad', 'Collection is a manual collection', 'It needs to be a smart collection with the tag rule. Delete it in Shopify, then run Set up.');
    else if (!ruleOk) add('collection', 'bad', 'Collection rule is not exactly “product tag equals ' + tag + '”',
      'Now: ' + (rules.map(r => `${r.column} ${r.relation} ${r.condition}`).join(rules.length > 1 && col.ruleSet.appliedDisjunctively ? ' OR ' : ' AND ') || 'no rules'), 'collection_rule');
    else add('collection', 'ok', `Rule: product tag equals ${tag}`);
    if (lc(col.title) !== lc(v.name)) add('collection', 'warn', 'Title differs from the business name', `Store: “${col.title}” · Grist: “${v.name}”`);
    const rp = col.resourcePublications;
    if (!rp) add('collection', 'warn', 'Could not read where the collection is published', 'The Shopify app needs the read_publications permission.');
    else {
      published = (rp.nodes || []).some(n => n.isPublished && n.publication && /online store/i.test(n.publication.name || ''));
      if (published) add('collection', 'ok', 'Published to the Online Store');
      else add('collection', 'bad', 'Not published to the Online Store', 'The vendor cannot open it, even when logged in.', ctx.onlinePubId ? 'publish' : '');
    }
  }
  if ((ctx.otherTagCols || []).length) add('collection', 'warn', 'Other collections use the same tag rule', ctx.otherTagCols.join(', '));

  // ── Lock ──
  let lock = null;
  const det = dets[i] || {};
  if (ctx.listErr) add('lock', 'bad', 'Could not reach Locksmith', ctx.listErr + (/INVALID_HTTP_TOKEN/.test(ctx.listErr) ? ' — the Name in the “Locksmith Vendor Store” credential must be exactly x-locksmith-access-token (token goes in Value).' : ''));
  else if (ctx.lockId && det.error) {
    add('lock', 'bad', `Lock ${ctx.lockId} was not found`, errText(det.error), col ? 'lock' : '');
  } else if (ctx.lockId) lock = unwrap(det);
  if (!ctx.listErr && !lock && !(ctx.lockId && det.error)) {
    add('lock', 'bad', 'No Locksmith lock on the collection', 'Anyone can see the collection and its products. (' + ctx.lockDiag + ')', col ? 'lock' : '');
  }
  if (lock) {
    ids.lock_id = String(lid(lock) || ctx.lockId);
    add('lock', 'ok', 'Lock found', `Lock ${ids.lock_id}${ctx.lockHow !== 'saved ID' ? ' (matched by ' + ctx.lockHow + ')' : ''}`);
    const txt = JSON.stringify(lock);
    if (col && !new RegExp('(^|\\D)' + col.legacyResourceId + '(\\D|$)').test(txt))
      add('lock', 'bad', 'Lock is not on this collection', 'It protects something else.', 'lock_rebuild');
    const en = deepFind(lock, 'enabled');
    if (en === false) add('lock', 'bad', 'Lock is turned off', '', 'lock_rebuild');
    const conds = conditions(lock);
    const permit = conds.find(c => c.type === 'customer_tag' && !c.inverse && lc(deepFind(c, 'customer_tag')) === lc(tag));
    if (permit) add('lock', 'ok', `Key: permit if customer is tagged ${tag}`);
    else add('lock', 'bad', `Key does not permit customers tagged ${tag}`, conds.length ? 'Keys found: ' + conds.map(c => c.type + ' ' + (deepFind(c, 'customer_tag') || '')).join(', ') : 'No keys found.', 'lock_rebuild');
    const extra = conds.filter(c => c !== permit && !c.inverse);
    if (extra.length) add('lock', 'warn', 'Lock has other keys too', extra.map(c => c.type + ' ' + (deepFind(c, 'customer_tag') || deepFind(c, 'passcode') || '')).join(', ') + ' — they may let others in.');
    const expect = { hide_links_to_resource: [true, 'Hide from navigation menus'], hide_resource: [true, 'Hide from lists'],
                     hide_resource_from_sitemaps: [true, 'Hide collection from sitemaps'], manual: [false, 'Manual locking'] };
    for (const [k, [wantV, label]] of Object.entries(expect)) {
      const got = deepFind(lock, k);
      if (got === undefined) continue;
      if (Boolean(got) !== wantV) add('lock', 'bad', `${label} should be ${wantV ? 'on' : 'off'}`, '', 'lock_rebuild');
    }
    if (ctx.template && String(lid(ctx.template)) !== String(ids.lock_id)) {
      const a = lockSettings(ctx.template), b = lockSettings(lock), diffs = [];
      for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(`${k}: template ${JSON.stringify(a[k])}, this ${JSON.stringify(b[k])}`);
      if (diffs.length) add('lock', 'warn', 'Settings differ from the template lock', diffs.join(' · '), 'lock_rebuild');
      else add('lock', 'ok', 'Settings match the template lock');
    }
  }
  if ((ctx.extraLocks || []).length) add('lock', 'warn', 'More locks mention this vendor', 'Lock IDs: ' + ctx.extraLocks.join(', ') + '. Check them in Locksmith.');
  if (ctx.templateErr) notes.push('Template lock could not be read: ' + ctx.templateErr);

  // ── Shopify writes (customer + collection) ──
  const parts = [], vars = {}, decl = [];
  const plannedLock = { create: false, rebuild: false };
  if (!lookErr && S.action !== 'check') {
    if (!cust && v.email && want('customer')) {
      const words = String(v.name).trim().split(/\s+/);
      const firstName = String(v.first_name || (words.length > 1 ? words.slice(0, -1).join(' ') : words[0])).trim();
      const lastName = String(v.last_name != null && v.first_name ? v.last_name : (words.length > 1 ? words[words.length - 1] : '')).trim();
      const input = { firstName, lastName, email: v.email, tags: [tag] };
      const ph = phoneE164(v.phone);
      if (ph) input.phone = ph; else if (String(v.phone || '').trim()) notes.push('Phone left off — add the country code (e.g. +1) and set it in Shopify.');
      decl.push('$cust: CustomerInput!'); vars.cust = input;
      parts.push('c1: customerCreate(input: $cust) { customer { id legacyResourceId } userErrors { field message } }');
    } else if (cust && !hasTag(cust, tag) && want('customer')) {
      decl.push('$custId: ID!', '$tags: [String!]!'); vars.custId = cust.id; vars.tags = [tag];
      parts.push('t1: tagsAdd(id: $custId, tags: $tags) { node { id } userErrors { field message } }');
    }
    const ruleSet = { appliedDisjunctively: false, rules: [{ column: 'TAG', relation: 'EQUALS', condition: tag }] };
    if (!col && !ctx.shopErr && want('collection')) {
      decl.push('$col: CollectionInput!'); vars.col = { title: v.name, ruleSet };
      parts.push('k1: collectionCreate(input: $col) { collection { id legacyResourceId title } userErrors { field message } }');
    } else if (col && col.ruleSet && want('collection_rule') && checks.some(c => c.fix === 'collection_rule')) {
      decl.push('$colUp: CollectionInput!'); vars.colUp = { id: col.id, ruleSet };
      parts.push('k2: collectionUpdate(input: $colUp) { collection { id } userErrors { field message } }');
    }
    const lockBad = checks.some(c => c.fix === 'lock_rebuild');
    if (!lock && want('lock')) plannedLock.create = true;
    if (lock && lockBad && want('lock_rebuild')) plannedLock.rebuild = true;
  }
  const writeBody = parts.length
    ? { query: `mutation(${decl.join(', ')}) {\n${parts.join('\n')}\n}`, variables: vars }
    : { query: '{ shop { id } }' };

  return { json: {
    row_id: v.row_id, name: v.name, code: v.code, tag, v,
    checks, notes, errors, ids, did: [],
    colGid: col ? col.id : '', published, onlinePubId: ctx.onlinePubId,
    lockId: lock ? String(lid(lock) || ctx.lockId) : '', plannedLock, template: ctx.template,
    writeBody, wroteSomething: parts.length > 0,
  } };
});
"""

AFTER_WRITE_JS = COMMON_JS + r"""
const S = $('Settings').first().json;
const plans = $('Plan').all().map(i => i.json);
const res = $input.all().map(i => i.json);
const wantPublish = S.action === 'setup' || (S.action === 'fix' && (S.fix.length === 0 || S.fix.includes('publish')));
const ue = x => (x && x.userErrors || []).map(e => (e.field ? e.field.join('.') + ': ' : '') + e.message).join('; ');

return plans.map((p, i) => {
  const r = res[i] || {}, d = r.data || {};
  if (p.wroteSomething) {
    if (r.error) p.errors.push('Shopify: ' + errText(r.error));
    if (r.errors) p.errors.push('Shopify: ' + gqlErr(r));
  }
  if (d.c1) { const e = ue(d.c1); if (e) p.errors.push('Create customer: ' + e); else if (d.c1.customer) { p.ids.customer_id = String(d.c1.customer.legacyResourceId); p.did.push('Created the customer with tag ' + p.tag); } }
  if (d.t1) { const e = ue(d.t1); if (e) p.errors.push('Add tag: ' + e); else p.did.push('Added tag ' + p.tag + ' to the customer'); }
  if (d.k1) { const e = ue(d.k1); if (e) p.errors.push('Create collection: ' + e); else if (d.k1.collection) {
    p.ids.collection_id = String(d.k1.collection.legacyResourceId); p.colGid = d.k1.collection.id; p.published = false;
    p.did.push('Created the collection “' + d.k1.collection.title + '”'); } }
  if (d.k2) { const e = ue(d.k2); if (e) p.errors.push('Fix collection rule: ' + e); else p.did.push('Set the collection rule to product tag equals ' + p.tag); }

  p.wantPub = !!(wantPublish && p.colGid && p.onlinePubId && p.published === false);
  p.pubBody = p.wantPub
    ? { query: 'mutation($id: ID!, $pub: ID!) { publishablePublish(id: $id, input: [{ publicationId: $pub }]) { userErrors { field message } } }',
        variables: { id: p.colGid, pub: p.onlinePubId } }
    : { query: '{ shop { id } }' };
  if (wantPublish && p.colGid && !p.onlinePubId) p.notes.push('Could not find the Online Store publication — publish the collection by hand (needs read_publications).');
  return { json: p };
});
"""

LOCK_PLAN_JS = COMMON_JS + r"""
const plans = $('After write').all().map(i => i.json);
const res = $input.all().map(i => i.json);

function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_') || ['id', 'lock_id', 'lock_resource_id', 'created_at', 'updated_at', 'resource_id'].includes(k)) continue;
      r[k] = clean(v);
    }
    return r;
  }
  return o;
}

return plans.map((p, i) => {
  if (p.wantPub) {
    const r = res[i] || {}, pp = r.data && r.data.publishablePublish;
    const e = r.error ? errText(r.error) : (gqlErr(r) || (pp && pp.userErrors || []).map(x => x.message).join('; '));
    if (e) p.errors.push('Publish: ' + e); else p.did.push('Published the collection to the Online Store');
  }
  const colId = p.ids.collection_id;
  const doCreate = !!colId && (p.plannedLock.create || p.plannedLock.rebuild);
  if ((p.plannedLock.create || p.plannedLock.rebuild) && !colId) p.notes.push('Lock not made — the collection is missing.');

  const tpl = p.template;
  const tRes = tpl && Array.isArray(tpl.resources) && tpl.resources[0] ? tpl.resources[0] : null;
  const rtype = (tRes && tRes.resource_type) || (tpl && tpl.resource_type) || 'smart_collection';
  const resource = { resource_type: rtype, resource_id: Number(colId) };
  if (tRes && tRes.resource_options) resource.resource_options = clean(tRes.resource_options);
  const options = Object.assign({}, tpl && tpl.options ? clean(tpl.options) : {},
    { hide_links_to_resource: true, hide_resource: true, hide_resource_from_sitemaps: true, manual: false });
  const tKey = tpl && Array.isArray(tpl.keys) && tpl.keys[0] ? tpl.keys[0] : null;
  const keyOptions = Object.assign({ customer_autotag: '', force_open: false, redirect_url: '', inverse: false },
    tKey && tKey.options ? clean(tKey.options) : {});
  const body = {
    name: p.name, resource_type: rtype, enabled: true, resources: [resource], options,
    keys: [{ options: keyOptions, conditions: [{ type: 'customer_tag', inverse: false, options: { customer_tag: p.tag } }] }],
  };
  p.lsDelete = p.plannedLock.rebuild && doCreate && p.lockId
    ? { method: 'DELETE', url: `${LS}/locks/${p.lockId}` } : { method: 'GET', url: `${LS}/shop.json` };
  // Nothing to make: a dry run with an empty body (Locksmith only validates it, nothing is saved).
  p.lsCreate = doCreate ? { method: 'POST', url: `${LS}/lock`, body } : { method: 'POST', url: `${LS}/lock?dryrun=true`, body: {} };
  p.doCreate = doCreate;
  return { json: p };
});
"""

REPORT_JS = COMMON_JS + r"""
const S = $('Settings').first().json;
const plans = $('Lock plan').all().map(i => i.json);
const dels = $('Locksmith: delete lock').all().map(i => i.json);
const made = $input.all().map(i => i.json);

const results = plans.map((p, i) => {
  if (p.lsDelete && p.lsDelete.method === 'DELETE') {
    const r = dels[i] || {};
    if (r.error) p.errors.push('Remove old lock: ' + errText(r.error)); else { p.did.push('Removed the old lock ' + p.lockId); p.ids.lock_id = ''; }
  }
  if (p.doCreate) {
    const r = made[i] || {};
    if (r.error) p.errors.push('Create lock: ' + errText(r.error));
    else {
      const l = unwrap(r);
      const id = lid(l) || (l && lid(l.lock));
      if (id) { p.ids.lock_id = String(id); p.did.push('Created the Locksmith lock ' + id); }
      else p.errors.push('Create lock: Locksmith answered without a lock id — ' + JSON.stringify(r).slice(0, 200));
    }
  }
  const worst = p.checks.some(c => c.status === 'bad') ? 'bad' : p.checks.some(c => c.status === 'warn') ? 'warn' : 'ok';
  return { row_id: p.row_id, name: p.name, code: p.code, tag: p.tag, status: worst,
           checks: p.checks, did: p.did, errors: p.errors, notes: p.notes, ids: p.ids };
});
return [{ json: { ok: true, action: S.action, results } }];
"""

# ── Nodes ────────────────────────────────────────────────────────────────────

nodes = []
def node(name, ntype, ver, params, pos, **extra):
    n = {"parameters": params, "id": str(uuid.uuid4()), "name": name, "type": ntype,
         "typeVersion": ver, "position": pos}
    n.update(extra)
    nodes.append(n)
    return n

def code(name, js, pos):
    return node(name, "n8n-nodes-base.code", 2, {"jsCode": js.strip() + "\n"}, pos)

def shopify_http(name, body_expr, pos, **extra):
    return node(name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": "=https://{{ " + SHOP + ".shop }}/admin/api/{{ " + SHOP + ".apiVersion }}/graphql.json",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "shopifyAccessTokenApi",
        "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify(" + body_expr + ") }}",
        "options": {},
    }, pos, credentials=SHOPIFY_CRED, onError="continueRegularOutput", **extra)

def ls_http(name, method_expr, url_expr, pos, body_expr=None, send_body_expr=None, **extra):
    p = {
        "method": method_expr, "url": url_expr,
        "authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True,
        "headerParameters": {"parameters": [{"name": "x-shopify-shop-domain", "value": "={{ " + SHOP + ".lsShop }}"}]},
        "options": {},
    }
    if body_expr:
        p.update({"sendBody": send_body_expr, "specifyBody": "json", "jsonBody": body_expr})
    return node(name, "n8n-nodes-base.httpRequest", 4.2, p, pos,
                credentials=LOCKSMITH_CRED, onError="continueRegularOutput", **extra)

X = 0
def nx():
    global X
    X += 220
    return [X, 300]

node("Vendor Setup Webhook", "n8n-nodes-base.webhook", 2, {
    "httpMethod": "POST", "path": "vendor-setup", "responseMode": "responseNode",
    "options": {"allowedOrigins": "*"},
}, nx(), webhookId=str(uuid.uuid4()))
code("Settings", SETTINGS_JS, nx())
ls_http("Locksmith: list locks", "GET", "https://uselocksmith.com/api/unstable/locks.json", nx(), executeOnce=True)
ls_http("Locksmith: template lock", "GET", "={{ " + SHOP + ".templateUrl }}", nx(), executeOnce=True)
shopify_http("Shopify: smart collections", SHOP + ".collectionsBody", nx(), executeOnce=True)
code("Per vendor", PER_VENDOR_JS, nx())
shopify_http("Shopify: vendor lookup", "$json.lookupBody", nx())
ls_http("Locksmith: lock detail", "GET", "={{ $('Per vendor').item.json.lockDetailUrl }}", nx())
code("Plan", PLAN_JS, nx())
shopify_http("Shopify: write", "$json.writeBody", nx())
code("After write", AFTER_WRITE_JS, nx())
shopify_http("Shopify: publish", "$json.pubBody", nx())
code("Lock plan", LOCK_PLAN_JS, nx())
ls_http("Locksmith: delete lock", "={{ $json.lsDelete.method }}", "={{ $json.lsDelete.url }}", nx())
ls_http("Locksmith: create lock", "POST",
        "={{ $('Lock plan').item.json.lsCreate.url }}", nx(),
        body_expr="={{ JSON.stringify($('Lock plan').item.json.lsCreate.body) }}",
        send_body_expr=True)
code("Report", REPORT_JS, nx())
node("Respond", "n8n-nodes-base.respondToWebhook", 1.1, {"respondWith": "firstIncomingItem", "options": {}}, nx())

connections = {}
for a, b in zip(nodes, nodes[1:]):
    connections[a["name"]] = {"main": [[{"node": b["name"], "type": "main", "index": 0}]]}

wf = {"name": "SS - Vendor Setup", "nodes": nodes, "connections": connections,
      "settings": {"executionOrder": "v1"}, "pinData": {}}
out = os.path.join(HERE, "vendor-setup.workflow.json")
with open(out, "w") as f:
    json.dump(wf, f, indent=2)
print("wrote", out, len(nodes), "nodes")
