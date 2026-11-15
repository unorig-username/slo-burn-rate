import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";

// Collect console errors, page errors, CSP violations, and failed same-origin requests.
function watch(page) {
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.hostname === "localhost" && r.status() >= 400) problems.push(`${r.status()} ${u.pathname}`);
  });
  return problems;
}

const field = (page, name) => page.locator(`[name="${name}"]`);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("page health", () => {
  for (const scheme of ["light", "dark"]) {
    test(`loads cleanly, no overflow, accessible (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const problems = watch(page);
      await page.goto("/", { waitUntil: "networkidle" });
      await expect(page).toHaveTitle(/SLO burn-rate/);
      await expect(page.locator("#analysis tr")).toHaveCount(4);
      await expect(page.locator("#out-prom")).toContainText("slo:sli_error:ratio_rate5m");
      expect(problems).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      const serious = axe.violations.filter((v) => ["serious", "critical"].includes(v.impact));
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
    });
  }

  test("no horizontal scroll at 390px, even with long inputs and errors", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#sli=latency&by=cluster,namespace,service_name&rps=12500");
    await expect(page.locator("#reqMetric")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await field(page, "slo").fill("100");
    await expect(page.locator("#errors")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test("header links to coreyjones.dev and the source", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "by Corey Jones" })).toHaveAttribute("href", "https://coreyjones.dev");
    await expect(page.locator("header").getByRole("link", { name: "Source" })).toHaveAttribute("href", "https://github.com/unorig-username/slo-burn-rate");
  });

  test("security headers are set and scripts are self-only", async ({ request }) => {
    const h = (await request.get("/")).headers();
    expect(h["content-security-policy"]).toContain("default-src 'self'");
    expect(h["content-security-policy"]).toMatch(/script-src 'self';/);
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(readFileSync("public/index.html", "utf8")).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  test("404 page and robots", async ({ request }) => {
    const nf = await request.get("/definitely-not-here");
    expect(nf.status()).toBe(404);
    expect(await nf.text()).toContain("outside the SLO window");
    expect((await request.get("/robots.txt")).status()).toBe(200);
    expect((await request.get("/favicon.svg")).status()).toBe(200);
  });
});

test.describe("interactions", () => {
  test("defaults match the workbook numbers", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-out="budget"]')).toHaveText("0.1%");
    await expect(page.locator('[data-out="window"]')).toHaveText("43m 12s");
    const rows = page.locator("#analysis tr");
    for (const [i, burn] of ["14.4x", "6x", "3x", "1x"].entries()) await expect(rows.nth(i).locator("td").nth(1)).toHaveText(burn);
    await expect(rows.nth(0).locator("td").nth(3)).toHaveText("51.84s");
    await expect(rows.nth(1).locator("td").nth(5)).toHaveText("fires in 3h 36m");
    await expect(page.locator("#chartCaption")).toContainText("budget is gone in 3d");
    await expect(page.locator("#chart circle")).toHaveCount(2);
  });

  test("changing the SLO updates the numbers and the config", async ({ page }) => {
    await page.goto("/");
    await field(page, "slo").fill("99.99");
    await expect(page.locator('[data-out="window"]')).toHaveText("4m 19s");
    await expect(page.locator("#analysis tr").first().locator("td").nth(3)).toHaveText("5.18s");
    await expect(page.locator("#out-prom")).toContainText("> (14.4 * 0.0001)");
    await expect(page.locator("#out-grafana")).toContainText("$A > 0.00144");
    await field(page, "rps").fill("100");
    await expect(page.locator('[data-out="requests"]')).toHaveText("25,920");
  });

  test("invalid input shows errors and hides the results", async ({ page }) => {
    await page.goto("/");
    await field(page, "slo").fill("100");
    await expect(page.locator("#errorList")).toContainText("SLO target must be above 0 and below 100 percent.");
    await expect(page.locator("#out-prom")).toBeHidden();
    await field(page, "slo").fill("99.5");
    await expect(page.locator("#errors")).toBeHidden();
    await expect(page.locator("#out-prom")).toBeVisible();
  });

  test("latency SLI swaps the selectors", async ({ page }) => {
    await page.goto("/");
    await expect(field(page, "good")).toBeHidden();
    await page.getByLabel("Latency: histogram bucket at a threshold").check();
    await expect(field(page, "good")).toBeVisible();
    await expect(field(page, "errors")).toBeHidden();
    await expect(page.locator("#out-prom")).toContainText("1 - (");
  });

  test("policy rows can be added, edited, and removed", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Add row" }).click();
    await expect(page.locator("#policy tr")).toHaveCount(5);
    await expect(page.getByLabel("Budget burned (%), row 5")).toBeFocused();
    await expect(page.locator("#errorList")).toContainText("Policy row 5: another row already uses these windows.");
    await page.getByLabel("Long window, row 5").fill("7d");
    await page.getByLabel("Short window, row 5").fill("12h");
    await expect(page.locator("#analysis tr")).toHaveCount(5);
    await expect(page.locator("#out-prom")).toContainText("slo:sli_error:ratio_rate7d");
    await page.getByRole("button", { name: "Remove row 1" }).click();
    await expect(page.locator("#analysis tr")).toHaveCount(4);
    await expect(page.locator("#out-prom")).not.toContainText("ratio_rate5m");
    await page.getByRole("button", { name: "Reset to workbook defaults" }).click();
    await expect(page.locator("#analysis tr")).toHaveCount(4);
    expect(new URL(page.url()).hash).toBe("");
  });

  test("URL hash round-trips the whole config", async ({ page, browser }) => {
    await page.goto("/");
    await field(page, "service").fill("payments");
    await field(page, "slo").fill("99.95");
    await field(page, "days").fill("28");
    await field(page, "groupBy").fill("cluster");
    await field(page, "guard").fill("0");
    await page.getByLabel("Latency: histogram bucket at a threshold").check();
    await page.getByLabel("Severity, row 2").selectOption("ticket");
    const url = page.url();
    expect(url).toContain("#");
    const prom = await page.locator("#out-prom").textContent();

    const other = await browser.newPage();
    await other.goto(url);
    await expect(field(other, "service")).toHaveValue("payments");
    await expect(field(other, "days")).toHaveValue("28");
    await expect(other.getByLabel("Severity, row 2")).toHaveValue("ticket");
    await expect(other.locator("#out-prom")).toHaveText(prom);
    await other.close();

    await page.evaluate(() => { location.hash = "slo=99"; });
    await expect(field(page, "slo")).toHaveValue("99");
    await expect(field(page, "service")).toHaveValue("checkout");
  });

  test("copy buttons write the config and share link to the clipboard", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/#slo=99.5");
    const btn = page.locator('[data-copy="terraform"]');
    await btn.click();
    await expect(btn).toHaveText("Copied");
    const tf = await page.locator("#out-terraform").textContent();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(tf);
    await page.getByRole("button", { name: "Copy share link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  });

  test("download buttons save the generated files", async ({ page }) => {
    await page.goto("/");
    for (const [kind, name] of [["prom", "checkout-slo-rules.yml"], ["grafana", "checkout-slo-grafana.yml"], ["terraform", "checkout-slo.tf"]]) {
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`[data-download="${kind}"]`).click()]);
      expect(download.suggestedFilename()).toBe(name);
      const body = readFileSync(await download.path(), "utf8");
      expect(body).toBe(await page.locator(`#out-${kind}`).textContent());
    }
  });
});
