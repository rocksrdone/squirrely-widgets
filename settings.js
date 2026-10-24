/* ── Shop settings, shared by the widgets ────────────────────────────────────
   Reads the Grist `Settings` table (Key / Value / Text) once per page load and
   hands values out with a built-in default for each, so a missing or blank
   setting never breaks a widget — it just behaves as it always did.

     await SSSettings.load();
     const cap = SSSettings.num('Back_Stock_Bin_Capacity', 60);
     const sizes = SSSettings.list('Pot_Size_Buttons', [5, 6, 7, 8, 9, 10]);
     const root = SSSettings.text('Recipe_Photo_Root', 'Squirrely Stash/recipes/photos/');

   Edit values on the Setup page's Settings Desk. A widget picks up a change
   the next time it loads (reload the Grist page).
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  const S = {
    values: {}, texts: {}, loaded: false, ok: false, _p: null,
    load(force) {
      if (S._p && !force) return S._p;
      S._p = (async () => {
        try {
          const t = await grist.docApi.fetchTable('Settings');
          const keys = t.Key || [];
          S.values = {}; S.texts = {};
          keys.forEach((key, i) => {
            if (!key) return;
            const v = t.Value ? t.Value[i] : null;
            if (v !== null && v !== '' && v !== undefined && isFinite(Number(v))) S.values[key] = Number(v);
            const tx = t.Text ? t.Text[i] : '';
            if (tx !== null && tx !== undefined && String(tx).trim() !== '') S.texts[key] = String(tx);
          });
          S.ok = true;
        } catch (e) {
          console.warn('Settings table unavailable — using built-in defaults', e);
        }
        S.loaded = true;
        if (typeof window.applyRackSettings === 'function') { try { window.applyRackSettings(); } catch (e) { console.warn(e); } }
      })();
      return S._p;
    },
    /* Number setting, or the default when blank / missing. */
    num(key, def) { const v = S.values[key]; return (typeof v === 'number' && isFinite(v)) ? v : def; },
    /* Text setting, or the default when blank / missing. */
    text(key, def) { return S.texts[key] !== undefined ? S.texts[key] : def; },
    /* Comma-separated list of positive numbers in the Text column ("5, 6, 7"). */
    list(key, def) {
      const t = S.texts[key]; if (!t) return def;
      const a = t.split(/[,;\s]+/).map(Number).filter(n => isFinite(n) && n > 0);
      return a.length ? a : def;
    },
  };
  window.SSSettings = S;
})();
