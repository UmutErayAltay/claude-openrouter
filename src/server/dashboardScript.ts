/**
 * The dashboard's client-side JS, as a plain string.
 *
 * HARD RULE: this string must never contain a backtick or a ${ sequence.
 * It's embedded inside dashboardPage.ts's own template literal (by way of
 * the backtick-delimited constant below), so either one would terminate a
 * template literal early and silently break the page. Use single/double
 * quotes and string concatenation with + throughout — never template
 * literals — in everything below.
 */
export const DASHBOARD_JS = `
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var HOUR_MS_TOTAL = 60 * 60 * 1000;
  var lastMetrics = null;
  var lastRecent = null;
  var currentAgents = null;

  function qs(id) { return document.getElementById(id); }

  function td(text, cls) {
    var cell = document.createElement("td");
    if (cls) cell.className = cls;
    cell.textContent = text;
    return cell;
  }

  function setRows(tbodyId, rows, emptyColspan, emptyText) {
    var tbody = qs(tbodyId);
    tbody.textContent = "";
    if (!rows.length) {
      var tr = document.createElement("tr");
      tr.className = "empty-row";
      var cell = document.createElement("td");
      cell.colSpan = emptyColspan;
      cell.textContent = emptyText;
      tr.appendChild(cell);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (row) { tbody.appendChild(row); });
  }

  function fmtMoney(n) {
    if (n === null || n === undefined) return "-";
    if (n === 0) return "$0.00";
    // Cheap/flash models routinely cost a few hundredths of a cent per
    // request; at 2-4 decimals that rounds to "$0.00" and reads as free.
    var abs = Math.abs(n);
    var digits = abs < 0.0001 ? 6 : abs < 0.01 ? 4 : 2;
    return "$" + n.toFixed(digits);
  }

  function fmtNum(n) {
    return (n || 0).toLocaleString("tr-TR");
  }

  function fmtDate(ts) {
    return new Date(ts).toLocaleString("tr-TR");
  }

  function fmtSeconds(n) {
    if (n === null || n === undefined) return null;
    return n.toFixed(1) + "s";
  }

  // Yatay çubuk listelerinin ortak parçası: satır başlığı (ad + değer),
  // çubuk yuvası ve alt satır. Tek ölçü var, dolayısıyla ızgara şeridi
  // ekseni de yok — çubuk uzunluğu doğrudan oran.
  function barRow(name, valueText, subText) {
    var row = document.createElement("div");
    row.className = "bar-row";

    var head = document.createElement("div");
    head.className = "bar-head";
    var nameEl = document.createElement("span");
    nameEl.className = "bar-name";
    nameEl.textContent = name;
    nameEl.title = name; // full id stays reachable when the label is ellipsized
    var valueEl = document.createElement("span");
    valueEl.className = "bar-value";
    valueEl.textContent = valueText;
    head.appendChild(nameEl);
    head.appendChild(valueEl);
    row.appendChild(head);

    var track = document.createElement("div");
    track.className = "bar-track";
    row.appendChild(track);

    if (subText) {
      var sub = document.createElement("div");
      sub.className = "bar-sub";
      sub.textContent = subText;
      row.appendChild(sub);
    }

    row.track = track;
    return row;
  }

  function fillBar(track, ratio, cls) {
    var fill = document.createElement("div");
    fill.className = "bar-fill" + (cls ? " " + cls : "");
    fill.style.width = (isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) * 100 : 0) + "%";
    track.appendChild(fill);
    return fill;
  }

  // Tooltip'i içeriğe sabitlenmiş bir kutu olarak konumlandırır: çubuk ya da
  // SVG çubuğu hover edildiğinde de aynı yol çalışsın diye.
  function showTip(tip, event, text) {
    tip.textContent = text;
    tip.classList.add("open");
    var host = tip.parentNode;
    var hostBox = host.getBoundingClientRect();
    var tipBox = tip.getBoundingClientRect();
    var x = event.clientX - hostBox.left;
    var half = tipBox.width / 2 + 6;
    tip.style.left = Math.max(half, Math.min(hostBox.width - half, x)) + "px";
    tip.style.top = event.clientY - hostBox.top - tipBox.height - 10 + "px";
  }

  function hideTip(tip) {
    tip.classList.remove("open");
  }

  function localDayKey(date) {
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  }

  function api(path, options) {
    return fetch(path, options).then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (body) {
          if (!response.ok) {
            throw new Error((body && body.error) || ("HTTP " + response.status));
          }
          return body;
        });
    });
  }

  function get(path) { return api(path); }
  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  var toastTimer = null;
  function toast(message, kind) {
    var box = qs("toast");
    box.textContent = message;
    box.className = "toast " + (kind || "");
    box.classList.remove("hidden");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { box.classList.add("hidden"); }, 4500);
  }

  function renderStatus(status) {
    var keySourceLabels = {
      env: "ortam degiskeni",
      file: "anahtar dosyasi",
      config: "config dosyasi (eski)",
      none: "yok",
    };
    var keySourceLabel = keySourceLabels[status.keySource] || status.keySource;
    qs("statusMeta").textContent =
      "port " + status.port +
      "  |  " + status.modelCount + " model" +
      "  |  " + status.agentCount + " ajan" +
      "  |  anahtar: " + keySourceLabel;

    var badge = qs("syncStatusBadge");
    if (status.synced) {
      badge.className = "badge sync-ok";
      badge.textContent = "guncel";
    } else {
      badge.className = "badge sync-stale";
      badge.textContent = "degisiklik var";
    }
  }

  // "Detay" düğmesi yalnızca sorun yokken anlamlı: bir kontrol düşünce liste
  // zaten açık kalır ve düğmenin durumu her tazelemede yeniden yazılır.
  var healthAllOk = false;
  // Once the user opens/closes the detail list, refreshes stop overriding it.
  var healthUserToggled = false;

  function renderHealthSummary(summaryHost, okCount, total) {
    summaryHost.textContent = "";
    if (!total) {
      healthAllOk = false;
      return;
    }
    healthAllOk = okCount === total;

    var badge = document.createElement("span");
    badge.className = "badge " + (healthAllOk ? "ok" : "bad");
    badge.textContent = okCount + "/" + total + " saglikli";
    summaryHost.appendChild(badge);

    var note = document.createElement("span");
    note.className = "health-note";
    note.textContent = healthAllOk ? "hepsi yolunda" : okCount + " kontrol dikkat gerektiriyor";
    summaryHost.appendChild(note);

    if (healthAllOk) {
      var detailBtn = document.createElement("button");
      detailBtn.type = "button";
      detailBtn.className = "btn btn-small btn-secondary";
      var list = qs("healthList");
      var open = !list.classList.contains("hidden");
      detailBtn.textContent = open ? "Gizle" : "Detay";
      detailBtn.addEventListener("click", function () {
        healthUserToggled = true;
        var hidden = list.classList.toggle("hidden");
        detailBtn.textContent = hidden ? "Detay" : "Gizle";
      });
      summaryHost.appendChild(detailBtn);
    }
  }

  function renderHealth(payload) {
    var list = qs("healthList");
    var summary = qs("healthSummary");
    list.textContent = "";
    var checks = payload.checks || [];
    if (!checks.length) {
      summary.textContent = "";
      healthAllOk = false;
      var empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "kontrol yok";
      list.appendChild(empty);
      return;
    }
    // Sorunlu satırlar önce: okunacak ilk şey odur.
    checks = checks.slice().sort(function (a, b) {
      return (a.ok === b.ok ? 0 : a.ok ? 1 : -1);
    });
    var okCount = 0;
    checks.forEach(function (check) {
      if (check.ok) okCount++;
      var li = document.createElement("li");
      li.className = check.ok ? "ok" : "fail";
      var icon = document.createElement("span");
      icon.className = "health-icon";
      icon.textContent = check.ok ? "OK" : "X";
      var label = document.createElement("span");
      label.textContent = check.label;
      li.appendChild(icon);
      li.appendChild(label);
      if (!check.ok && check.hint) {
        var hint = document.createElement("span");
        hint.className = "health-hint";
        hint.textContent = check.hint;
        li.appendChild(hint);
      }
      list.appendChild(li);
    });
    // Visibility first, then the summary (its button text reads the list state).
    if (okCount !== checks.length) list.classList.remove("hidden");
    else if (!healthUserToggled) list.classList.add("hidden");
    renderHealthSummary(summary, okCount, checks.length);
  }

  var lastCredit = null;
  var lastUsage = null;

  function renderProjection() {
    var box = qs("creditProjection");
    if (!lastCredit || !lastCredit.ok || !lastUsage) {
      box.textContent = "";
      return;
    }
    var daily = lastUsage.daily || [];
    if (!daily.length) {
      box.textContent = "";
      return;
    }
    var sum = 0;
    daily.forEach(function (d) { sum += d.cost; });
    var avgPerDay = sum / daily.length;
    if (avgPerDay <= 0) {
      box.textContent = "";
      return;
    }
    var monthly = avgPerDay * 30;
    var text = "Ortalama gunluk harcama: " + fmtMoney(avgPerDay) + "  |  30 gunluk tahmin: " + fmtMoney(monthly);
    if (lastCredit.limitRemaining !== null && lastCredit.limitRemaining !== undefined) {
      var daysLeft = avgPerDay > 0 ? Math.floor(lastCredit.limitRemaining / avgPerDay) : null;
      if (daysLeft !== null && isFinite(daysLeft)) {
        text += "  |  bu hizla kalan kredi ~" + daysLeft + " gun yeter";
      }
    }
    box.textContent = text;
  }

  function renderCredit(credit) {
    lastCredit = credit;
    var body = qs("creditBody");
    body.textContent = "";
    var dot = qs("statusDot");

    if (!credit.ok) {
      dot.className = "dot bad";
      var reasonLabels = {
        no_key: "Anahtar yok",
        invalid_key: "Anahtar gecersiz",
        unreachable: "OpenRouter'a ulasilamiyor",
        upstream_error: "OpenRouter hata dondu",
      };
      var box = document.createElement("div");
      box.className = "error-box";
      var strong = document.createElement("strong");
      strong.textContent = (reasonLabels[credit.reason] || "Hata") + ". ";
      box.appendChild(strong);
      box.appendChild(document.createTextNode(credit.message || ""));
      body.appendChild(box);
      renderProjection();
      return;
    }

    dot.className = "dot ok";

    function figure(label, value) {
      var wrap = document.createElement("div");
      wrap.className = "credit-figure";
      var v = document.createElement("div");
      v.className = "value";
      v.textContent = value;
      var l = document.createElement("div");
      l.className = "label";
      l.textContent = label;
      wrap.appendChild(v);
      wrap.appendChild(l);
      return wrap;
    }

    var row = document.createElement("div");
    row.className = "credit-numbers";
    row.appendChild(figure("Kullanim (toplam)", fmtMoney(credit.usage)));
    if (credit.limit !== null) row.appendChild(figure("Limit", fmtMoney(credit.limit)));
    if (credit.limitRemaining !== null) row.appendChild(figure("Kalan", fmtMoney(credit.limitRemaining)));
    row.appendChild(figure("Bugun", fmtMoney(credit.usageDaily)));
    row.appendChild(figure("Bu hafta", fmtMoney(credit.usageWeekly)));
    row.appendChild(figure("Bu ay", fmtMoney(credit.usageMonthly)));
    body.appendChild(row);

    if (credit.limit !== null && credit.limit > 0) {
      var ratio = credit.usage / credit.limit;
      var bar = document.createElement("div");
      bar.className = "credit-bar";
      var fill = document.createElement("div");
      fill.className = "credit-bar-fill";
      // Dolgu tonu kullanım oranına göre; boş kısım aynı tonun soluk hâli.
      // --warning bir grafik serisi değil, yalnızca bu göstergenin orta hâli.
      var hues = ratio >= 0.85
        ? ["var(--danger)", "var(--danger-dim)"]
        : ratio >= 0.6
          ? ["var(--warning)", "var(--warning-dim)"]
          : ["var(--success)", "var(--success-dim)"];
      bar.style.setProperty("--gauge-hue", hues[0]);
      bar.style.setProperty("--gauge-hue-dim", hues[1]);
      var pct = Math.max(0, Math.min(100, ratio * 100));
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      body.appendChild(bar);
    }

    if (credit.label || credit.isFreeTier) {
      var sub = document.createElement("div");
      sub.className = "credit-sub";
      var parts = [];
      if (credit.label) parts.push(credit.label);
      if (credit.isFreeTier) parts.push("ucretsiz katman");
      sub.textContent = parts.join(" - ");
      body.appendChild(sub);
    }
    renderProjection();
  }

  // Dünkü değere göre yüzde değişim. Dün 0'ın üzerindeki ilk gün oran
  // anlamsız olur ("+∞%"), bu yüzden sadece "-" yazılır.
  function deltaText(today, yesterday) {
    if (today === null || today === undefined) return "";
    if (yesterday === null || yesterday === undefined) return "-";
    if (!yesterday) return "-";
    var pct = Math.round(((today - yesterday) / yesterday) * 100);
    if (!pct) return "0% dun gore";
    return (pct > 0 ? "+" : "") + pct + "% dun gore";
  }

  function renderStatTiles() {
    var grid = qs("statGrid");
    if (!grid) return;
    var daily = (lastUsage && lastUsage.daily) || [];
    var last = daily.length ? daily[daily.length - 1] : null;
    // daily bugünü sonda tutar; dün sondan ikinci eleman.
    var prev = daily.length > 1 ? daily[daily.length - 2] : null;
    var totalModels = (currentModels || []).length;
    var successRate = lastMetrics && lastMetrics.totals ? lastMetrics.totals.successRate : null;

    var tiles = [
      {
        label: "Bugun harcama",
        value: last ? fmtMoney(last.cost) : "-",
        na: !last,
        delta: last ? deltaText(last.cost, prev ? prev.cost : null) : "",
      },
      {
        label: "Bugun istek",
        value: last ? fmtNum(last.requests) : "-",
        na: !last,
        delta: last ? deltaText(last.requests, prev ? prev.requests : null) : "",
      },
      {
        label: "Basari orani",
        value: successRate === null || successRate === undefined
          ? "-"
          : (successRate * 100).toFixed(1) + "%",
        na: successRate === null || successRate === undefined,
      },
      { label: "Ekli model", value: fmtNum(totalModels), na: false },
    ];

    grid.textContent = "";
    tiles.forEach(function (tile) {
      var card = document.createElement("div");
      card.className = "stat";
      var label = document.createElement("div");
      label.className = "label";
      label.textContent = tile.label;
      var value = document.createElement("div");
      value.className = "value" + (tile.na ? " na" : "");
      value.textContent = tile.value;
      card.appendChild(label);
      card.appendChild(value);
      if (tile.delta) {
        var delta = document.createElement("div");
        delta.className = "delta" + (tile.delta === "-" ? " empty" : "");
        delta.textContent = tile.delta;
        card.appendChild(delta);
      }
      grid.appendChild(card);
    });
  }

  function renderDailyChart(usage) {
    var host = qs("dailyChart");
    var tip = qs("dailyTip");
    host.textContent = "";
    var daily = usage.daily || [];
    qs("dailyChartTitle").textContent = "Gunluk harcama (son 14 gun)";
    if (!daily.length) {
      var empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = "Henuz istek yok";
      host.appendChild(empty);
      return;
    }
    hideTip(qs("dailyTip"));

    // viewBox kapsayıcının gerçek piksel genişliğine eşitlenir: 1 birim = 1px,
    // böylece eksen etiketleri dar ekranda da 10px kalır.
    var W = Math.max(300, Math.round(host.clientWidth || 800));
    var H = 180;
    var padL = 54;
    var padR = 8;
    var padT = 10;
    var padB = 24;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var todayKey = localDayKey(new Date());
    // Günlük kova boşsa (yalnızca sıfırlar) çubuk/eksen yazdırma.
    var hasData = daily.some(function (d) { return d.requests > 0 || d.cost > 0; });
    if (!hasData) {
      var idle = document.createElement("p");
      idle.className = "chart-empty";
      idle.textContent = "Henuz istek yok";
      host.appendChild(idle);
      return;
    }
    var maxCost = 0;
    var maxRequests = 0;
    daily.forEach(function (d) {
      if (d.cost > maxCost) maxCost = d.cost;
      if (d.requests > maxRequests) maxRequests = d.requests;
    });
    // Maliyet tümüyle sıfır ama istek varsa boş bir "$0.00" grafiğinin yerine
    // istek hacmi çizilir: ölçü değişir, eksen tek kalır.
    var byRequests = maxCost === 0 && maxRequests > 0;
    var valueOf = byRequests
      ? function (d) { return d.requests; }
      : function (d) { return d.cost; };
    var maxValue = byRequests ? maxRequests : maxCost;
    var niceMax = maxValue > 0 ? niceCeil(maxValue) : 1;
    var chartTitle = qs("dailyChartTitle");
    chartTitle.textContent = byRequests
      ? "Gunluk istek (son 14 gun)"
      : "Gunluk harcama (son 14 gun)";

    var svg = svgEl("svg", {
      "class": "chart-svg",
      viewBox: "0 0 " + W + " " + H,
      role: "img",
    });
    svg.setAttribute("aria-label", byRequests ? "Gunluk istek grafigi" : "Gunluk harcama grafigi");

    // 4 hairline yatay gridline + sol eksende fmtMoney etiketleri.
    for (var i = 0; i <= 3; i++) {
      var y = padT + (innerH * i) / 3;
      var value = niceMax * (1 - i / 3);
      svg.appendChild(svgEl("line", {
        "class": "chart-grid",
        x1: padL, y1: y, x2: W - padR, y2: y,
      }));
      var yLabel = svgEl("text", {
        "class": "chart-y-label",
        x: padL - 8,
        y: y + 3,
        "text-anchor": "end",
      });
      yLabel.textContent = byRequests
        ? fmtNum(Math.round(value))
        : fmtMoney(value);
      svg.appendChild(yLabel);
    }

    var slot = innerW / daily.length;
    var barW = Math.min(24, Math.max(3, slot - 4));
    var labelEvery = Math.max(1, Math.ceil((daily.length * 42) / innerW));

    daily.forEach(function (d, index) {
      var ratio = maxValue > 0 ? Math.min(1, valueOf(d) / niceMax) : 0;
      var barH = maxValue > 0 ? Math.max(2, ratio * innerH) : 0;
      var x = padL + slot * index + (slot - barW) / 2;
      var y = padT + innerH - barH;
      // <rect> dört köşeyi de yuvarlar; tabanın köşeli kalması için yol
      // (path) ile üst köşeler yuvarlatılır, taban çizgisi düz bırakılır.
      var r = Math.min(4, barW / 2, barH / 2);
      var rect = svgEl("path", {
        "class": "chart-bar-rect" + (d.date === todayKey ? " today" : ""),
        d:
          "M" + round2(x) + "," + round2(padT + innerH) +
          "V" + round2(y + r) +
          "A" + r + "," + r + " 0 0 1 " + round2(x + r) + "," + round2(y) +
          "H" + round2(x + barW - r) +
          "A" + r + "," + r + " 0 0 1 " + round2(x + barW) + "," + round2(y + r) +
          "V" + round2(padT + innerH) + "Z",
      });
      rect.style.cursor = "pointer";
      var title = svgEl("title", {});
      // İki ölçü varsa ikisi de tooltip'te görünür; eksen tek ölçüyü anlatır.
      title.textContent = byRequests
        ? d.date + ": " + fmtNum(d.requests) + " istek · " + fmtMoney(d.cost)
        : d.date + ": " + fmtMoney(d.cost) + " (" + d.requests + " istek)";
      rect.appendChild(title);
      rect.addEventListener("mousemove", function (event) {
        showTip(tip, event, title.textContent);
      });
      rect.addEventListener("mouseleave", function () { hideTip(tip); });
      svg.appendChild(rect);

      if (index % labelEvery === 0) {
        var parts = String(d.date).split("-");
        var xLabel = svgEl("text", {
          "class": "chart-x-label",
          x: round2(x + barW / 2),
          y: H - 8,
          "text-anchor": "middle",
        });
        xLabel.textContent = parts.length === 3 ? parts[1] + "." + parts[2] : d.date;
        svg.appendChild(xLabel);
      }
    });

    host.appendChild(svg);
  }

  // Eksen tavanını 1/2/5 x 10^n adımına yuvarlar; böylece etiketler hem
  // okunaklı kalır hem de tavanın üstünde çubuk kalmaz.
  function niceCeil(value) {
    if (!(value > 0)) return 1;
    var exp = Math.floor(Math.log10(value));
    var pow = Math.pow(10, exp);
    var norm = value / pow;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * pow;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  // ---- Gecikme grafiği (son 24 saat, saat kovalı p95) ----

  var LATENCY_HOURS = 24;
  var LATENCY_MAX_SERIES = 4;
  var HOURLY_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];

  // Dakika hassasiyetinde yuvarlar, böylece "14:05:00" gibi etiketler çıkmaz.
  function hourLabel(hourStart) {
    var d = new Date(hourStart);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // p95 ekseni saniye cinsinden; 1200s'yi "20dk" okunur biçimde yazar.
  function fmtLatency(seconds) {
    if (seconds === null || seconds === undefined) return "-";
    if (seconds < 60) return seconds.toFixed(1) + "s";
    if (seconds < 600) return (seconds / 60).toFixed(1) + "dk";
    return Math.round(seconds / 60) + "dk";
  }

  // Eksen tavanı: bir dakikalık adımları önce dener, olmazsa 1/2/5 x 10^n.
  function latencyCeil(maxValue) {
    if (!(maxValue > 0)) return 1;
    for (var i = 0; i < HOURLY_STEPS.length; i++) {
      if (maxValue <= HOURLY_STEPS[i]) return HOURLY_STEPS[i];
    }
    return niceCeil(maxValue);
  }

  function renderLatencyChart(payload) {
    var host = qs("latencyChart");
    var legend = qs("latencyLegend");
    var tip = qs("latencyTip");
    if (!host) return;
    host.textContent = "";
    legend.textContent = "";

    var timeline = (payload && payload.timeline) || [];
    // Çizgi kesikliği olmayan bir grafikte, saat kovaları arasında boşluk
    // yanlış okunmasın diye tüm kovalar birleştirilir.
    var byModel = {};
    timeline.forEach(function (bucket) {
      if (bucket.p95Seconds === null || bucket.p95Seconds === undefined) return;
      if (!byModel[bucket.model]) byModel[bucket.model] = {};
      byModel[bucket.model][bucket.hourStart] = bucket;
    });

    var models = Object.keys(byModel);
    if (!models.length) {
      hideTip(tip);
      var empty = document.createElement("p");
      empty.className = "chart-empty";
      empty.textContent = "Henuz veri yok";
      host.appendChild(empty);
      return;
    }

    // En çok istenen ilk 4 model; gerisi grafiğin okunurluğunu bozar.
    var ranked = models.slice().sort(function (a, b) {
      var ca = timeline.filter(function (x) { return x.model === a; })
        .reduce(function (sum, x) { return sum + x.count; }, 0);
      var cb = timeline.filter(function (x) { return x.model === b; })
        .reduce(function (sum, x) { return sum + x.count; }, 0);
      return cb - ca || a.localeCompare(b);
    });
    var shown = ranked.slice(0, LATENCY_MAX_SERIES);
    var hidden = ranked.length - shown.length;

    // Sabit 24 kova: eksen, veri olmayan saatleri de kapsar.
    var now = Date.now();
    var lastHour = Math.floor(now / HOUR_MS_TOTAL) * HOUR_MS_TOTAL;
    var hours = [];
    for (var i = LATENCY_HOURS - 1; i >= 0; i--) hours.push(lastHour - i * HOUR_MS_TOTAL);

    var maxP95 = 0;
    shown.forEach(function (model) {
      hours.forEach(function (hour) {
        var bucket = byModel[model][hour];
        if (bucket && bucket.p95Seconds > maxP95) maxP95 = bucket.p95Seconds;
      });
    });
    var top = latencyCeil(maxP95);

    var W = Math.max(300, Math.round(host.clientWidth || 800));
    var H = 180;
    var padL = 48;
    var padR = 8;
    var padT = 10;
    var padB = 24;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;

    var svg = svgEl("svg", {
      "class": "chart-svg",
      viewBox: "0 0 " + W + " " + H,
      role: "img",
    });
    svg.setAttribute("aria-label", "Saatlik p95 gecikme grafigi");

    for (var g = 0; g <= 3; g++) {
      var y = padT + (innerH * g) / 3;
      svg.appendChild(svgEl("line", {
        "class": "chart-grid",
        x1: padL, y1: round2(y), x2: W - padR, y2: round2(y),
      }));
      var yLabel = svgEl("text", {
        "class": "chart-y-label",
        x: padL - 8,
        y: round2(y + 3),
        "text-anchor": "end",
      });
      yLabel.textContent = fmtLatency(top * (1 - g / 3));
      svg.appendChild(yLabel);
    }

    var slot = innerW / hours.length;
    var labelEvery = Math.max(1, Math.ceil((hours.length * 40) / innerW));

    shown.forEach(function (model, seriesIndex) {
      var cls = "s" + seriesIndex;
      var points = [];
      var used = [];
      hours.forEach(function (hour, hourIndex) {
        var bucket = byModel[model][hour];
        if (!bucket || bucket.p95Seconds === null || bucket.p95Seconds === undefined) return;
        var x = padL + slot * hourIndex + slot / 2;
        var y = padT + innerH - Math.min(1, bucket.p95Seconds / top) * innerH;
        points.push(round2(x) + "," + round2(y));
        used.push(bucket);
      });
      if (!points.length) return;

      if (points.length > 1) {
        svg.appendChild(svgEl("polyline", {
          "class": "chart-line " + cls,
          points: points.join(" "),
        }));
      }

      // Kova boşsa çizgi kopuk kalmasın diye uçlara görünmez ama hover'lı
      // bir hedef koyulur.
      points.forEach(function (point, index) {
        var parts = point.split(",");
        var dot = svgEl("circle", {
          "class": "chart-line-dot " + cls,
          cx: parts[0],
          cy: parts[1],
          r: points.length > 12 ? 2 : 3,
        });
        var bucket = used[index];
        var text = hourLabel(bucket.hourStart) + " · p95 " + fmtLatency(bucket.p95Seconds) +
          " · p50 " + fmtLatency(bucket.p50Seconds) +
          " · " + bucket.count + " istek / " + bucket.errors + " hata";
        dot.appendChild(svgEl("title", {}));
        dot.lastChild.textContent = text;
        dot.addEventListener("mousemove", function (event) { showTip(tip, event, text); });
        dot.addEventListener("mouseleave", function () { hideTip(tip); });
        svg.appendChild(dot);
      });

      var item = document.createElement("span");
      item.className = "legend-item";
      var swatch = document.createElement("span");
      swatch.className = "swatch " + cls;
      var text = document.createElement("span");
      text.textContent = model;
      text.title = model;
      item.appendChild(swatch);
      item.appendChild(text);
      legend.appendChild(item);
    });

    if (hidden > 0) {
      var note = document.createElement("span");
      note.className = "legend-item";
      note.textContent = "+" + hidden + " model gosterilmedi";
      legend.appendChild(note);
    }

    hours.forEach(function (hour, index) {
      if (index % labelEvery !== 0) return;
      var xLabel = svgEl("text", {
        "class": "chart-x-label",
        x: round2(padL + slot * index + slot / 2),
        y: H - 8,
        "text-anchor": "middle",
      });
      xLabel.textContent = hourLabel(hour);
      svg.appendChild(xLabel);
    });

    host.appendChild(svg);
  }

  function renderMetricsRecent(payload) {
    lastRecent = payload;
    renderRecentRows();
    renderLatencyChart(payload);
    // Ajan satırları model bazlı 24 saatlik istatistik okur; yeni veri
    // geldiği için yeniden çizilmeleri gerekiyor.
    if (currentAgents) renderAgents(currentAgents);
  }

  function renderByModel(usage) {
    var host = qs("byModelBody");
    host.textContent = "";
    var models = usage.byModel || [];
    if (!models.length) {
      var empty = document.createElement("p");
      empty.className = "bar-empty";
      empty.textContent = "Henuz kayit yok.";
      host.appendChild(empty);
      return;
    }
    var maxCost = 0;
    models.forEach(function (m) { if (m.cost > maxCost) maxCost = m.cost; });
    models.forEach(function (m) {
      var row = barRow(m.model, fmtMoney(m.cost), fmtNum(m.requests) + " istek");
      // Tek seri, tek ölçü: çubuk doğrudan en yüksek maliyete oranlı.
      fillBar(row.track, maxCost > 0 ? m.cost / maxCost : 0);
      host.appendChild(row);
    });
  }

  function renderResults(payload) {
    lastMetrics = payload;
    var host = qs("resultsList");
    var legend = qs("resultsLegend");
    host.textContent = "";
    legend.textContent = "";

    function swatch(cls, label) {
      var item = document.createElement("span");
      item.className = "legend-item";
      var box = document.createElement("span");
      box.className = "swatch " + cls;
      var text = document.createElement("span");
      text.textContent = label;
      item.appendChild(box);
      item.appendChild(text);
      legend.appendChild(item);
    }

    if (!payload || !Array.isArray(payload.models)) {
      renderResultsEmpty();
      renderStatTiles();
      return;
    }

    swatch("ok", "basarili");
    swatch("err", "hata");

    var rows = payload.models.filter(function (m) { return m.total > 0; });
    if (!rows.length) {
      renderResultsEmpty();
      renderStatTiles();
      return;
    }

    var tip = qs("resultsTip");
    rows.forEach(function (entry) {
      var requests = entry.requests || {};
      var ok = requests.ok || 0;
      var total = entry.total || 0;
      var avg = fmtSeconds(entry.avgDurationSeconds);
      var p95 = fmtSeconds(entry.p95Seconds);
      var timing = avg === null && p95 === null ? "-" : (avg || "-") + " · p95 " + (p95 || "-");

      var row = barRow(entry.model, ok + "/" + total, timing);
      var okRatio = total > 0 ? ok / total : 0;
      var errRatio = total > 0 ? (total - ok) / total : 0;
      var okSeg = document.createElement("div");
      okSeg.className = "bar-seg ok";
      okSeg.style.width = okRatio * 100 + "%";
      var errSeg = document.createElement("div");
      errSeg.className = "bar-seg err";
      errSeg.style.width = errRatio * 100 + "%";
      row.track.appendChild(okSeg);
      row.track.appendChild(errSeg);

      // Hata türleri ayrı ayrı: toplam hata tooltip'te tek kalem olmasın.
      function bindTip(node, text) {
        node.addEventListener("mousemove", function (event) { showTip(tip, event, text); });
        node.addEventListener("mouseleave", function () { hideTip(tip); });
      }
      bindTip(okSeg, entry.model + " · basarili: " + ok + "/" + total);
      if (total - ok > 0) {
        var parts = [];
        if (requests.upstream_error) parts.push("upstream: " + requests.upstream_error);
        if (requests.network_error) parts.push("ag: " + requests.network_error);
        if (requests.no_key) parts.push("anahtar yok: " + requests.no_key);
        if (requests.stream_error) parts.push("akis: " + requests.stream_error);
        if (!parts.length) parts.push("diger: " + (total - ok));
        bindTip(errSeg, entry.model + " · hata: " + parts.join(", "));
      }
      host.appendChild(row);
    });

    renderStatTiles();
  }

  function renderResultsEmpty() {
    var host = qs("resultsList");
    host.textContent = "";
    var empty = document.createElement("p");
    empty.className = "bar-empty";
    empty.textContent = "Henuz veri yok";
    host.appendChild(empty);
  }

  function renderUsage(usage) {
    lastUsage = usage;
    renderDailyChart(usage);

    var totals = qs("usageTotals");
    totals.textContent = "";
    function stat(label, value) {
      var span = document.createElement("span");
      span.appendChild(document.createTextNode(label + ": "));
      var b = document.createElement("b");
      b.textContent = value;
      span.appendChild(b);
      return span;
    }
    totals.appendChild(stat("Toplam maliyet", fmtMoney(usage.totals.cost)));
    totals.appendChild(stat("Toplam istek", String(usage.totals.requests)));
    totals.appendChild(stat("Girdi token", fmtNum(usage.totals.promptTokens)));
    totals.appendChild(stat("Cikti token", fmtNum(usage.totals.completionTokens)));
    if (usage.totals.cachedTokens) {
      totals.appendChild(stat("Onbellekten", fmtNum(usage.totals.cachedTokens)));
    }

    renderByModel(usage);
    renderRecentRows();
    renderProjection();
    renderStatTiles();
  }

  // Son istekler tablosu metrics-recent.recent'ten beslenir; maliyet için
  // usage.recent ile ts+model üzerinden eşleşme yapılır.
  var OUTCOME_LABELS = {
    ok: "ok",
    upstream_error: "upstream",
    network_error: "ag",
    no_key: "anahtar yok",
    stream_error: "akis",
    budget_blocked: "butce",
  };

  function renderRecentRows() {
    var tbody = qs("recentBody");
    if (!tbody) return;
    var recent = (lastRecent && lastRecent.recent) || [];
    var filter = qs("recentModelFilter").value;
    var onlyErrors = qs("onlyErrorsToggle").checked;

    // Maliyet, aynı isteğin usage kaydıyla eşleşir; eşleşmezse "-".
    var costByKey = {};
    var usageRecent = (lastUsage && lastUsage.recent) || [];
    usageRecent.forEach(function (r) {
      costByKey[r.ts + "|" + r.model] = r.cost;
    });

    var rows = recent.filter(function (r) {
      if (filter && r.model !== filter) return false;
      if (onlyErrors && r.outcome === "ok") return false;
      return true;
    }).map(function (r) {
      var isError = r.outcome !== "ok";
      var tr = document.createElement("tr");
      if (isError) tr.className = "row-error";

      tr.appendChild(td(fmtDate(r.ts), "mono"));

      var modelCell = td(r.model, "mono");
      modelCell.title = r.model;
      tr.appendChild(modelCell);

      var outcomeCell = td(OUTCOME_LABELS[r.outcome] || r.outcome, "outcome");
      // Hata metni hücreye sığmaz; başlığa taşınır.
      if (r.error) outcomeCell.title = r.error;
      tr.appendChild(outcomeCell);

      tr.appendChild(td(fmtSeconds(r.durationSeconds) || "-", "mono"));

      var cost = costByKey[r.ts + "|" + r.model];
      tr.appendChild(td(cost === undefined ? "-" : fmtMoney(cost), "mono"));

      return tr;
    });

    setRows("recentBody", rows, 5, onlyErrors ? "Hatali istek yok." : "Henuz istek yok.");
  }

  function populateRecentModelFilter(models) {
    var select = qs("recentModelFilter");
    var previous = select.value;
    select.textContent = "";
    var allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "Tum modeller";
    select.appendChild(allOption);
    models.forEach(function (m) {
      var option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.label ? m.label + " (" + m.id + ")" : m.id;
      select.appendChild(option);
    });
    if (previous && models.some(function (m) { return m.id === previous; })) {
      select.value = previous;
    }
  }

  var editingModelId = null;

  function showModelForm() {
    qs("modelFormCard").classList.remove("hidden");
  }

  // Kapatma yalnızca gizler: "Ekli modeller" kartına geri sıçramaz.
  function hideModelForm() {
    qs("modelFormCard").classList.add("hidden");
  }

  function switchToAddMode() {
    editingModelId = null;
    qs("modelFormTitle").textContent = "Model ekle";
    qs("modelFormSubmit").textContent = "Ekle";
    // Vazgec artık yalnızca "düzenle"de değil, kartı kapatmak için de görünür.
    qs("modelFormCancel").classList.remove("hidden");
    qs("modelForm").reset();
    qs("fModelId").disabled = false;
  }

  function startEditModel(model) {
    editingModelId = model.id;
    qs("modelFormTitle").textContent = "Modeli duzenle: " + model.id;
    qs("modelFormSubmit").textContent = "Kaydet";
    qs("modelFormCancel").classList.remove("hidden");
    qs("fModelId").value = model.id;
    qs("fModelId").disabled = true;
    qs("fLabel").value = model.label || "";
    qs("fDescription").value = model.description || "";
    qs("fContext").value = model.contextTokens || "";
    qs("fMaxTokens").value = model.maxOutputTokens || "";
    qs("fBehavesAs").value = model.behavesAs || "";
    qs("fReasoning").value = model.reasoning || "";
    qs("fSort").value = model.providerSort || "";
    qs("fStream").value = model.stream === false ? "false" : model.stream === true ? "true" : "";
    qs("fQuantizations").value = (model.quantizations || []).join(",");
    qs("fMaxPriceIn").value = (model.maxPrice && model.maxPrice.prompt) || "";
    qs("fMaxPriceOut").value = (model.maxPrice && model.maxPrice.completion) || "";
    showModelForm();
    qs("modelFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function collectModelInput() {
    var quantValue = qs("fQuantizations").value.trim();
    var priceIn = qs("fMaxPriceIn").value;
    var priceOut = qs("fMaxPriceOut").value;
    var maxPrice = null;
    if (priceIn || priceOut) {
      maxPrice = {};
      if (priceIn) maxPrice.prompt = Number(priceIn);
      if (priceOut) maxPrice.completion = Number(priceOut);
    }
    var streamValue = qs("fStream").value;

    return {
      label: qs("fLabel").value.trim() || null,
      description: qs("fDescription").value.trim() || null,
      contextTokens: qs("fContext").value ? Number(qs("fContext").value) : null,
      maxOutputTokens: qs("fMaxTokens").value ? Number(qs("fMaxTokens").value) : null,
      behavesAs: qs("fBehavesAs").value.trim() || null,
      reasoning: qs("fReasoning").value || null,
      providerSort: qs("fSort").value || null,
      stream: streamValue === "true" ? true : streamValue === "false" ? false : null,
      quantizations: quantValue
        ? quantValue.split(",").map(function (q) { return q.trim(); }).filter(Boolean)
        : null,
      maxPrice: maxPrice,
    };
  }

  function deleteModel(id) {
    if (!window.confirm("Silinsin mi: " + id + "?")) return;
    post("/dashboard/api/models/remove", { id: id })
      .then(function () {
        toast("Model silindi: " + id, "success");
        if (editingModelId === id) switchToAddMode();
        return refreshModelsAndAgents();
      })
      .catch(function (err) { toast(err.message, "error"); });
  }

  var currentModels = [];

  function renderModels(models) {
    currentModels = models;
    // The "Ekli model" tile reads currentModels; the models fetch can land
    // after usage/metrics, so re-render the tiles here too.
    renderStatTiles();
    var rows = models.map(function (m) {
      var tr = document.createElement("tr");

      var idCell = document.createElement("td");
      var idLine = document.createElement("div");
      idLine.className = "mono";
      idLine.textContent = m.id;
      idCell.appendChild(idLine);
      if (m.label && m.label !== m.id) {
        var labelLine = document.createElement("div");
        labelLine.style.color = "var(--text-dim)";
        labelLine.style.fontSize = "12px";
        labelLine.textContent = m.label;
        idCell.appendChild(labelLine);
      }
      tr.appendChild(idCell);

      tr.appendChild(td(m.reasoning || "-"));
      tr.appendChild(td(m.providerSort || "-"));

      var streamCell = document.createElement("td");
      var badge = document.createElement("span");
      badge.className = "badge " + (m.stream === false ? "off" : "on");
      badge.textContent = m.stream === false ? "kapali" : "acik";
      streamCell.appendChild(badge);
      if (m.autoRecovered && m.stream === false) {
        var autoBadge = document.createElement("span");
        autoBadge.className = "badge auto-recovered";
        autoBadge.textContent = "otomatik";
        autoBadge.title = "Akis hatasi sonrasi otomatik kapatildi.";
        streamCell.appendChild(autoBadge);
      }
      tr.appendChild(streamCell);

      var actionsCell = document.createElement("td");
      var actionsWrap = document.createElement("div");
      actionsWrap.className = "row-actions";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-secondary btn-small";
      editBtn.textContent = "Duzenle";
      editBtn.addEventListener("click", function () { startEditModel(m); });

      var testBtn = document.createElement("button");
      testBtn.type = "button";
      testBtn.className = "btn btn-secondary btn-small";
      testBtn.textContent = "Test et";
      testBtn.addEventListener("click", function () { runModelTest(m.id, testBtn, resultBox); });

      var providersBtn = document.createElement("button");
      providersBtn.type = "button";
      providersBtn.className = "btn btn-secondary btn-small";
      providersBtn.textContent = "Saglayicilar";
      providersBtn.addEventListener("click", function () { toggleProviders(m.id, tr, providersBtn); });

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger btn-small";
      delBtn.textContent = "Sil";
      delBtn.addEventListener("click", function () { deleteModel(m.id); });

      actionsWrap.appendChild(editBtn);
      actionsWrap.appendChild(testBtn);
      actionsWrap.appendChild(providersBtn);
      actionsWrap.appendChild(delBtn);
      actionsCell.appendChild(actionsWrap);
      var resultBox = document.createElement("div");
      resultBox.className = "test-result hidden";
      actionsCell.appendChild(resultBox);
      tr.appendChild(actionsCell);

      return tr;
    });
    setRows("modelsBody", rows, 5, "Hic model ekli degil.");
    populateAgentModelSelect(models);
    populateRecentModelFilter(models);
  }

  function runModelTest(id, button, resultBox) {
    button.disabled = true;
    resultBox.classList.remove("hidden", "error");
    resultBox.textContent = "test ediliyor...";
    post("/dashboard/api/models/test", { id: id })
      .then(function (result) {
        if (!result.ok) {
          resultBox.classList.add("error");
          resultBox.textContent = "Basarisiz: " + result.error;
          return;
        }
        resultBox.textContent =
          "'" + result.text + "'  |  " + result.latencyMs + "ms  |  " +
          fmtNum(result.promptTokens) + "/" + fmtNum(result.completionTokens) + " token  |  " +
          fmtMoney(result.cost);
        refreshUsage();
      })
      .catch(function (err) {
        resultBox.classList.add("error");
        resultBox.textContent = "Basarisiz: " + err.message;
      })
      .then(function () { button.disabled = false; });
  }

  function toggleProviders(id, modelRow, button) {
    var existing = modelRow.nextSibling;
    if (existing && existing.classList && existing.classList.contains("providers-row")) {
      existing.parentNode.removeChild(existing);
      button.textContent = "Saglayicilar";
      return;
    }

    button.disabled = true;
    get("/dashboard/api/providers?id=" + encodeURIComponent(id))
      .then(function (data) {
        var providers = data.providers || [];
        var row = document.createElement("tr");
        row.className = "providers-row";
        var cell = document.createElement("td");
        cell.colSpan = 5;
        if (!providers.length) {
          cell.textContent = "Saglayici bilgisi yok.";
        } else {
          var table = document.createElement("table");
          table.className = "providers-table";
          var thead = document.createElement("thead");
          var headRow = document.createElement("tr");
          ["Saglayici", "Girdi $/M", "Cikti $/M", "Baglam"].forEach(function (label) {
            var th = document.createElement("th");
            th.textContent = label;
            headRow.appendChild(th);
          });
          thead.appendChild(headRow);
          table.appendChild(thead);
          var tbody = document.createElement("tbody");
          providers.forEach(function (p) {
            var pr = document.createElement("tr");
            pr.appendChild(td(p.providerName || "-"));
            pr.appendChild(td(fmtMoney(p.promptPrice), "mono"));
            pr.appendChild(td(fmtMoney(p.completionPrice), "mono"));
            pr.appendChild(td(p.contextLength ? fmtNum(p.contextLength) : "-", "mono"));
            tbody.appendChild(pr);
          });
          table.appendChild(tbody);
          cell.appendChild(table);
        }
        row.appendChild(cell);
        modelRow.parentNode.insertBefore(row, modelRow.nextSibling);
        button.textContent = "Gizle";
      })
      .catch(function (err) { toast(err.message, "error"); })
      .then(function () { button.disabled = false; });
  }

  function populateAgentModelSelect(models) {
    var select = qs("aModel");
    var previous = select.value;
    select.textContent = "";
    models.forEach(function (m) {
      var option = document.createElement("option");
      option.value = m.id;
      option.textContent = m.label ? m.label + " (" + m.id + ")" : m.id;
      select.appendChild(option);
    });
    if (previous) select.value = previous;
  }

  // Bir modelin son 24 saatteki istek/hata sayısı ve maliyeti. Ajan satırı
  // "ajanın modeli" üzerinden okur, yani değerler ajana özel değil modele
  // özeldir — sütun başlığı da bunu söyler.
  function modelStats24h() {
    var stats = {};
    var cutoff = Date.now() - 24 * HOUR_MS_TOTAL;
    var recent = (lastRecent && lastRecent.recent) || [];
    recent.forEach(function (r) {
      if (r.ts < cutoff) return;
      var entry = stats[r.model] || (stats[r.model] = { count: 0, errors: 0, cost: 0 });
      entry.count += 1;
      if (r.outcome !== "ok") entry.errors += 1;
    });
    var usageRecent = (lastUsage && lastUsage.recent) || [];
    usageRecent.forEach(function (r) {
      if (r.ts < cutoff) return;
      if (!stats[r.model]) return;
      stats[r.model].cost += r.cost || 0;
    });
    return stats;
  }

  function renderAgents(payload) {
    qs("agentsHint").textContent =
      "Proje: " + payload.projectDir + "   |   Kullanici: " + payload.userDir;
    currentAgents = payload;

    var stats = modelStats24h();
    var rows = payload.agents.map(function (agent) {
      var tr = document.createElement("tr");
      tr.appendChild(td(agent.name));
      tr.appendChild(td(agent.scope === "user" ? "kullanici" : "proje"));

      var modelCell = document.createElement("td");
      var modelText = document.createElement("span");
      modelText.className = "mono";
      modelText.textContent = agent.model || "(belirtilmemis)";
      modelCell.appendChild(modelText);

      var badge = document.createElement("span");
      badge.style.marginLeft = "8px";
      if (agent.configured) {
        badge.className = "badge on";
        badge.textContent = "yapilandirilmis";
      } else if (agent.claudeModel) {
        badge.className = "badge";
        badge.textContent = "claude";
      } else {
        badge.className = "badge off";
        badge.textContent = "bilinmiyor";
      }
      modelCell.appendChild(badge);
      tr.appendChild(modelCell);

      tr.appendChild(td((agent.tools || []).join(", ") || "-"));

      var stat = agent.model ? stats[agent.model] : null;
      tr.appendChild(td(stat ? fmtNum(stat.count) : "-", "mono"));
      tr.appendChild(td(stat ? fmtMoney(stat.cost) : "-", "mono"));

      var actionsCell = document.createElement("td");
      var actionsWrap = document.createElement("div");
      actionsWrap.className = "row-actions";

      var reassignSelect = document.createElement("select");
      currentModels.forEach(function (m) {
        var option = document.createElement("option");
        option.value = m.id;
        option.textContent = m.label ? m.label + " (" + m.id + ")" : m.id;
        reassignSelect.appendChild(option);
      });
      if (agent.model && currentModels.some(function (m) { return m.id === agent.model; })) {
        reassignSelect.value = agent.model;
      }

      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-secondary btn-small";
      saveBtn.textContent = "Modeli degistir";
      saveBtn.addEventListener("click", function () {
        var modelId = reassignSelect.value;
        if (!modelId) return;
        saveBtn.disabled = true;
        post("/dashboard/api/agents/create", { name: agent.name, modelId: modelId, scope: agent.scope })
          .then(function () {
            toast("Ajan guncellendi: " + agent.name, "success");
            return refreshAgents();
          })
          .catch(function (err) { toast(err.message, "error"); })
          .then(function () { saveBtn.disabled = false; });
      });

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger btn-small";
      delBtn.textContent = "Sil";
      delBtn.addEventListener("click", function () {
        if (!window.confirm("Silinsin mi: " + agent.name + "?")) return;
        post("/dashboard/api/agents/delete", { file: agent.file })
          .then(function () {
            toast("Ajan silindi: " + agent.name, "success");
            return refreshAgents();
          })
          .catch(function (err) { toast(err.message, "error"); });
      });

      actionsWrap.appendChild(reassignSelect);
      actionsWrap.appendChild(saveBtn);
      actionsWrap.appendChild(delBtn);
      actionsCell.appendChild(actionsWrap);
      tr.appendChild(actionsCell);

      // Satırın sonu tek bir nokta: o modelde son 24 saatte ne olduğu.
      var statusCell = document.createElement("td");
      statusCell.className = "agent-status-cell";
      var status = document.createElement("span");
      if (!stat) {
        status.className = "agent-status none";
        status.title = agent.model
          ? "Bu modelde son 24 saatte istek yok."
          : "Model belirtilmedigi icin 24 saatlik istatistik yok.";
      } else if (stat.errors / stat.count > 0.25) {
        status.className = "agent-status bad";
        status.title = "Son 24 saatte " + stat.count + " istekten " + stat.errors +
          " tanesi hatali (%" + Math.round((stat.errors / stat.count) * 100) + ").";
      } else {
        status.className = "agent-status ok";
        status.title = "Son 24 saatte " + stat.count + " istek, " + stat.errors + " hata.";
      }
      statusCell.appendChild(status);
      tr.appendChild(statusCell);

      return tr;
    });
    setRows("agentsBody", rows, 7, "Hic alt ajan yok.");
  }

  // Bütçe ve uyarı aynı şeritte okunur: ikisi de "şu an dikkat edilecek
  // bir şey var mı" sorusuna yanıt veriyor.
  function renderBanner(budget, alerts) {
    var banner = qs("budgetBanner");
    banner.textContent = "";
    banner.className = "banner";

    var level = budget ? budget.level : "ok";
    var limit = budget && budget.dailyUsd !== undefined ? budget.dailyUsd : null;
    if (level === "warn" || level === "over") {
      var text = (level === "warn" ? "Butce %80 asildi: bugun " : "Butce asildi: bugun ") +
        fmtMoney(budget.todayUsd);
      if (limit !== null) text += " / limit " + fmtMoney(limit);
      // Engel yalnızca sunucu tarafında gerçekten engelliyorsa anlamlı.
      if (level === "over" && budget.exceeded) text += " - ucretli modeller engelleniyor";
      banner.classList.add(level === "warn" ? "banner-warn" : "banner-danger");
      banner.appendChild(bannerLine(text));
    }

    // Uyarı son bir saatte tetiklendiyse aynı şeridin altında ikinci satır.
    var firedAt = alerts ? alerts.lastFiredAt : null;
    if (firedAt !== null && firedAt !== undefined && Date.now() - firedAt <= HOUR_MS_TOTAL) {
      if (level === "ok") banner.classList.add("banner-warn");
      var note = bannerLine("Uyari tetiklendi: " + (alerts.lastReason || "bilinmeyen neden"));
      note.className = "banner-line banner-note";
      banner.appendChild(note);
    }

    banner.classList.toggle("hidden", banner.textContent === "");
  }

  function bannerLine(text) {
    var line = document.createElement("span");
    line.className = "banner-line";
    line.textContent = text;
    return line;
  }

  function refreshStatusAndCredit() {
    get("/dashboard/api/status").then(renderStatus).catch(function () {});
    get("/dashboard/api/credit")
      .then(renderCredit)
      .catch(function (err) {
        renderCredit({ ok: false, reason: "unreachable", message: err.message });
      });
  }

  // İki uç nokta bağımsız; biri düşerse banner yine de çizilir.
  function refreshBanner() {
    var budget = null;
    var alerts = null;
    get("/dashboard/api/budget").then(function (data) {
      budget = data;
      renderBanner(budget, alerts);
    }).catch(function () {});
    get("/dashboard/api/alerts").then(function (data) {
      alerts = data;
      renderBanner(budget, alerts);
    }).catch(function () {});
  }

  function refreshMetricsRecent() {
    get("/dashboard/api/metrics-recent")
      .then(renderMetricsRecent)
      .catch(function () {
        renderMetricsRecent(null);
      });
  }

  function refreshUsage() {
    var model = qs("recentModelFilter").value;
    var query = "/dashboard/api/usage?days=14&recent=20";
    if (model) query += "&model=" + encodeURIComponent(model);
    get(query).then(renderUsage).catch(function () {});
  }

  function refreshHealth() {
    get("/dashboard/api/health").then(renderHealth).catch(function () {});
  }

  // Bu uç nokta ayrı bir sunucu parçası; yoksa 404 döner. Sayfayı düşürmek
  // yerine kartı boş durumda bırakıp istatistik satırını yine de tazele.
  function refreshMetricsSummary() {
    get("/dashboard/api/metrics-summary")
      .then(renderResults)
      .catch(function () { renderResults(null); });
  }

  function refreshLogs() {
    get("/dashboard/api/logs?lines=200")
      .then(function (data) {
        var box = qs("logBox");
        var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
        box.textContent = (data.lines || []).join(String.fromCharCode(10)) || "(log bos)";
        if (nearBottom) box.scrollTop = box.scrollHeight;
      })
      .catch(function () {});
  }

  function refreshAgents() {
    return get("/dashboard/api/agents").then(renderAgents);
  }

  function refreshModelsAndAgents() {
    return Promise.all([
      get("/dashboard/api/models").then(function (data) { renderModels(data.models || []); }),
      refreshAgents(),
    ]);
  }

  function refreshAll() {
    refreshStatusAndCredit();
    refreshUsage();
    refreshModelsAndAgents();
    refreshHealth();
    refreshMetricsSummary();
    refreshMetricsRecent();
    refreshBanner();
  }

  function wireModelForm() {
    qs("modelForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var input = collectModelInput();
      var submitBtn = qs("modelFormSubmit");
      submitBtn.disabled = true;

      var request;
      if (editingModelId) {
        request = post("/dashboard/api/models/update", { id: editingModelId, patch: input });
      } else {
        var id = qs("fModelId").value.trim();
        if (!id) {
          submitBtn.disabled = false;
          return;
        }
        input.id = id;
        request = post("/dashboard/api/models/add", input);
      }

      var wasEditing = Boolean(editingModelId);
      request
        .then(function (result) {
          if (result.catalogStatus === "not_found") {
            toast("Model eklendi; katalogda bulunamadi, elle doldurdugun alanlar kullanildi.", "success");
          } else if (result.catalogStatus === "catalog_error") {
            toast("Model eklendi; katalog alinamadi (" + result.catalogError + ").", "success");
          } else {
            toast(wasEditing ? "Model guncellendi." : "Model eklendi.", "success");
          }
          switchToAddMode();
          hideModelForm();
          return refreshModelsAndAgents();
        })
        .catch(function (err) { toast(err.message, "error"); })
        .then(function () { submitBtn.disabled = false; });
    });

    qs("newModelBtn").addEventListener("click", function () {
      switchToAddMode();
      showModelForm();
      qs("modelFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
      qs("fModelId").focus();
    });

    qs("modelFormCancel").addEventListener("click", function () {
      switchToAddMode();
      hideModelForm();
    });
  }

  function wireEscapeToCloseForms() {
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!qs("modelFormCard").classList.contains("hidden")) {
        switchToAddMode();
        hideModelForm();
        return;
      }
      if (!qs("agentFormPanel").classList.contains("hidden")) hideAgentForm();
    });
  }

  function wireCatalogSearch() {
    var searchTimer = null;

    function runSearch(query) {
      get("/dashboard/api/catalog?q=" + encodeURIComponent(query))
        .then(function (data) { renderCatalogResults(data.results || []); })
        .catch(function () { qs("catalogResults").classList.remove("open"); });
    }

    function renderCatalogResults(results) {
      var box = qs("catalogResults");
      box.textContent = "";
      if (!results.length) {
        box.classList.remove("open");
        return;
      }
      results.slice(0, 15).forEach(function (item) {
        var row = document.createElement("div");
        row.className = "catalog-result";
        var idLine = document.createElement("div");
        idLine.className = "cr-id";
        idLine.textContent = item.id;
        var nameLine = document.createElement("div");
        nameLine.className = "cr-name";
        nameLine.textContent = item.name || "";
        row.appendChild(idLine);
        row.appendChild(nameLine);
        row.addEventListener("click", function () {
          switchToAddMode();
          qs("fModelId").value = item.id;
          if (item.name) qs("fLabel").value = item.name;
          box.classList.remove("open");
          qs("catalogSearch").value = "";
          qs("fModelId").focus();
        });
        box.appendChild(row);
      });
      box.classList.add("open");
    }

    qs("catalogSearch").addEventListener("input", function () {
      var value = qs("catalogSearch").value;
      if (searchTimer) window.clearTimeout(searchTimer);
      if (!value.trim()) {
        qs("catalogResults").classList.remove("open");
        return;
      }
      searchTimer = window.setTimeout(function () { runSearch(value); }, 250);
    });

    document.addEventListener("click", function (event) {
      var box = qs("catalogResults");
      if (!box.contains(event.target) && event.target !== qs("catalogSearch")) {
        box.classList.remove("open");
      }
    });
  }

  function wireSyncButtons() {
    qs("syncBtn").addEventListener("click", function () {
      post("/dashboard/api/sync", {})
        .then(function (result) {
          toast(
            result.removed ? "Model listesi bos, modelPicker kaldirildi." : "Menuye yazildi: " + result.path,
            "success",
          );
        })
        .catch(function (err) { toast(err.message, "error"); });
    });

    qs("revertBtn").addEventListener("click", function () {
      if (!window.confirm("Son sync oncesi haline dondurulsun mu?")) return;
      post("/dashboard/api/sync", { revert: true })
        .then(function (result) {
          toast(result.restored ? "Geri alindi: " + result.path : "Geri alinacak bir sey yoktu.", "success");
        })
        .catch(function (err) { toast(err.message, "error"); });
    });
  }

  function wireProxyControls() {
    qs("stopProxyBtn").addEventListener("click", function () {
      if (!window.confirm("Proxy durdurulsun mu? Claude Code istekleri calismayi keser.")) return;
      post("/dashboard/api/proxy/stop", {})
        .then(function () { toast("Proxy durduruluyor.", "success"); })
        .catch(function (err) { toast(err.message, "error"); });
    });

    qs("restartProxyBtn").addEventListener("click", function () {
      if (!window.confirm("Proxy yeniden baslatilsin mi?")) return;
      post("/dashboard/api/proxy/restart", {})
        .then(function () {
          toast("Yeniden baslatiliyor, sayfa birkac saniye sonra yenilenecek.", "success");
          window.setTimeout(function () { window.location.reload(); }, 2500);
        })
        .catch(function (err) { toast(err.message, "error"); });
    });
  }

  function wireLogViewer() {
    var box = qs("logBox");
    var button = qs("logToggleBtn");
    var open = false;
    try {
      open = window.localStorage.getItem("cor.logOpen") === "1";
    } catch (err) {
      open = false; // depolama erişimi kapalıysa varsayılan gizli
    }

    function render() {
      box.classList.toggle("hidden", !open);
      button.textContent = open ? "Gizle" : "Goster";
      button.setAttribute("aria-expanded", open ? "true" : "false");
    }

    button.addEventListener("click", function () {
      open = !open;
      try {
        window.localStorage.setItem("cor.logOpen", open ? "1" : "0");
      } catch (err) {
        /* gizlilik modu: durum yalnızca bu oturumda tutulur */
      }
      render();
      if (open) refreshLogs();
    });

    render();
    if (open) refreshLogs();
    window.setInterval(function () {
      if (!document.hidden && open && qs("logAutoRefresh").checked) refreshLogs();
    }, 5000);
  }

  function wireRecentFilter() {
    qs("recentModelFilter").addEventListener("change", function () {
      refreshUsage();
      renderRecentRows();
    });
    // Yalnızca istemci tarafı bir süzgeç: yeniden istek atmaya gerek yok.
    qs("onlyErrorsToggle").addEventListener("change", renderRecentRows);
  }

  function hideAgentForm() {
    qs("agentFormPanel").classList.add("hidden");
  }

  function wireAgentForm() {
    qs("newAgentBtn").addEventListener("click", function () {
      qs("agentFormPanel").classList.remove("hidden");
      qs("aName").focus();
    });

    qs("agentFormCancel").addEventListener("click", function () { hideAgentForm(); });

    qs("agentForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = qs("aName").value.trim();
      var modelId = qs("aModel").value;
      var scope = qs("aScope").value;
      if (!name || !modelId) return;
      post("/dashboard/api/agents/create", { name: name, modelId: modelId, scope: scope })
        .then(function (result) {
          toast((result.overwritten ? "Guncellendi: " : "Olusturuldu: ") + result.path, "success");
          hideAgentForm();
          return refreshAgents();
        })
        .catch(function (err) { toast(err.message, "error"); });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    switchToAddMode();
    wireModelForm();
    wireCatalogSearch();
    wireSyncButtons();
    wireAgentForm();
    wireProxyControls();
    wireLogViewer();
    wireRecentFilter();
    wireEscapeToCloseForms();
    refreshAll();
    window.setInterval(function () {
      if (!document.hidden) refreshAll();
    }, 25000);
  });
})();
`;
