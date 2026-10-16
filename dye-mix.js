/* ── Custom dye mixes (Brand X) — shared by the recipe card and pick sheets ──
   A custom's formula is rows in Dye_Mix_Parts: one per ingredient (a base dye,
   or another custom), with parts and the solution strength. Dyes carries
   Mix_Form (Liquid = combine made solutions, Dry = mix powders),
   Mix_Water_Parts, Always_Pull_Powder and Mix_Confirmed.

   Rule for pulling a custom: list a made jar of the custom itself if there is
   one, then every ingredient — its made jar if there is one ("if usable"), and
   its powder tub when the custom says Always_Pull_Powder or no jar exists.
   Nested customs (Green #8 uses Yellow #4) expand all the way down. */
(function (root) {
  'use strict';
  const refId = (v) => (typeof v === 'number' ? v || null : Array.isArray(v) ? v[1] || null : null);
  const arr = (t, c) => (t && Array.isArray(t[c]) ? t[c] : []);

  async function load(docApi) {
    const model = { partsByMix: {}, mixInfo: {}, dye: {}, ok: false };
    try {
      const [parts, dyes] = await Promise.all([docApi.fetchTable('Dye_Mix_Parts'), docApi.fetchTable('Dyes')]);
      (parts.id || []).forEach((id, i) => {
        const mix = refId(arr(parts, 'Mix')[i]);
        const ing = refId(arr(parts, 'Ingredient')[i]);
        if (!mix || !ing) return;
        (model.partsByMix[mix] = model.partsByMix[mix] || []).push({
          id, ingredient: ing, parts: Number(arr(parts, 'Parts')[i]) || 0,
          strength: String(arr(parts, 'Strength')[i] || ''), sort: Number(arr(parts, 'Sort')[i]) || 0,
        });
      });
      Object.values(model.partsByMix).forEach(l => l.sort((a, b) => a.sort - b.sort || a.id - b.id));
      (dyes.id || []).forEach((id, i) => {
        model.dye[id] = { name: String(arr(dyes, 'Dye_Name')[i] || ''), brand: String(arr(dyes, 'Brand')[i] || '') };
        if (!model.partsByMix[id]) return;
        model.mixInfo[id] = {
          form: String(arr(dyes, 'Mix_Form')[i] || 'Liquid'),
          water: Number(arr(dyes, 'Mix_Water_Parts')[i]) || 0,
          // Missing column or unset = pull powder; that's the safe default.
          alwaysPowder: arr(dyes, 'Always_Pull_Powder').length ? !!arr(dyes, 'Always_Pull_Powder')[i] : true,
          confirmed: !!arr(dyes, 'Mix_Confirmed')[i],
        };
      });
      model.ok = true;
    } catch (e) { /* no Dye_Mix_Parts table yet — everything reads as "not a mix" */ }
    return model;
  }

  const isMix = (model, dyeId) => !!(model && dyeId && model.partsByMix[dyeId] && model.partsByMix[dyeId].length);

  /* Ingredients of a mix, nested ones expanded beneath their parent:
     [{dyeId, parts, strength, depth, isMix, parentMix}] */
  function expand(model, dyeId, depth, seen) {
    depth = depth || 1; seen = seen || new Set([dyeId]);
    const out = [];
    (model.partsByMix[dyeId] || []).forEach(p => {
      const nested = isMix(model, p.ingredient) && !seen.has(p.ingredient);
      out.push({ dyeId: p.ingredient, parts: p.parts, strength: p.strength, depth, isMix: nested, parentMix: dyeId });
      if (nested) out.push(...expand(model, p.ingredient, depth + 1, new Set([...seen, p.ingredient])));
    });
    return out;
  }

  const fmt = (n) => String(Math.round(Number(n) * 1000) / 1000);
  /* "2 mL Hot Fuchsia (J 1-160) : 1.5 mL Sun Yellow (Pro 1-80) : 4 mL water" — labelOf(dyeId) → {name, brand} */
  function formula(model, dyeId, labelOf) {
    labelOf = labelOf || ((id) => model.dye[id]);
    const info = model.mixInfo[dyeId] || {};
    const dry = info.form === 'Dry';
    const bits = (model.partsByMix[dyeId] || []).map(p => {
      const l = labelOf(p.ingredient) || {};
      const tag = [l.brand, p.strength].filter(Boolean).join(' ');
      return `${fmt(p.parts)}${dry ? ' tsp' : ' mL'} ${l.name || '?'}${tag ? ' (' + tag + ')' : ''}`;
    });
    if (info.water) bits.push(`${fmt(info.water)} mL water`);
    return bits.join(dry ? ' + ' : ' : ');
  }

  root.DyeMix = { load, isMix, expand, formula };
})(typeof window !== 'undefined' ? window : globalThis);
