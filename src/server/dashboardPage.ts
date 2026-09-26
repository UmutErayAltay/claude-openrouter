import { DASHBOARD_CSS } from "./dashboardStyles.js";
import { DASHBOARD_JS } from "./dashboardScript.js";

/**
 * The whole page is a single self-contained document: no CDN, no build step.
 * The CSS and JS are embedded as separate string modules and stitched in
 * here so each stays readable (and, for the JS, syntax-highlighted) on its
 * own; see dashboardScript.ts for the rule that keeps this safe (no
 * backtick or ${...} inside DASHBOARD_JS, since it lives inside this file's
 * own template literal by way of dashboardScript.ts's).
 */
export function buildDashboardHtml(): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-openrouter</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-title">
    <span class="dot" id="statusDot"></span>
    <h1>claude-openrouter</h1>
  </div>
  <div class="topbar-right">
    <div class="topbar-meta" id="statusMeta">yukleniyor...</div>
    <div class="actions">
      <button id="restartProxyBtn" class="btn btn-secondary btn-small" type="button">Yeniden baslat</button>
      <button id="stopProxyBtn" class="btn btn-danger btn-small" type="button">Durdur</button>
    </div>
  </div>
</header>

<main>
  <div id="budgetBanner" class="banner hidden"></div>

  <div class="stat-grid" id="statGrid">
    <div class="stat"><div class="label">Bugun harcama</div><div class="value na">-</div></div>
    <div class="stat"><div class="label">Bugun istek</div><div class="value na">-</div></div>
    <div class="stat"><div class="label">Basari orani</div><div class="value na">-</div></div>
    <div class="stat"><div class="label">Ekli model</div><div class="value">-</div></div>
  </div>

  <section class="card health-card" id="healthCard">
    <div class="card-header">
      <h2>Saglik durumu</h2>
      <div class="health-summary" id="healthSummary"></div>
    </div>
    <ul class="health-list" id="healthList"><li class="empty-row">yukleniyor...</li></ul>
  </section>

  <section class="card" id="creditCard">
    <h2>Kalan kredi</h2>
    <div id="creditBody">yukleniyor...</div>
    <div class="credit-sub" id="creditProjection"></div>
  </section>

  <section class="card" id="resultsCard">
    <div class="card-header">
      <h2>Istek sonuclari</h2>
      <div class="legend" id="resultsLegend"></div>
    </div>
    <div class="chart-wrap">
      <div id="resultsList" class="bar-list"><p class="bar-empty">Henuz veri yok</p></div>
      <div class="chart-tip" id="resultsTip"></div>
    </div>
  </section>

  <section class="card">
    <h2 id="dailyChartTitle">Gunluk harcama (son 14 gun)</h2>
    <div class="chart-wrap">
      <div id="dailyChart"></div>
      <div class="chart-tip" id="dailyTip"></div>
    </div>
    <div class="totals" id="usageTotals"></div>
  </section>

  <section class="card" id="latencyCard">
    <div class="card-header">
      <h2>Gecikme (son 24 saat)</h2>
      <div class="legend" id="latencyLegend"></div>
    </div>
    <div class="chart-wrap">
      <div id="latencyChart"></div>
      <div class="chart-tip" id="latencyTip"></div>
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <h2>Model bazinda harcama</h2>
      <div class="bar-list" id="byModelBody"><p class="bar-empty">Henuz kayit yok.</p></div>
    </section>
    <section class="card">
      <div class="card-header">
        <h2>Son istekler</h2>
        <div class="actions">
          <label class="log-toggle"><input type="checkbox" id="onlyErrorsToggle"> sadece hatalar</label>
          <select id="recentModelFilter" class="filter-select">
            <option value="">Tum modeller</option>
          </select>
        </div>
      </div>
      <div class="table-scroll recent-scroll">
      <table>
        <thead><tr><th>Zaman</th><th>Model</th><th>Sonuc</th><th class="mono">Sure</th><th class="mono">Maliyet</th></tr></thead>
        <tbody id="recentBody"><tr class="empty-row"><td colspan="5">yukleniyor...</td></tr></tbody>
      </table>
      </div>
    </section>
  </div>

  <section class="card">
    <div class="card-header">
      <h2>Ekli modeller</h2>
      <div class="actions">
        <button id="newModelBtn" class="btn" type="button">+ Yeni model</button>
        <span class="badge" id="syncStatusBadge">-</span>
        <button id="syncBtn" class="btn" type="button">Menuye yaz</button>
        <button id="revertBtn" class="btn btn-secondary" type="button">Son sync'i geri al</button>
        <a id="exportBtn" class="btn btn-secondary" href="/dashboard/api/export" download>Disa aktar</a>
      </div>
    </div>
    <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Model</th><th>Reasoning</th><th>Saglayici</th><th>Akis</th><th></th>
        </tr>
      </thead>
      <tbody id="modelsBody"><tr class="empty-row"><td colspan="5">yukleniyor...</td></tr></tbody>
    </table>
    </div>
  </section>

  <section class="card hidden" id="modelFormCard">
    <h2 id="modelFormTitle">Model ekle</h2>
    <div class="search-row">
      <input id="catalogSearch" type="text" placeholder="OpenRouter kataloginda ara (ornek: deepseek, gpt-5, qwen)" autocomplete="off">
      <div id="catalogResults" class="catalog-results"></div>
    </div>
    <form id="modelForm" class="model-form">
      <label class="span-3">Model ID
        <input id="fModelId" type="text" placeholder="openai/gpt-5" required>
      </label>
      <label>Etiket
        <input id="fLabel" type="text" placeholder="/model menusunde gorunecek ad">
      </label>
      <label>Aciklama
        <input id="fDescription" type="text">
      </label>
      <label>Baglam (token)
        <input id="fContext" type="number" min="0">
      </label>
      <label>Cikti ust siniri
        <input id="fMaxTokens" type="number" min="0">
      </label>
      <label>Behaves-as (Claude model)
        <input id="fBehavesAs" type="text" placeholder="claude-sonnet-5">
      </label>
      <label>Reasoning effort
        <select id="fReasoning">
          <option value="">(saglayici varsayilani)</option>
          <option value="none">none</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </label>
      <label>Saglayici sirasi
        <select id="fSort">
          <option value="">(varsayilan)</option>
          <option value="price">en ucuz</option>
          <option value="throughput">en hizli (throughput)</option>
          <option value="latency">en dusuk gecikme</option>
        </select>
      </label>
      <label>Akis
        <select id="fStream">
          <option value="">(otomatik)</option>
          <option value="true">acik</option>
          <option value="false">kapali</option>
        </select>
      </label>
      <label>Kuantizasyonlar
        <input id="fQuantizations" type="text" placeholder="fp8,bf16,fp16">
      </label>
      <label>Girdi $/M ust siniri
        <input id="fMaxPriceIn" type="number" min="0" step="0.01">
      </label>
      <label>Cikti $/M ust siniri
        <input id="fMaxPriceOut" type="number" min="0" step="0.01">
      </label>
      <div class="form-actions">
        <button type="submit" class="btn" id="modelFormSubmit">Ekle</button>
        <button type="button" class="btn btn-secondary hidden" id="modelFormCancel">Vazgec</button>
      </div>
    </form>
  </section>

  <section class="card">
    <div class="card-header">
      <h2>Alt ajanlar</h2>
      <button id="newAgentBtn" class="btn" type="button">+ Ajan olustur</button>
    </div>
    <div class="hint" id="agentsHint"></div>
    <div class="table-scroll">
    <table>
      <thead><tr><th>Ad</th><th>Kapsam</th><th>Model</th><th>Tool'lar</th><th class="mono" title="ajanin modeline gore yaklasik">24s istek</th><th class="mono" title="ajanin modeline gore yaklasik">24s maliyet</th><th></th><th></th></tr></thead>
      <tbody id="agentsBody"><tr class="empty-row"><td colspan="8">yukleniyor...</td></tr></tbody>
    </table>
    </div>
    <div class="hidden" id="agentFormPanel">
    <form id="agentForm" class="agent-form">
      <label>Ad
        <input id="aName" type="text" value="dosya-kodcu" required>
      </label>
      <label>Model
        <select id="aModel"></select>
      </label>
      <label>Kapsam
        <select id="aScope">
          <option value="project">Proje (.claude/agents)</option>
          <option value="user">Kullanici (~/.claude/agents)</option>
        </select>
      </label>
      <div class="form-actions">
        <button type="submit" class="btn">Ajan olustur</button>
        <button type="button" class="btn btn-secondary" id="agentFormCancel">Vazgec</button>
      </div>
    </form>
    </div>
  </section>

  <section class="card">
    <div class="card-header">
      <h2>Proxy loglari</h2>
      <div class="actions">
        <button id="logToggleBtn" class="btn btn-small btn-secondary" type="button">Goster</button>
        <label class="log-toggle"><input type="checkbox" id="logAutoRefresh" checked> otomatik yenile</label>
      </div>
    </div>
    <pre id="logBox" class="log-box hidden">yukleniyor...</pre>
  </section>
</main>

<div id="toast" class="toast hidden"></div>

<script>${DASHBOARD_JS}</script>
</body>
</html>
`;
}
