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

  function renderHealth(payload) {
    var list = qs("healthList");
    list.textContent = "";
    var checks = payload.checks || [];
    if (!checks.length) {
      var empty = document.createElement("li");
      empty.className = "empty-row";
      empty.textContent = "kontrol yok";
      list.appendChild(empty);
      return;
    }
    checks.forEach(function (check) {
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
      var bar = document.createElement("div");
      bar.className = "credit-bar";
      var fill = document.createElement("div");
      fill.className = "credit-bar-fill";
      var pct = Math.max(0, Math.min(100, (credit.usage / credit.limit) * 100));
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

  function renderUsage(usage) {
    lastUsage = usage;
    var chart = qs("dailyChart");
    chart.textContent = "";
    var maxCost = 0;
    usage.daily.forEach(function (d) { if (d.cost > maxCost) maxCost = d.cost; });
    usage.daily.forEach(function (d) {
      var bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.height = (maxCost > 0 ? Math.max(3, (d.cost / maxCost) * 100) : 3) + "%";
      var tip = document.createElement("div");
      tip.className = "chart-tip";
      tip.textContent = d.date + ": " + fmtMoney(d.cost) + " (" + d.requests + " istek)";
      bar.appendChild(tip);
      chart.appendChild(bar);
    });

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

    var byModelRows = usage.byModel.map(function (m) {
      var tr = document.createElement("tr");
      tr.appendChild(td(m.model, "mono"));
      tr.appendChild(td(String(m.requests)));
      tr.appendChild(td(fmtMoney(m.cost), "mono"));
      return tr;
    });
    setRows("byModelBody", byModelRows, 3, "Henuz kayit yok.");

    var recentRows = usage.recent.map(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(td(fmtDate(r.ts)));
      tr.appendChild(td(r.model, "mono"));
      tr.appendChild(td(fmtNum(r.promptTokens) + " / " + fmtNum(r.completionTokens), "mono"));
      tr.appendChild(td(fmtMoney(r.cost), "mono"));
      return tr;
    });
    setRows("recentBody", recentRows, 4, "Henuz istek yok.");
    renderProjection();
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

  function switchToAddMode() {
    editingModelId = null;
    qs("modelFormTitle").textContent = "Model ekle";
    qs("modelFormSubmit").textContent = "Ekle";
    qs("modelFormCancel").classList.add("hidden");
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

  function renderAgents(payload) {
    qs("agentsHint").textContent =
      "Proje: " + payload.projectDir + "   |   Kullanici: " + payload.userDir;

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

      return tr;
    });
    setRows("agentsBody", rows, 5, "Hic alt ajan yok.");
  }

  function refreshStatusAndCredit() {
    get("/dashboard/api/status").then(renderStatus).catch(function () {});
    get("/dashboard/api/credit")
      .then(renderCredit)
      .catch(function (err) {
        renderCredit({ ok: false, reason: "unreachable", message: err.message });
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
          return refreshModelsAndAgents();
        })
        .catch(function (err) { toast(err.message, "error"); })
        .then(function () { submitBtn.disabled = false; });
    });

    qs("modelFormCancel").addEventListener("click", function () { switchToAddMode(); });
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
    refreshLogs();
    window.setInterval(function () {
      if (!document.hidden && qs("logAutoRefresh").checked) refreshLogs();
    }, 5000);
  }

  function wireRecentFilter() {
    qs("recentModelFilter").addEventListener("change", function () { refreshUsage(); });
  }

  function wireAgentForm() {
    qs("agentForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = qs("aName").value.trim();
      var modelId = qs("aModel").value;
      var scope = qs("aScope").value;
      if (!name || !modelId) return;
      post("/dashboard/api/agents/create", { name: name, modelId: modelId, scope: scope })
        .then(function (result) {
          toast((result.overwritten ? "Guncellendi: " : "Olusturuldu: ") + result.path, "success");
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
    refreshAll();
    window.setInterval(function () {
      if (!document.hidden) refreshAll();
    }, 25000);
  });
})();
`;
