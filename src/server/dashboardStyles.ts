export const DASHBOARD_CSS = `
:root {
  --bg: #101012;
  --bg-elev: #18181b;
  --bg-elev-2: #1f1f23;
  --border: #2a2a2f;
  --text: #e9e7e3;
  --text-dim: #9b9894;
  --text-faint: #6f6d6a;
  --accent: #d97757;
  --accent-dim: #a85f43;
  --accent-bg: rgba(217, 119, 87, 0.12);
  --danger: #e0645a;
  --danger-bg: rgba(224, 100, 90, 0.12);
  --success: #6fb377;
  --radius: 10px;
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
  padding: 16px 20px;
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
  font-size: 16px;
  margin: 0;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.topbar-meta {
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--mono);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-faint);
  display: inline-block;
  flex-shrink: 0;
}
.dot.ok { background: var(--success); }
.dot.bad { background: var(--danger); }

main {
  max-width: 980px;
  margin: 0 auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
}

.card h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: 0 0 14px 0;
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.card-header h2 { margin: 0; }

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
@media (max-width: 720px) {
  .grid-2 { grid-template-columns: 1fr; }
  main { padding: 16px; }
}

.credit-numbers {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
  align-items: baseline;
}
.credit-figure .value {
  font-family: var(--mono);
  font-size: 26px;
  font-weight: 600;
}
.credit-figure .label {
  color: var(--text-dim);
  font-size: 12px;
  margin-top: 2px;
}
.credit-bar {
  margin-top: 12px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-elev-2);
  overflow: hidden;
}
.credit-bar-fill {
  height: 100%;
  background: var(--accent);
}
.credit-sub {
  margin-top: 10px;
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--mono);
}

.error-box {
  background: var(--danger-bg);
  border: 1px solid rgba(224, 100, 90, 0.35);
  color: var(--text);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
}
.error-box code {
  font-family: var(--mono);
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 5px;
  border-radius: 4px;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 90px;
  margin-bottom: 10px;
}
.chart-bar {
  flex: 1;
  background: var(--accent-dim);
  border-radius: 3px 3px 0 0;
  min-height: 2px;
  position: relative;
}
.chart-bar:hover { background: var(--accent); }
.chart-bar .chart-tip {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  padding: 4px 7px;
  border-radius: 6px;
  font-size: 11px;
  font-family: var(--mono);
  white-space: nowrap;
  margin-bottom: 4px;
}
.chart-bar:hover .chart-tip { display: block; }

.totals {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  color: var(--text-dim);
  font-size: 12px;
  font-family: var(--mono);
}
.totals b { color: var(--text); font-family: var(--sans); }

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
  letter-spacing: 0.03em;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 8px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
tr:last-child td { border-bottom: none; }
td.mono, th.mono { font-family: var(--mono); }
.empty-row td {
  color: var(--text-faint);
  font-style: italic;
  padding: 14px 8px;
}

.badge {
  display: inline-block;
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  font-family: var(--mono);
  border: 1px solid var(--border);
  color: var(--text-dim);
  white-space: nowrap;
}
.badge.on { border-color: rgba(217, 119, 87, 0.4); color: var(--accent); background: var(--accent-bg); }
.badge.off { opacity: 0.6; }

.btn {
  background: var(--accent);
  color: #17110d;
  border: none;
  padding: 7px 14px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover { background: #e18463; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.btn-secondary:hover { color: var(--text); border-color: var(--text-faint); }
.btn-danger {
  background: transparent;
  color: var(--danger);
  border: 1px solid rgba(224, 100, 90, 0.35);
}
.btn-danger:hover { background: var(--danger-bg); }
.btn-small { padding: 4px 10px; font-size: 12px; }

.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.row-actions { display: flex; gap: 6px; }

input, select {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  padding: 7px 10px;
  font-size: 13px;
  font-family: inherit;
}
input:focus, select:focus { outline: 1px solid var(--accent-dim); }
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
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
  border-radius: 8px;
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
.catalog-result:hover { background: rgba(217, 119, 87, 0.08); }
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

.hint { color: var(--text-faint); font-size: 12px; margin-bottom: 10px; }

.toast {
  position: fixed;
  bottom: 18px;
  right: 18px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  max-width: 360px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 20;
}
.toast.error { border-color: rgba(224, 100, 90, 0.4); color: var(--danger); }
.toast.success { border-color: rgba(111, 179, 119, 0.4); color: var(--success); }
`;
