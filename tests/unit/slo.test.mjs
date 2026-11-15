// Math and generator tests. Run with: node --test "tests/unit/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  DEFAULTS, analyze, validate, toHash, fromHash, formatDuration, parseWindow, promDuration,
  errorRatio, prometheusRules, grafanaRules, terraformRules,
} from "../../public/slo.js";
import { DIR as EXAMPLES_DIR, render as renderExamples } from "../../scripts/export-examples.mjs";

const state = (over = {}) => ({ ...structuredClone(DEFAULTS), ...over });
const LATENCY = { sli: "latency" };
const GROUPED = { groupBy: "cluster, namespace" };
const VARIANTS = {
  default: {},
  latency: LATENCY,
  grouped: GROUPED,
  "guard off": { guard: 0 },
  "28 days, 99.99%, grouped latency": { days: 28, slo: 99.99, ...LATENCY, ...GROUPED },
};

test("99.9% over 30 days allows 43m 12s of downtime", () => {
  const a = analyze(state());
  assert.equal(a.budget, 0.001);
  assert.equal(a.downtime.window, 2592);
  assert.equal(formatDuration(a.downtime.window), "43m 12s");
  assert.equal(formatDuration(a.downtime.day), "1m 26s");
  assert.equal(formatDuration(a.downtime.week), "10m 5s");
});

test("workbook policy gives burn rates 14.4, 6, 3, 1 and the matching thresholds", () => {
  const a = analyze(state());
  assert.deepEqual(a.rows.map((r) => r.burn), [14.4, 6, 3, 1]);
  assert.deepEqual(a.rows.map((r) => r.threshold), [0.0144, 0.006, 0.003, 0.001]);
  assert.deepEqual(a.rows.map((r) => r.consumed), [0.02, 0.05, 0.1, 0.1]);
});

test("99.9% with burn 14.4 fires on a full outage after 51.84 s", () => {
  const [page] = analyze(state()).rows;
  assert.equal(page.outage, 51.84);
  assert.equal(formatDuration(page.outage), "51.84s");
});

test("28-day window scales burn rates and budget", () => {
  const a = analyze(state({ days: 28 }));
  assert.deepEqual(a.rows.map((r) => r.burn), [13.44, 5.6, 2.8, 0.9333333333]);
  assert.equal(formatDuration(a.downtime.window), "40m 19s");
  assert.equal(formatDuration(a.downtime.month), "43m 12s");
});

test("99.99% shrinks the budget tenfold", () => {
  const a = analyze(state({ slo: 99.99 }));
  assert.equal(a.budget, 0.0001);
  assert.equal(formatDuration(a.downtime.window), "4m 19s");
  assert.equal(a.rows[0].threshold, 0.00144);
  assert.equal(a.rows[0].outage, 5.184);
});

test("a threshold of 100% or more never fires", () => {
  const a = analyze(state({ slo: 90, policy: [{ pct: 50, long: "1h", short: "5m", severity: "page" }] }));
  assert.equal(a.rows[0].burn, 360);
  assert.equal(a.rows[0].outage, null);
});

test("what-if error rate: 1% fires the 6h page after 3h 36m and spends the budget in 3 days", () => {
  const a = analyze(state());
  assert.deepEqual(a.rows.map((r) => r.whatIfAfter), [null, 12960, 25920, 25920]);
  assert.equal(formatDuration(a.rows[1].whatIfAfter), "3h 36m");
  assert.equal(formatDuration(a.exhaustAfter), "3d");
  assert.equal(analyze(state({ whatIf: 0 })).exhaustAfter, Infinity);
});

test("budget in requests", () => {
  const a = analyze(state({ rps: 250 }));
  assert.equal(a.requests.window, 648000);
  assert.equal(a.requests.day, 21600);
  assert.equal(analyze(state()).requests, null);
});

test("windows parse and normalize", () => {
  assert.equal(parseWindow("5m"), 300);
  assert.equal(parseWindow("1w"), 604800);
  assert.ok(Number.isNaN(parseWindow("1h30m")));
  assert.ok(Number.isNaN(parseWindow("0h")));
  assert.equal(promDuration(3600), "1h");
  assert.equal(promDuration(5400), "90m");
  assert.equal(promDuration(604800), "7d");
});

test("availability rule file: recording rules for every window, alerts with guard and labels", () => {
  const doc = parse(prometheusRules(state()));
  const [rec, alerts] = doc.groups;
  assert.deepEqual(rec.rules.map((r) => r.record), ["5m", "30m", "1h", "2h", "6h", "1d", "3d"].map((w) => `slo:sli_error:ratio_rate${w}`));
  assert.equal(
    rec.rules[0].expr,
    '(\n  sum(rate(http_requests_total{job="checkout",code=~"5.."}[5m]))\n  or\n  0 * sum(rate(http_requests_total{job="checkout"}[5m]))\n)\n/\nsum(rate(http_requests_total{job="checkout"}[5m]))',
  );
  assert.deepEqual(rec.rules[0].labels, { slo: "checkout-availability" });
  assert.equal(alerts.rules.length, 4);
  assert.equal(
    alerts.rules[0].expr,
    'slo:sli_error:ratio_rate1h{slo="checkout-availability"} > (14.4 * 0.001)\nand\nslo:sli_error:ratio_rate5m{slo="checkout-availability"} > (14.4 * 0.001)\nand on ()\nsum(rate(http_requests_total{job="checkout"}[1h])) > 1',
  );
  assert.deepEqual(alerts.rules.map((r) => r.labels.severity), ["page", "page", "ticket", "ticket"]);
  assert.deepEqual(Object.keys(alerts.rules[0].annotations), ["summary", "description", "runbook_url"]);
  assert.match(alerts.rules[0].annotations.runbook_url, /REPLACE-ME/);
});

test("availability ratio is 0, not empty, when no error series exists yet", () => {
  assert.equal(
    errorRatio(state(GROUPED), "1h"),
    '(sum by (cluster, namespace) (rate(http_requests_total{job="checkout",code=~"5.."}[1h])) or 0 * sum by (cluster, namespace) (rate(http_requests_total{job="checkout"}[1h]))) / sum by (cluster, namespace) (rate(http_requests_total{job="checkout"}[1h]))',
  );
  assert.equal(parse(grafanaRules(state())).groups[0].rules[0].data[0].model.expr, errorRatio(state(), "1h"));
});

test("an availability and a latency SLO for one service share no names", () => {
  const names = (over) => {
    const s = state(over);
    const prom = parse(prometheusRules(s)).groups;
    const graf = parse(grafanaRules(s)).groups[0];
    return [
      ...prom.map((g) => g.name),
      ...prom[0].rules.map((r) => `${r.record}${JSON.stringify(r.labels)}`),
      ...prom[1].rules.map((r) => JSON.stringify(r.labels)),
      graf.name,
      ...graf.rules.flatMap((r) => [r.uid, r.title]),
      ...terraformRules(s).match(/^resource .*$|^  name .*$/gm),
    ];
  };
  const avail = names({}), lat = names(LATENCY);
  assert.equal(avail.length, lat.length);
  assert.deepEqual(avail.filter((n) => lat.includes(n)), []);
  const long = "a-very-long-service-name-for-uid-limits";
  const uids = (over) => parse(grafanaRules(state({ service: long, ...over }))).groups[0].rules.map((r) => r.uid);
  assert.deepEqual(uids({}).filter((u) => uids(LATENCY).includes(u)), []);
});

test("long selectors and many policy rows are kept whole", () => {
  const routes = Array.from({ length: 40 }, (_, i) => `/api/v1/route${i}`).join("|");
  const total = `http_requests_total{job="checkout",route=~"${routes}"}`;
  assert.ok(total.length > 600);
  const s = state({ total });
  assert.deepEqual(validate(s), []);
  assert.ok(prometheusRules(s).includes(`rate(${total}[5m])`));
  assert.equal(fromHash(`#${toHash(s)}`).total, total);
  const policy = Array.from({ length: 13 }, (_, i) => ({ pct: 2, long: `${i + 2}h`, short: "5m", severity: "page" }));
  assert.equal(fromHash(`#${toHash(state({ policy }))}`).policy.length, 13);
});

test("latency SLI uses 1 - good/total over the histogram", () => {
  const prom = prometheusRules(state(LATENCY));
  const rec = parse(prom).groups[0].rules[0];
  assert.equal(
    rec.expr,
    '1 - (\n  sum(rate(http_request_duration_seconds_bucket{job="checkout",le="0.3"}[5m]))\n  /\n  sum(rate(http_request_duration_seconds_count{job="checkout"}[5m]))\n)',
  );
  assert.match(prom, /sum\(rate\(http_request_duration_seconds_count\{job="checkout"\}\[1h\]\)\) > 1/);
  assert.doesNotMatch(prom, /http_requests_total/);
  assert.match(grafanaRules(state(LATENCY)), /1 - \(sum\(rate\(http_request_duration_seconds_bucket/);
});

test("group-by labels appear in every aggregation and every and on()", () => {
  for (const out of [prometheusRules, grafanaRules, terraformRules].map((g) => g(state(GROUPED)))) {
    const sums = out.match(/\bsum\b.*?\(rate/g);
    assert.ok(sums.length > 0);
    for (const s of sums) assert.equal(s, "sum by (cluster, namespace) (rate");
    for (const on of out.match(/\bon \([^)]*\)/g) ?? []) assert.equal(on, "on (cluster, namespace)");
  }
  assert.equal(prometheusRules(state(GROUPED)).match(/and on \(cluster, namespace\)/g).length, 4);
});

test("guard off removes the and clause and the traffic query", () => {
  const off = state({ guard: 0 });
  const prom = prometheusRules(off);
  assert.doesNotMatch(prom, /and on/);
  assert.doesNotMatch(prom, /\]\)\) > /);
  const graf = parse(grafanaRules(off)).groups[0].rules[0];
  assert.deepEqual(graf.data.map((d) => d.refId), ["A", "B", "C"]);
  assert.equal(graf.condition, "C");
  assert.equal(graf.data[2].model.expression, "$A > 0.0144 && $B > 0.0144");
  assert.doesNotMatch(terraformRules(off), /\$C/);
});

test("Grafana provisioning file has the expected shape", () => {
  const doc = parse(grafanaRules(state()));
  assert.equal(doc.apiVersion, 1);
  const [group] = doc.groups;
  assert.equal(group.rules.length, 4);
  const rule = group.rules[0];
  assert.equal(rule.uid, "slo-checkout-availability-1h-5m");
  assert.equal(rule.condition, "D");
  assert.equal(rule.noDataState, "NoData");
  assert.equal(rule.execErrState, "Error");
  assert.equal(rule.for, "1m");
  assert.deepEqual(rule.data.map((d) => [d.refId, d.datasourceUid]), [["A", "PROMETHEUS_DATASOURCE_UID"], ["B", "PROMETHEUS_DATASOURCE_UID"], ["C", "PROMETHEUS_DATASOURCE_UID"], ["D", "__expr__"]]);
  assert.equal(rule.data[0].model.instant, true);
  assert.equal(rule.data[3].model.type, "math");
  assert.equal(rule.data[3].model.expression, "$A > 0.0144 && $B > 0.0144 && $C > 1");
  assert.equal(rule.labels.severity, "page");
  assert.ok(rule.annotations.runbook_url);
  const uids = group.rules.map((r) => r.uid);
  assert.equal(new Set(uids).size, uids.length);
  const long = parse(grafanaRules(state({ service: "a-very-long-service-name-for-uid-limits" }))).groups[0].rules;
  for (const r of long) assert.ok(r.uid.length <= 40, r.uid);
});

test("every variant produces YAML that parses", () => {
  for (const [name, over] of Object.entries(VARIANTS)) {
    assert.deepEqual(validate(state(over)), [], name);
    assert.ok(parse(prometheusRules(state(over))).groups.length === 2, name);
    assert.ok(parse(grafanaRules(state(over))).groups[0].rules.length === 4, name);
  }
});

test("Terraform output is terraform fmt clean", (t) => {
  const probe = spawnSync("terraform", ["version"], { encoding: "utf8" });
  if (probe.error) return t.skip("terraform is not installed");
  const dir = mkdtempSync(join(tmpdir(), "slo-tf-"));
  try {
    for (const [i, over] of Object.values(VARIANTS).entries()) writeFileSync(join(dir, `v${i}.tf`), terraformRules(state(over)));
    const fmt = spawnSync("terraform", ["fmt", "-check", "-diff", dir], { encoding: "utf8" });
    assert.equal(fmt.status, 0, fmt.stdout + fmt.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Terraform output uses variables and keeps PromQL out of HCL interpolation", () => {
  const tf = terraformRules(state({ total: 'x{a="${b}",c="%{d}"}' }));
  assert.match(tf, /folder_uid\s+= var\.folder_uid/);
  assert.match(tf, /datasource_uid = var\.prometheus_datasource_uid/);
  assert.match(tf, /model = jsonencode\(\{/);
  assert.match(tf, /\$\$\{b\}/);
  assert.match(tf, /%%\{d\}/);
  assert.equal(tf.match(/^  rule \{$/gm).length, 4);
});

test("URL hash round-trips and defaults give an empty hash", () => {
  assert.equal(toHash(state()), "");
  const s = state({ service: "api", slo: 99.5, days: 28, sli: "latency", groupBy: "cluster", rps: 40, guard: 0, policy: [{ pct: 2, long: "1h", short: "5m", severity: "ticket" }] });
  assert.deepEqual(fromHash(`#${toHash(s)}`), s);
});

test("hash input is cleaned and judged by validate", () => {
  const s = fromHash("#svc=a%0Ab&slo=abc&p=2,1h,5m,page;x,,,nope&err=sum%0A%00x");
  assert.equal(s.service, "a b");
  assert.equal(s.errors, "sum x");
  assert.ok(Number.isNaN(s.slo));
  const errs = validate(s);
  assert.ok(errs.some((e) => e.startsWith("Service name")));
  assert.ok(errs.some((e) => e.startsWith("SLO target")));
  assert.ok(errs.some((e) => e.startsWith("Policy row 2")));
});

test("validate catches bad input", () => {
  const bad = (over) => validate(state(over));
  assert.equal(bad({ slo: 100 }).length, 1);
  assert.match(bad({ days: 0 })[0], /^SLO window/);
  assert.equal(bad({ days: 7.5 }).length, 1);
  assert.equal(bad({ groupBy: "ok, 9bad" }).length, 1);
  assert.equal(bad({ errors: "  " }).length, 1);
  assert.equal(bad({ rps: 0 }).length, 1);
  assert.equal(bad({ whatIf: 101 }).length, 1);
  assert.equal(bad({ policy: [] }).length, 1);
  assert.match(bad({ policy: [{ pct: 2, long: "5m", short: "1h", severity: "page" }] })[0], /shorter than the long window/);
  assert.match(bad({ days: 2 })[0], /longer than the SLO window/);
  const dupe = { pct: 2, long: "1h", short: "5m", severity: "page" };
  assert.match(bad({ policy: [dupe, dupe] })[0], /already uses these windows/);
});

test("committed examples match the generators (run npm run examples to refresh)", () => {
  const want = renderExamples();
  assert.deepEqual(readdirSync(EXAMPLES_DIR).sort(), Object.keys(want).sort());
  for (const [name, files] of Object.entries(want)) {
    assert.deepEqual(readdirSync(join(EXAMPLES_DIR, name)).sort(), Object.keys(files).sort(), name);
    for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(EXAMPLES_DIR, name, file), "utf8"), text, `${name}/${file}`);
  }
});
