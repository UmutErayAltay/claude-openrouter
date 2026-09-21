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
