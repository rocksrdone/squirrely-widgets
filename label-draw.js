/* label-draw.js — the drawing that has to look the same everywhere a spool
   label is printed: Label Batch (the real sheets) and Customer Barcodes (the
   test sheet a customer scans). One copy, so a test sheet can never pass while
   the real label fails, or the other way round.

   Needs jsPDF's doc. Everything here is a plain global (classic script).     */

/* Measured off the real Maestro sheets: text sits at 0.4217 x diameter on
   OL3012 and 0.4152 on OL1025. One ratio covers both.                        */
const RING_RADIUS_RATIO = 0.42;
const RING_FONT_RATIO = 0.058;   // of diameter, when no Ring_Font_Size_Pt is set

/* Helvetica-Bold is a PDF base-14 font: no download, cannot fail to load. */
const NAME_FONT = ['helvetica', 'bold'];
const NAME_FIT_RATIO = 0.72;   // usable width inside the ring, as a fraction of diameter
const NAME_LINE_HEIGHT = 1.15;   // line spacing as a multiple of font size

/* Barcode size: their own sticker (EAN 2100000079681 on Perfect Ten, Nov 2026)
   is 0.81" of bars x 0.17" tall and scans at their till. */
const BARCODE_TARGET_W = 0.81;       // inches of bars (95 modules), as the customer scans now

/* EAN-13 (and UPC-A, which is EAN-13 with a leading 0). Returns the 13 digits
   or why not. A wrong last digit is almost always a typo, so it's refused. */
function eanCheckDigit(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
function eanNormalize(raw) {
  const d = String(raw || '').replace(/[\s\-]/g, '');
  if (!d) return { ok: false, error: 'missing' };
  if (!/^\d+$/.test(d)) return { ok: false, error: 'digits only' };
  let code = d.length === 12 ? '0' + d : d;   // UPC-A
  if (code.length !== 13) return { ok: false, error: d.length + ' digits — EAN-13 has 13' };
  if (eanCheckDigit(code.slice(0, 12)) !== code[12]) return { ok: false, error: 'last digit doesn’t check — typo?' };
  return { ok: true, code };
}
const EAN_L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const EAN_G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const EAN_R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const EAN_PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
function eanModules(code) {   // 95 chars of 1/0
  const p = EAN_PARITY[Number(code[0])];
  let m = '101';
  for (let i = 1; i <= 6; i++) m += (p[i - 1] === 'L' ? EAN_L : EAN_G)[Number(code[i])];
  m += '01010';
  for (let i = 7; i <= 12; i++) m += EAN_R[Number(code[i])];
  return m + '101';
}
const EAN_GUARD = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);

/* Name on top, bars in the middle, digits under the bars (6 + 6, like the
   customer's own sticker). Everything is kept inside the clear
   circle within the ring, so the ring text prints exactly as on every spool.
   Returns the bar width used, for the "test-scan" warning. */
function drawBarcodeBack(doc, name, code, cx, cy, g) {
  const clearR = g.dia * (NAME_FIT_RATIO / 2) * (g.ringRatio / RING_RADIUS_RATIO);
  const k = g.dia / 1.25;
  const guardExt = 0.04 * k;
  const digPt = Math.max(4.5, 5.5 * k), digH = digPt / 72 * 0.75;
  const gap = 0.03 * k;
  const chord = off => { const v = clearR * clearR - off * off; return v > 0 ? 2 * Math.sqrt(v) : 0; };

  /* Name above the bars. Tried in order until one fits inside the ring:
       full-height bars, then shorter bars (down to 70%);
       at each, the name at full size shrinking to 4.5pt, on 1, 2 or 3 lines.
     Wrapping and shorter bars come before tiny type, because a name a person
     can't read is worse than slightly shorter bars the scanner still reads. */
  doc.setFont(NAME_FONT[0], NAME_FONT[1]); doc.setTextColor(0);
  const words = String(name).trim().split(/\s+/);
  const splits = [[String(name)]];
  if (words.length > 1) splits.push(splitTwo(doc, words));
  if (words.length > 2) splits.push(splitThree(doc, words));
  let fit = null;
  for (const hScale of [1, 0.85, 0.7]) {
    const barH = 0.17 * k * hScale;
    for (let pt = g.fontPt; pt >= 4.5 && !fit; pt -= 0.25) {
      doc.setFontSize(pt);
      const lead = pt * NAME_LINE_HEIGHT / 72;
      for (const lines of splits) {
        const blockH = lines.length * lead;
        const T = blockH + gap + barH + Math.max(guardExt, digH + 0.012);
        const top = cy - T / 2;
        const ok = lines.every((ln, i) => {
          const yMid = top + lead * (i + 0.5);
          return doc.getTextWidth(ln) <= chord(Math.abs(yMid - cy) + pt * 0.36 / 72);
        });
        if (ok) { fit = { pt, lines, lead, top, T, barH }; break; }
      }
    }
    if (fit) break;
  }
  if (!fit) {   // nothing fits: smallest type, three lines, short bars — never past the ring
    doc.setFontSize(4.5);
    const lead = 4.5 * NAME_LINE_HEIGHT / 72, lines = splits[splits.length - 1], barH = 0.17 * k * 0.7;
    const T = lines.length * lead + gap + barH + Math.max(guardExt, digH + 0.012);
    fit = { pt: 4.5, lines, lead, top: cy - T / 2, T, barH };
  }
  const barH = fit.barH;
  doc.setFontSize(fit.pt);
  fit.lines.forEach((ln, i) => doc.text(ln, cx, fit.top + fit.lead * (i + 0.5), { align: 'center', baseline: 'middle' }));

  // Bars: as wide as the target, or as wide as the circle allows at that height.
  const yb = fit.top + fit.lines.length * fit.lead + gap;
  const yBottom = yb + barH + guardExt;
  const dy = Math.max(Math.abs(yb - cy), Math.abs(yBottom - cy));
  const barW = Math.min(BARCODE_TARGET_W, chord(dy));
  const mod = barW / 95;
  const x0 = cx - barW / 2;
  const mods = eanModules(code);
  doc.setFillColor(0);
  let i = 0;
  while (i < 95) {
    if (mods[i] !== '1') { i++; continue; }
    let j = i; while (j < 95 && mods[j] === '1') j++;
    const guard = EAN_GUARD.has(i);
    // Bars are drawn a hair narrower than nominal: inkjet ink spreads, and a
    // fat bar is what makes a small code misread.
    doc.rect(x0 + i * mod, yb, (j - i) * mod - mod * 0.08, barH + (guard ? guardExt : 0), 'F');
    i = j;
  }
  // Human-readable digits: 6 + 6 under the bars, as on the customer's own
  // sticker. The leading digit is left off — it would sit on the ring text.
  doc.setFont(NAME_FONT[0], 'normal');
  doc.setFontSize(digPt);
  const yd = yb + barH + digH + 0.006;
  doc.text(code.slice(1, 7), x0 + mod * 24, yd, { align: 'center' });
  doc.text(code.slice(7), x0 + mod * 70, yd, { align: 'center' });
  doc.setFont(NAME_FONT[0], NAME_FONT[1]);
  return barW;
}


/* Lays the string around the full circle, one character at a time, each rotated
   to sit tangent to the path. Character angles are proportional to glyph width
   so spacing stays even, and the string is scaled to close the loop exactly —
   which is why a longer string ("150 Yards") still fits without adjustment.
   Midpoint sits at 12 o'clock, matching the existing Maestro design.          */
const CAP_HEIGHT = 0.718;   // Helvetica cap height as a fraction of the font size
function drawRingText(doc, text, cx, cy, dia, fontPt, ratio) {
  const chars = [...(text + ' \u2022 ')];   // trailing bullet closes the loop
  doc.setFontSize(fontPt);
  const widths = chars.map(ch => doc.getTextWidth(ch));
  const total = widths.reduce((a, b) => a + b, 0);
  if (!total) return;
  const radius = dia * (ratio > 0 ? ratio : RING_RADIUS_RATIO);
  let acc = 0;
  chars.forEach((ch, i) => {
    const frac = (acc + widths[i] / 2) / total;
    acc += widths[i];
    if (ch === ' ') return;
    const theta = (frac - 0.5) * 360;             // degrees clockwise from top
    const rad = theta * Math.PI / 180;
    const x = cx + radius * Math.sin(rad);
    const y = cy - radius * Math.cos(rad);
    /* Centre each glyph on the ring ourselves. jsPDF applies align:'center'
       and baseline:'middle' along the PAGE axes even when the text is rotated,
       so every letter landed half its width left and half its height low —
       the whole ring sat off-centre in the die cut, worst at 3 and 9 o'clock.
       Instead: step back half the glyph width along the baseline direction and
       half the cap height along the outward direction, then draw from there. */
    const along = [Math.cos(rad), Math.sin(rad)];     // baseline direction (page coords, y down)
    const out = [Math.sin(rad), -Math.cos(rad)];      // glyph "up" = away from centre
    const halfW = widths[i] / 2;
    const halfH = (fontPt / 72) * CAP_HEIGHT / 2;
    const x0 = x - along[0] * halfW - out[0] * halfH;
    const y0 = y - along[1] * halfW - out[1] * halfH;
    doc.text(ch, x0, y0, { angle: -theta });
  });
}


// Three lines for the longest names, split so the widest line is as narrow as possible.
function splitThree(doc, words) {
  let best = null;
  for (let a = 1; a < words.length - 1; a++) {
    for (let b = a + 1; b < words.length; b++) {
      const lines = [words.slice(0, a).join(' '), words.slice(a, b).join(' '), words.slice(b).join(' ')];
      const w = Math.max(...lines.map(l => doc.getTextWidth(l)));
      if (!best || w < best.w) best = { w, lines };
    }
  }
  return best ? best.lines : [words.join(' ')];
}

// Break at whichever word gap leaves the two lines closest in width.
function splitTwo(doc, words) {
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const diff = Math.abs(doc.getTextWidth(a) - doc.getTextWidth(b));
    if (!best || diff < best.diff) best = { diff, lines: [a, b] };
  }
  return best ? best.lines : [words.join(' ')];
}

