import { describe, expect, it } from "vitest";
import { buildDashboardHtml } from "../src/server/dashboardPage.js";
import { DASHBOARD_JS } from "../src/server/dashboardScript.js";
import { DASHBOARD_CSS } from "../src/server/dashboardStyles.js";

// Every element id the script references with qs("...") or getElementById.
const REFERENCED_IDS = [
  "statusDot",
  "statusMeta",
  "creditBody",
  "dailyChart",
  "usageTotals",
  "byModelBody",
  "recentBody",
  "modelsBody",
  "modelFormCard",
  "modelFormTitle",
  "catalogSearch",
  "catalogResults",
  "modelForm",
  "fModelId",
  "fLabel",
  "fDescription",
  "fContext",
  "fMaxTokens",
  "fBehavesAs",
  "fReasoning",
  "fSort",
  "fStream",
  "fQuantizations",
  "fMaxPriceIn",
  "fMaxPriceOut",
  "modelFormSubmit",
  "modelFormCancel",
  "agentsHint",
  "agentsBody",
  "agentForm",
  "aName",
  "aModel",
  "aScope",
  "syncBtn",
  "revertBtn",
  "toast",
  "restartProxyBtn",
  "stopProxyBtn",
  "healthCard",
  "healthList",
  "creditProjection",
  "recentModelFilter",
  "syncStatusBadge",
  "exportBtn",
  "logAutoRefresh",
  "logBox",
];

describe("buildDashboardHtml", () => {
  const html = buildDashboardHtml();

  it("is well-formed enough to have exactly one script and one style tag", () => {
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("embeds both the CSS and the JS", () => {
    expect(html).toContain(DASHBOARD_CSS.trim().slice(0, 40));
    expect(html).toContain(DASHBOARD_JS.trim().slice(0, 40));
  });

  it("contains every element id the script looks up", () => {
    for (const id of REFERENCED_IDS) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("never leaked an unresolved template placeholder", () => {
    // The only two real interpolations are the CSS and JS constants; if
    // either failed to resolve, a literal "${" would survive into the page.
    expect(html).not.toContain("${");
    expect(html).not.toContain("[object Object]");
  });

  it("starts with a doctype and has a title", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>claude-openrouter</title>");
  });
});

describe("DASHBOARD_JS", () => {
  it("never contains a backtick or a template interpolation", () => {
    // The embedding chain (dashboardScript.ts -> dashboardPage.ts) uses
    // template literals at every level; either character here would
    // terminate one early and silently corrupt the page.
    expect(DASHBOARD_JS).not.toContain("`");
    expect(DASHBOARD_JS).not.toContain("${");
  });

  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(DASHBOARD_JS)).not.toThrow();
  });
});

// commit b536331, "Redesign the dashboard as an ops console". The redesign is
// invisible to the contract above (same ids, same embedding), so these tests
// pin the pieces that were actually added or moved.
describe("yeniden tasarim", () => {
  const html = buildDashboardHtml();
  const css = DASHBOARD_CSS;
  const js = DASHBOARD_JS;

  // Splits the stylesheet at the end of the :root block (its first "}").
  const rootEnd = css.indexOf("}") + 1;
  const rootBlock = css.slice(0, rootEnd);
  const cssOutsideRoot = css.slice(rootEnd);
  // tbodies the redesign moved into a .table-scroll wrapper.
  const SCROLL_WRAPPED = ["recentBody", "modelsBody", "agentsBody"];

  it("puts the stat tile grid first in main, ahead of the Saglik card", () => {
    const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
    const grid = main.indexOf('id="statGrid"');
    const health = main.indexOf('id="healthCard"');
    expect(grid).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(-1);
    expect(grid).toBeLessThan(health);
  });

  it("ships the Istek sonuclari card, fed by the metrics-summary endpoint", () => {
    expect(html).toContain("Istek sonuclari");
    expect(js).toContain("/dashboard/api/metrics-summary");
  });

  it("has no external stylesheet, script, or font dependency", () => {
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain("cdn");
    expect(html).not.toContain("fonts.googleapis");
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("keeps raw hex colors inside :root only", () => {
    // :root is the one block the palette is allowed to be literal in.
    expect(rootBlock).toContain(":root {");
    expect(cssOutsideRoot).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("keeps the no-backtick, no-interpolation rule the embedding chain needs", () => {
    expect(js).not.toContain("`");
    expect(js).not.toContain("${");
  });

  it("keeps the pre-redesign ids in place", () => {
    for (const id of REFERENCED_IDS) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("wraps each wide table tbody in a .table-scroll box", () => {
    // The wrapper may carry extra classes (e.g. recent-scroll), so match the prefix.
    const opens = [...html.matchAll(/<div class="table-scroll[" ]/g)].map((m) => m.index!);
    expect(opens.length).toBeGreaterThanOrEqual(SCROLL_WRAPPED.length);
    for (const id of SCROLL_WRAPPED) {
      const tbody = html.indexOf(`id="${id}"`);
      expect(tbody).toBeGreaterThan(-1);
      const preceding = opens.filter((at) => at < tbody);
      expect(preceding.length).toBeGreaterThan(0);
    }
  });
});
