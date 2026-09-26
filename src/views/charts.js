'use strict';
// Server-rendered SVG charts for the dashboard. No client library, no build.
//
// Geometry: horizontal positions are percentages of the SVG's own width and
// vertical positions are CSS pixels. One render therefore fits any container
// width while text stays at its real size (nothing is scaled by a viewBox).
//
// Direction: the dashboard is RTL, so time and other ordered axes run
// right-to-left by default: item 0 (the oldest day, hour 0) sits at the right
// edge and the newest at the left. Pass `rtl: false` to flip.
//
// Colors are passed in by the caller (usually CSS variables such as
// 'var(--viz-answered)', defined in site.css) and applied through `style`.
//
// Hover/focus details: marks carry `data-tip` JSON ({ t: title, r: [[label,
// value, color]], f: footnote }) that public/js/reports.js turns into a
// tooltip; a native <title> keeps the details reachable without JS, and every
// chart should be paired with a tableView() twin.
const { esc, formatNumber } = require('../util');

let seq = 0;
function uid(prefix) {
  seq = (seq + 1) % 1e9;
  return `${prefix}${seq}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v, digits = 3) {
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, num(v)));
}

// Percentage attribute value, always inside [0, 100].
function pc(v) {
  return `${round(clamp(v, 0, 100))}%`;
}

function px(v) {
  return String(round(v, 2));
}

function tipAttr(tip) {
  return tip ? ` data-tip="${esc(JSON.stringify(tip))}"` : '';
}

function titleOf(tip) {
  if (!tip) return '';
  const lines = [tip.t, ...(tip.r || []).map(r => `${r[0]}: ${r[1]}`), tip.f].filter(Boolean);
  return `<title>${esc(lines.join('\n'))}</title>`;
}

// Round axis scale for counts: integer steps of 1/2/5 x 10^n, 3-5 intervals,
// picking the tightest top so the data fills the plot.
function niceScale(max, counts = [3, 4, 5]) {
  const m = Math.max(0, num(max));
  if (m === 0) return { max: 4, step: 1, ticks: [0, 1, 2, 3, 4] };
  let best = null;
  for (const count of [].concat(counts)) {
    const raw = m / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / mag;
    const step = Math.max(1, Math.round((norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag));
    const top = Math.ceil(m / step) * step;
    if (!best || top < best.max || (top === best.max && step > best.step)) best = { max: top, step };
  }
  const ticks = [];
  for (let t = 0; t <= best.max; t += best.step) ticks.push(t);
  return { ...best, ticks };
}

// Horizontal slot i of n (left edge %, width %), honouring direction.
function slot(i, n, rtl) {
  const w = 100 / Math.max(1, n);
  return { x: (rtl ? n - 1 - i : i) * w, w };
}

// A column with a 4px rounded data-end and a square base: a rounded rect plus
// a square rect over its lower part. xAttr/wAttr are ready attribute values.
function roundedTopRect(xAttr, wAttr, y, h, style, cls = 'viz-bar') {
  const r = Math.min(4, h / 2);
  let out = `<rect class="${cls}" x="${xAttr}" width="${wAttr}" y="${px(y)}" height="${px(h)}" rx="${px(r)}" ry="${px(r)}" style="${style}"/>`;
  if (h > r) out += `<rect class="${cls}" x="${xAttr}" width="${wAttr}" y="${px(y + r)}" height="${px(h - r)}" style="${style}"/>`;
  return out;
}

/**
 * Stacked column chart over ordered slots (e.g. days).
 * slots:  [{ values: number[] (one per series, bottom -> top), label?, sub?, tick?: bool, tip? }]
 * series: [{ label, color }]
 * barPx:  fixed column width in px. Defaults to 22px for <= 7 slots (fits a
 *         plot as narrow as ~200px); more slots use a share of each slot, so
 *         columns stay thin on wide screens and never touch on narrow ones.
 * Returns an HTML string: y-axis gutter + <svg> + x labels.
 */
function columnChart({ slots = [], series = [], height = 200, ariaLabel = '', rtl = true, annotateMax = true, gap = 2, barPx } = {}) {
  const n = slots.length;
  const totals = slots.map(s => (s.values || []).reduce((a, v) => a + Math.max(0, num(v)), 0));
  const peak = Math.max(0, ...totals);
  const scale = niceScale(peak);
  const top = 22; // room for the peak label
  const base = top + height;
  const H = base + 40; // two lines of x labels
  const y = v => base - (clamp(v, 0, scale.max) / scale.max) * height;
  const fixed = barPx !== undefined ? Math.max(1, num(barPx)) : (n <= 7 ? 22 : 0);
  const frac = n <= 31 ? 0.58 : 0.66;

  let grid = '';
  let yLabels = `<span class="viz-ysizer">${formatNumber(scale.max)}</span>`;
  for (const t of scale.ticks) {
    const gy = Math.round(y(t)) + 0.5; // crisp 1px hairline
    grid += `<line class="${t === 0 ? 'viz-base' : 'viz-grid'}" x1="0" x2="100%" y1="${px(gy)}" y2="${px(gy)}"/>`;
    yLabels += `<span style="top:${px(gy)}px">${formatNumber(t)}</span>`;
  }

  let cols = '';
  let labels = '';
  let peakIdx = -1;
  if (annotateMax && peak > 0) peakIdx = totals.lastIndexOf(peak);
  slots.forEach((s, i) => {
    const { x, w } = slot(i, n, rtl);
    const cx = x + w / 2;
    // Horizontal geometry as attribute values; fixed-width columns are centred
    // with a pixel translate on their group.
    const xAttr = fixed ? pc(cx) : pc(x + (w * (1 - frac)) / 2);
    const wAttr = fixed ? px(fixed) : pc(w * frac);
    const vals = series.map((_, k) => Math.max(0, num((s.values || [])[k])));
    let topK = -1;
    vals.forEach((v, k) => { if (v > 0) topK = k; });
    let bars = '';
    let cum = 0;
    vals.forEach((v, k) => {
      if (v <= 0) return;
      const y0 = y(cum);
      const y1 = y(cum + v);
      cum += v;
      const style = `fill:${esc(series[k].color)}`;
      if (k === topK) {
        const h = Math.max(2, y0 - y1);
        bars += roundedTopRect(xAttr, wAttr, y0 - h, h, style);
      } else {
        const h = Math.max(1.5, y0 - y1 - gap);
        bars += `<rect class="viz-bar" x="${xAttr}" width="${wAttr}" y="${px(y0 - h)}" height="${px(h)}" style="${style}"/>`;
      }
    });
    if (fixed && bars) bars = `<g transform="translate(${px(-fixed / 2)} 0)">${bars}</g>`;
    cols += `<g class="viz-col" data-kx="${i}" data-ky="0"${tipAttr(s.tip)}>${titleOf(s.tip)}<rect class="viz-hit" x="${pc(x)}" width="${pc(w)}" y="0" height="${px(base)}"/>${bars}</g>`;
    if (i === peakIdx) {
      labels += `<text class="viz-peak" x="${pc(cx)}" y="${px(y(peak) - 7)}" text-anchor="middle">${formatNumber(peak)}</text>`;
    }
    if (s.tick) {
      labels += `<text class="viz-xl" x="${pc(cx)}" y="${px(base + 17)}" text-anchor="middle">${esc(s.label || '')}</text>`;
      if (s.sub) labels += `<text class="viz-xl viz-xl-sub" x="${pc(cx)}" y="${px(base + 33)}" text-anchor="middle">${esc(s.sub)}</text>`;
    }
  });

  return `<div class="viz viz-cols" data-keys>
  <div class="viz-yaxis" aria-hidden="true" style="height:${H}px">${yLabels}</div>
  <svg class="viz-svg" width="100%" height="${H}" role="img" aria-label="${esc(ariaLabel)}" overflow="visible">${grid}${cols}${labels}</svg>
</div>`;
}

// Sequential bin for a heatmap cell: 0 -> empty color, else one of ramp.
function binIndex(v, max, bins) {
  const value = num(v);
  if (value <= 0 || max <= 0) return -1;
  return Math.min(bins - 1, Math.max(0, Math.ceil((value / max) * bins) - 1));
}

/**
 * Heatmap grid (e.g. weekday x hour).
 * rows:   [{ label, short? }]           top -> bottom
 * cols:   [{ label?, tick?: string }]   ordered; tick text is drawn under the column
 * values: number[rows][cols]
 * ramp:   sequential colors, light -> dark; empty: color for zero
 * tip(r, c, v): tooltip object for a cell
 */
function heatmap({ rows = [], cols = [], values = [], ramp = [], empty = '#f1f2f6', cellHeight = 24, tip = null, ariaLabel = '', rtl = true } = {}) {
  const nr = rows.length;
  const nc = cols.length;
  const flat = values.flat().map(num);
  const max = Math.max(0, ...flat);
  const H = nr * cellHeight;
  const total = H + 24;
  let cells = '';
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      const v = Math.max(0, num((values[r] || [])[c]));
      const bin = binIndex(v, max, ramp.length);
      const color = bin < 0 ? empty : ramp[bin];
      const { x, w } = slot(c, nc, rtl);
      const t = tip ? tip(r, c, v) : null;
      cells += `<rect class="viz-cell" data-kx="${c}" data-ky="${r}" x="${pc(x)}" width="${pc(w)}" y="${px(r * cellHeight)}" height="${px(cellHeight)}" rx="4" ry="4" style="fill:${esc(color)}"${tipAttr(t)}>${titleOf(t)}</rect>`;
    }
  }
  let ticks = '';
  cols.forEach((col, c) => {
    if (!col.tick) return;
    const { x, w } = slot(c, nc, rtl);
    ticks += `<text class="viz-xl" x="${pc(x + w / 2)}" y="${px(H + 17)}" text-anchor="middle">${esc(col.tick)}</text>`;
  });
  const rowLabels = rows.map(r => `<span style="height:${cellHeight}px"><span class="viz-long">${esc(r.label)}</span><span class="viz-short">${esc(r.short || r.label)}</span></span>`).join('');
  return `<div class="viz viz-heat" data-keys>
  <div class="viz-rows" aria-hidden="true">${rowLabels}</div>
  <svg class="viz-svg" width="100%" height="${total}" role="img" aria-label="${esc(ariaLabel)}">${cells}${ticks}</svg>
</div>`;
}

// Legend for a sequential ramp: "empty" swatch, then low -> high.
function scaleLegend(ramp, { empty = '#f1f2f6', emptyLabel = 'بدون داده', low = 'کم', high = 'زیاد' } = {}) {
  const sw = c => `<i class="viz-sw" style="background:${esc(c)}"></i>`;
  return `<div class="viz-scale" aria-hidden="true"><span class="viz-scale-item">${sw(empty)}${esc(emptyLabel)}</span><span class="viz-scale-item">${esc(low)} ${ramp.map(sw).join('')} ${esc(high)}</span></div>`;
}

/**
 * Trend line for a stat tile: muted line + soft wash, newest point marked.
 * values are ordered oldest -> newest; with rtl the newest sits at the left.
 */
function sparkline(values = [], { height = 30, ariaLabel = '', rtl = true, line = 'var(--viz-spark, #9ca3af)', dot = 'var(--primary, #4f46e5)' } = {}) {
  const vals = values.map(v => Math.max(0, num(v)));
  const n = vals.length;
  if (n < 2) return '';
  const max = Math.max(...vals) || 1;
  const pad = 4;
  const h = height - pad * 2;
  const xs = i => (rtl ? n - 1 - i : i);
  const ys = v => pad + (1 - v / max) * h;
  const pts = vals.map((v, i) => `${xs(i)},${round(ys(v), 2)}`);
  const lineD = `M${pts.join('L')}`;
  const areaD = `${lineD}L${xs(n - 1)},${height}L${xs(0)},${height}Z`;
  const last = vals[n - 1];
  return `<svg class="viz-spark" width="100%" height="${height}" role="img" aria-label="${esc(ariaLabel)}" overflow="visible">
<svg width="100%" height="${height}" viewBox="0 0 ${n - 1} ${height}" preserveAspectRatio="none"><path d="${areaD}" style="fill:${esc(line)};opacity:.12"/><path d="${lineD}" fill="none" style="stroke:${esc(line)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
<circle cx="${rtl ? '0%' : '100%'}" cy="${px(ys(last))}" r="4" style="fill:${esc(dot)}" stroke="#fff" stroke-width="2"/>
</svg>`;
}

// Single ratio against its track (0..1), filled from the start side.
function meter(fraction, { color = 'var(--primary, #4f46e5)', track = 'var(--viz-track, #eef0f6)', height = 6, ariaLabel = '', rtl = true } = {}) {
  const f = clamp(fraction, 0, 1) * 100;
  const r = height / 2;
  const fill = f > 0 ? `<rect x="${pc(rtl ? 100 - f : 0)}" width="${pc(f)}" y="0" height="${height}" rx="${r}" ry="${r}" style="fill:${esc(color)}"/>` : '';
  return `<svg class="viz-meter" width="100%" height="${height}" role="img" aria-label="${esc(ariaLabel)}"><rect x="0" width="100%" y="0" height="${height}" rx="${r}" ry="${r}" style="fill:${esc(track)}"/>${fill}</svg>`;
}

// Horizontal bar for ranked lists: grows from the start side, rounded data-end.
function hbar(value, max, { color = 'var(--primary, #4f46e5)', height = 8, rtl = true } = {}) {
  const f = max > 0 ? clamp(num(value) / max, 0, 1) * 100 : 0;
  let bar = '';
  if (f > 0) {
    const x = rtl ? 100 - f : 0;
    const r = Math.min(4, height / 2);
    // Rounded data-end, square at the baseline (the start side).
    bar = `<rect x="${pc(x)}" width="${pc(f)}" y="0" height="${height}" rx="${r}" ry="${r}" style="fill:${esc(color)}"/>`
      + `<rect x="${pc(rtl ? x + f / 2 : 0)}" width="${pc(f / 2)}" y="0" height="${height}" style="fill:${esc(color)}"/>`;
  }
  return `<svg class="viz-hbar" width="100%" height="${height}" aria-hidden="true">${bar}</svg>`;
}

/**
 * 100% stacked bar for part-to-whole (e.g. channels). Parts keep their order
 * and colors; zero parts are skipped. Segments are separated by a 2px gap
 * drawn in the surface color.
 */
function shareBar(parts = [], { height = 16, ariaLabel = '', rtl = true, track = 'var(--viz-track, #eef0f6)', surface = '#fff' } = {}) {
  const vals = parts.map(p => Math.max(0, num(p.value)));
  const total = vals.reduce((a, v) => a + v, 0);
  const id = uid('vizclip');
  const r = Math.min(6, height / 2);
  let segs = '';
  let acc = 0;
  parts.forEach((p, i) => {
    const v = vals[i];
    if (!v || !total) return;
    const w = (v / total) * 100;
    const x = rtl ? 100 - acc - w : acc;
    acc += w;
    const tip = p.tip || null;
    segs += `<rect class="viz-seg" data-kx="${i}" data-ky="0" x="${pc(x)}" width="${pc(w)}" y="0" height="${height}" style="fill:${esc(p.color)}" stroke="${esc(surface)}" stroke-width="2"${tipAttr(tip)}>${titleOf(tip)}</rect>`;
  });
  return `<div class="viz viz-share" data-keys><svg class="viz-svg" width="100%" height="${height}" role="img" aria-label="${esc(ariaLabel)}">
<defs><clipPath id="${id}"><rect x="0" y="0" width="100%" height="${height}" rx="${r}" ry="${r}"/></clipPath></defs>
<g clip-path="url(#${id})"><rect x="0" width="100%" y="0" height="${height}" style="fill:${esc(track)}"/>${segs}</g></svg></div>`;
}

// Legend: a swatch that mirrors the mark (rect for bars/areas) + label + value.
function legend(items = []) {
  return `<ul class="viz-legend">${items.map(it => `<li><i class="viz-sw" style="background:${esc(it.color)}"></i><span>${esc(it.label)}</span>${it.value !== undefined ? `<b>${esc(it.value)}</b>` : ''}</li>`).join('')}</ul>`;
}

// Accessible table twin of a chart, collapsed by default.
function tableView({ summary = 'نمایش جدول داده‌ها', caption = '', head = [], rows = [] } = {}) {
  return `<details class="viz-table"><summary>${esc(summary)}</summary><div class="table-wrap"><table class="table">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}
<thead><tr>${head.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map(r => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

module.exports = {
  niceScale, binIndex, columnChart, heatmap, scaleLegend, sparkline, meter, hbar, shareBar, legend, tableView,
};
