export const DASHBOARD_CSS = `
:root {
  --bg: #12161b;
  --bg-elev: #191f26;
  --bg-elev-2: #20272f;
  --border: #2b333d;
  --text: #e8e4d9;
  --text-dim: #a3a8ad;
  --text-faint: #6d747b;
  --accent: #d4a656;
  --accent-dim: #a8843f;
  --accent-bg: rgba(212, 166, 86, 0.12);
  --series-1: #4d78c4;
  --success: #45a888;
  --danger: #c0403a;
  --warning: #c9931f;
  --radius: 4px;
  /* Türetilmiş tonlar: ham renk yalnızca bu blokta. */
  --on-accent: #1a1408;
  --accent-hover: #e0b571;
  --accent-border: rgba(212, 166, 86, 0.4);
  --danger-bg: rgba(192, 64, 58, 0.14);
  --danger-border: rgba(192, 64, 58, 0.38);
  --success-border: rgba(69, 168, 136, 0.4);
  --success-dim: rgba(69, 168, 136, 0.18);
  --warning-dim: rgba(201, 147, 31, 0.18);
  --danger-dim: rgba(192, 64, 58, 0.18);
  --log-bg: #0d1116;
  --scrim: rgba(0, 0, 0, 0.3);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}

header.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 8px;
}

.topbar-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.topbar-title h1 {
  font-size: 15px;
  margin: 0;
  font-weight: 600;
  letter-spacing: 0;
}

.topbar-meta {
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-faint);
  display: inline-block;
  flex-shrink: 0;
}
.dot.ok { background: var(--success); }
.dot.bad { background: var(--danger); }

main {
  max-width: 980px;
  margin: 0;
  padding: 20px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
}

.card h2 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin: 0 0 12px 0;
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.card-header h2 { margin: 0; }

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 720px) {
  .grid-2 { grid-template-columns: 1fr; }
  main { padding: 16px; }
}

/* ---- Özet: stat tile satırı ---- */

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
@media (max-width: 720px) {
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
}

.stat {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  min-width: 0;
}
.stat .label {
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.02em;
}
.stat .value {
  font-family: var(--sans);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
.stat .value.na { color: var(--text-faint); }

/* ---- Kredi ---- */

.credit-numbers {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  align-items: baseline;
}
.credit-figure .value {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  font-weight: 600;
}
.credit-figure .label {
  color: var(--text-dim);
  font-size: 11px;
  margin-top: 2px;
}
.credit-bar {
  margin-top: 12px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--gauge-hue-dim, var(--bg-elev-2));
}
.credit-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--gauge-hue, var(--text-faint));
}
.credit-sub {
  margin-top: 10px;
  color: var(--text-dim);
  font-size: 11px;
  font-family: var(--mono);
}

.error-box {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--text);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-size: 13px;
}
.error-box code {
  font-family: var(--mono);
  background: var(--scrim);
  padding: 1px 5px;
  border-radius: 2px;
}

/* ---- Grafik: günlük harcama (ham inline SVG) ---- */

.chart-wrap {
  position: relative;
}
.chart-svg {
  display: block;
  width: 100%;
  overflow: visible;
}
.chart-grid {
  stroke: var(--border);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.chart-y-label,
.chart-x-label {
  fill: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.chart-bar-rect { fill: var(--series-1); }
.chart-bar-rect.today { fill: var(--accent); }
.chart-bar-rect:hover { opacity: 0.75; }
.chart-tip {
  display: none;
  position: absolute;
  z-index: 4;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  padding: 5px 8px;
  border-radius: 2px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text);
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
}
.chart-tip.open { display: block; }
.chart-empty,
.bar-empty {
  color: var(--text-faint);
  font-size: 12px;
  font-style: italic;
  padding: 18px 0;
}

.totals {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.totals b { color: var(--text); font-family: var(--sans); font-variant-numeric: tabular-nums; }

/* ---- Yatay çubuk listeleri (model harcaması / istek sonuçları) ---- */

.bar-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bar-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.bar-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.bar-name {
  font-family: var(--mono);
  font-size: 12px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-value {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text);
  flex-shrink: 0;
}
.bar-track {
  position: relative;
  display: flex;
  gap: 2px;
  height: 8px;
  background: var(--bg-elev-2);
  border-radius: 2px;
  overflow: visible;
}
.bar-fill {
  height: 100%;
  min-width: 0;
  background: var(--series-1);
  border-radius: 2px;
}
.bar-sub {
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.bar-seg {
  height: 100%;
  min-width: 0;
}
.bar-seg.ok { background: var(--success); }
.bar-seg.err { background: var(--danger); }
.bar-seg:hover { opacity: 0.75; }

.legend {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-dim);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend .swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  display: inline-block;
  flex-shrink: 0;
}
.legend .swatch.ok { background: var(--success); }
.legend .swatch.err { background: var(--danger); }

/* ---- Tablolar ---- */

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th {
  text-align: left;
  color: var(--text-faint);
  font-weight: 500;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
  font-variant-numeric: tabular-nums;
}
tr:last-child td { border-bottom: none; }
td.mono, th.mono { font-family: var(--mono); white-space: nowrap; }
/* Wide tables scroll inside their own box instead of wrapping numbers
   onto three lines or pushing the page sideways. */
.table-scroll { overflow-x: auto; }
tbody tr:hover td { background: var(--bg-elev-2); }
.empty-row td {
  color: var(--text-faint);
  font-style: italic;
  padding: 14px 8px;
}

.badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 2px;
  font-family: var(--mono);
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.badge.on { border-color: var(--accent-border); color: var(--accent); background: var(--accent-bg); }
.badge.off { opacity: 0.6; }

.btn {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
  padding: 6px 13px;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.btn-secondary:hover { color: var(--text); border-color: var(--text-faint); background: transparent; }
.btn-danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger-border);
}
.btn-danger:hover { background: var(--danger-bg); }
.btn-small { padding: 4px 10px; font-size: 12px; }

.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }

input, select {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
}
input:focus, select:focus { outline: 1px solid var(--accent-dim); outline-offset: 1px; }
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
}

.search-row { position: relative; margin-bottom: 12px; }
.search-row input { width: 100%; }
.catalog-results {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  max-height: 260px;
  overflow-y: auto;
  z-index: 5;
  display: none;
}
.catalog-results.open { display: block; }
.catalog-result {
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.catalog-result:last-child { border-bottom: none; }
.catalog-result:hover { background: var(--accent-bg); }
.catalog-result .cr-id { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.catalog-result .cr-name { font-size: 12px; color: var(--text-dim); }

.model-form, .agent-form {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 4px;
}
.agent-form { grid-template-columns: 2fr 2fr 1fr auto; align-items: end; }
@media (max-width: 720px) {
  .model-form { grid-template-columns: 1fr 1fr; }
  .agent-form { grid-template-columns: 1fr; }
}
.model-form .span-3 { grid-column: span 3; }
.model-form .form-actions { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; }
.hidden { display: none !important; }

.hint { color: var(--text-faint); font-size: 11px; margin-bottom: 10px; }

.toast {
  position: fixed;
  bottom: 18px;
  right: 18px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  font-size: 13px;
  max-width: 360px;
  z-index: 20;
}
.toast.error { border-color: var(--danger-border); color: var(--danger); }
.toast.success { border-color: var(--success-border); color: var(--success); }

.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.health-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.health-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.health-list .health-icon {
  font-family: var(--mono);
  font-size: 11px;
  width: 14px;
  flex-shrink: 0;
}
.health-list li.ok .health-icon { color: var(--success); }
.health-list li.fail .health-icon { color: var(--danger); }
.health-list .health-hint {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--mono);
}

.filter-select { min-width: 140px; }

.log-toggle {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.log-toggle input { margin: 0; }

.log-box {
  background: var(--log-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  max-height: 320px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  color: var(--text-dim);
}

.badge.sync-ok { border-color: var(--success-border); color: var(--success); }
.badge.sync-stale { border-color: var(--danger-border); color: var(--danger); }
.badge.auto-recovered { border-color: var(--accent-border); color: var(--accent); background: var(--accent-bg); margin-left: 6px; }

.providers-row td {
  background: var(--bg-elev-2);
  padding: 10px 14px;
}
.providers-table { width: 100%; font-size: 12px; }
.providers-table th, .providers-table td { padding: 4px 8px; }

.test-result {
  margin-top: 6px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-dim);
  white-space: pre-wrap;
}
.test-result.error { color: var(--danger); }
`;
