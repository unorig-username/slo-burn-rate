// SLO error budget math and burn-rate alert generators. Pure functions, no DOM:
// the page (app.js) and the Node tests both import this file.
// Method: Google SRE Workbook, chapter 5 "Alerting on SLOs", multiwindow, multi-burn-rate alerts.

export const SITE = "https://slo.coreyjones.dev/";
export const RUNBOOK_PLACEHOLDER = "https://example.com/REPLACE-ME/runbooks/slo-";
export const GRAFANA_FOR = "1m";
const DAY = 86400;
const UNITS = { s: 1, m: 60, h: 3600, d: DAY, w: 7 * DAY };

// The workbook's recommended starting policy for a 30-day SLO.
export const WORKBOOK_POLICY = [
  { pct: 2, long: "1h", short: "5m", severity: "page" },
  { pct: 5, long: "6h", short: "30m", severity: "page" },
  { pct: 10, long: "1d", short: "2h", severity: "ticket" },
  { pct: 10, long: "3d", short: "6h", severity: "ticket" },
];

export const DEFAULTS = {
  service: "checkout",
  sli: "availability",
  errors: 'http_requests_total{job="checkout",code=~"5.."}',
  total: 'http_requests_total{job="checkout"}',
  good: 'http_request_duration_seconds_bucket{job="checkout",le="0.3"}',
  count: 'http_request_duration_seconds_count{job="checkout"}',
  groupBy: "",
  slo: 99.9,
  days: 30,
  guard: 1,
  rps: null,
  whatIf: 1,
  policy: WORKBOOK_POLICY,
};

const round = (x) => Number(x.toPrecision(10)); // drops float noise: 1 - 0.999 is 0.0010000000000000009
const num = (x) => String(Number(x.toPrecision(6)));
export const percent = (x) => `${num(x * 100)}%`;

// Strips control characters and newlines so user text can't break YAML, HCL, or comments.
export const clean = (v) => String(v ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
export const parseLabels = (s) => clean(s).split(",").map((x) => x.trim()).filter(Boolean);

export function parseWindow(w) {
  const m = /^(\d+)([smhdw])$/.exec(clean(w));
  return m && +m[1] > 0 ? +m[1] * UNITS[m[2]] : NaN;
}

// Seconds to the largest whole Prometheus unit: 3600 -> "1h", 5400 -> "90m".
export function promDuration(sec) {
  for (const [u, n] of [["d", DAY], ["h", 3600], ["m", 60]]) if (sec % n === 0) return `${sec / n}${u}`;
  return `${sec}s`;
}

// Human duration: "51.84s", "43m 12s", "2d 2h". Two units at most.
export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return "never";
  if (sec < 60) return `${Number(sec.toFixed(2))}s`;
  let s = Math.round(sec);
  const parts = [];
  for (const [u, n] of [["d", DAY], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (s >= n || parts.length) parts.push([Math.floor(s / n), u]);
    s %= n;
  }
  return parts.slice(0, 2).filter(([v], i) => v || i === 0).map(([v, u]) => v + u).join(" ");
}

export const budgetOf = (slo) => round((100 - slo) / 100);

// Burn rate that spends pct% of the budget in one long window: pct x window hours / long window hours.
export const burnRate = (pct, days, longSec) => round(((pct / 100) * days * DAY) / longSec);

export function validate(s) {
  const errs = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(s.service)) errs.push("Service name: letters, digits, dot, dash, or underscore, up to 40 characters.");
  if (!["availability", "latency"].includes(s.sli)) errs.push("Choose an SLI type.");
  const sels = s.sli === "latency" ? [["Good events", s.good], ["Total events", s.count]] : [["Error events", s.errors], ["Total events", s.total]];
  for (const [name, v] of sels) if (!clean(v)) errs.push(`${name} selector is empty.`);
  for (const l of parseLabels(s.groupBy)) if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(l)) errs.push(`"${l}" is not a valid Prometheus label name.`);
  if (!(s.slo > 0 && s.slo < 100)) errs.push("SLO target must be above 0 and below 100 percent.");
  if (!(Number.isInteger(s.days) && s.days >= 1 && s.days <= 365)) errs.push("SLO window must be a whole number of days, 1 to 365.");
  if (!(s.guard >= 0)) errs.push("Minimum traffic must be 0 or more requests per second.");
  if (s.rps != null && !(s.rps > 0)) errs.push("Current traffic must be above 0, or left empty.");
  if (!(s.whatIf >= 0 && s.whatIf <= 100)) errs.push("What-if error rate must be between 0 and 100 percent.");
  if (!s.policy.length) errs.push("Add at least one alert policy row.");
  const seen = new Set();
  s.policy.forEach((r, i) => {
    const row = `Policy row ${i + 1}`;
    const long = parseWindow(r.long), short = parseWindow(r.short);
    if (!(r.pct > 0 && r.pct <= 100)) errs.push(`${row}: budget burned must be above 0 and at most 100 percent.`);
    if (!long) errs.push(`${row}: long window must look like 1h, 6h, 1d, or 3d.`);
    if (!short) errs.push(`${row}: short window must look like 5m, 30m, or 2h.`);
    if (long && short && short >= long) errs.push(`${row}: short window must be shorter than the long window.`);
    if (long > s.days * DAY) errs.push(`${row}: long window is longer than the SLO window.`);
    if (!["page", "ticket"].includes(r.severity)) errs.push(`${row}: severity must be page or ticket.`);
    const key = `${long}/${short}`;
    if (long && short && seen.has(key)) errs.push(`${row}: another row already uses these windows.`);
    seen.add(key);
  });
  return errs;
}

// Everything the page shows. Assumes validate(s) returned no errors.
export function analyze(s) {
  const budget = budgetOf(s.slo);
  const windowSec = s.days * DAY;
  const e = s.whatIf / 100;
  const rows = s.policy.map((r) => {
    const longSec = parseWindow(r.long), shortSec = parseWindow(r.short);
    const burn = burnRate(r.pct, s.days, longSec);
    const threshold = round(burn * budget);
    return {
      ...r,
      long: promDuration(longSec),
      short: promDuration(shortSec),
      longSec,
      shortSec,
      burn,
      threshold,
      // A full outage pushes the long-window ratio to the threshold after threshold x long window.
      outage: threshold < 1 ? round(threshold * longSec) : null,
      consumed: round((burn * longSec) / windowSec),
      // A constant error rate e fires only above the threshold, after threshold x long window / e.
      whatIfAfter: e > threshold ? round((threshold * longSec) / e) : null,
    };
  });
  return {
    budget,
    windowSec,
    downtime: { window: budget * windowSec, day: budget * DAY, week: budget * 7 * DAY, month: budget * 30 * DAY },
    requests: s.rps ? { window: s.rps * windowSec * budget, day: s.rps * DAY * budget } : null,
    exhaustAfter: e > 0 ? round((budget * windowSec) / e) : Infinity,
    rows,
  };
}

// ---- URL hash state ----

const KEYS = { service: "svc", sli: "sli", errors: "err", total: "tot", good: "good", count: "cnt", groupBy: "by", slo: "slo", days: "days", guard: "guard", rps: "rps", whatIf: "whatif" };
const NUMERIC = new Set(["slo", "days", "guard", "rps", "whatIf"]);
const encodePolicy = (p) => p.map((r) => [r.pct, r.long, r.short, r.severity].join(",")).join(";");

export function toHash(s) {
  const p = new URLSearchParams();
  for (const [k, q] of Object.entries(KEYS)) if (s[k] != null && String(s[k]) !== String(DEFAULTS[k])) p.set(q, s[k]);
  const pol = encodePolicy(s.policy);
  if (pol !== encodePolicy(DEFAULTS.policy)) p.set("p", pol);
  return p.toString();
}

// The hash comes from whoever shared the link: clean every value, validate() judges the rest.
export function fromHash(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const s = structuredClone(DEFAULTS);
  for (const [k, q] of Object.entries(KEYS)) {
    if (!p.has(q)) continue;
    const v = clean(p.get(q));
    s[k] = NUMERIC.has(k) ? (v === "" ? null : Number(v)) : v;
  }
  if (p.has("p")) {
    s.policy = clean(p.get("p")).split(";").filter(Boolean).slice(0, 12).map((row) => {
      const [pct, long = "", short = "", severity = ""] = row.split(",").map((x) => x.trim());
      return { pct: Number(pct), long, short, severity };
    });
  }
  return s;
}

// ---- PromQL ----

const by = (labels) => (labels.length ? ` by (${labels.join(", ")}) ` : "");
const sumRate = (sel, w, labels) => `sum${by(labels)}(rate(${clean(sel)}[${w}]))`;
const totalSel = (s) => (s.sli === "latency" ? s.count : s.total);

// Bad events / all events over window w. Latency SLIs count requests above the bucket boundary as bad.
export function errorRatio(s, w, multiline = false) {
  const labels = parseLabels(s.groupBy);
  const [a, b] = s.sli === "latency" ? [s.good, s.count] : [s.errors, s.total];
  const [x, y] = [sumRate(a, w, labels), sumRate(b, w, labels)];
  if (s.sli === "latency") return multiline ? `1 - (\n  ${x}\n  /\n  ${y}\n)` : `1 - (${x} / ${y})`;
  return multiline ? `${x}\n/\n${y}` : `${x} / ${y}`;
}

export const trafficExpr = (s, w) => sumRate(totalSel(s), w, parseLabels(s.groupBy));

// ---- Shared alert text ----

const sq = (v) => `'${String(v).replaceAll("'", "''")}'`; // YAML single-quoted scalar
// HCL string with template sequences escaped. Function replacers, because "$$" in a replacement string means "$".
const hq = (v) => JSON.stringify(String(v)).replaceAll("${", () => "$${").replaceAll("%{", () => "%%{");
const indent = (text, n) => text.split("\n").map((l) => " ".repeat(n) + l);

function texts(s, r) {
  const lasts = formatDuration((s.days * DAY) / r.burn);
  return {
    summary: `${s.service} is burning its error budget at ${num(r.burn)}x (${r.pct}% of the ${s.days}d budget in ${r.long})`,
    detail: `Alert threshold is ${percent(r.threshold)} errors (${num(r.burn)}x burn on a ${s.slo}% SLO, ${r.long} and ${r.short} windows). At this rate the ${s.days}d budget lasts ${lasts}.`,
    runbook: `${RUNBOOK_PLACEHOLDER}${s.service}`,
  };
}

const ruleLabels = (s, r) => [["severity", r.severity], ["slo", s.service], ["long_window", r.long], ["short_window", r.short]];
const header = (s, what) => [
  `# ${what} for the ${s.service} SLO: ${s.slo}% over ${s.days}d (${s.sli}).`,
  `# Multiwindow, multi-burn-rate alerts (Google SRE Workbook, chapter 5).`,
  `# Edit: ${SITE}${toHash(s) ? `#${toHash(s)}` : ""}`,
];

// ---- 1. Prometheus rule file ----

export function prometheusRules(s) {
  const a = analyze(s);
  const labels = parseLabels(s.groupBy);
  const windows = [...new Map(a.rows.flatMap((r) => [[r.shortSec, r.short], [r.longSec, r.long]]))].sort((x, y) => x[0] - y[0]).map(([, w]) => w);
  const out = [...header(s, "Prometheus recording and alerting rules"), "groups:", `  - name: ${sq(`slo-${s.service}-recording`)}`, "    rules:"];
  for (const w of windows) {
    out.push(`      - record: slo:sli_error:ratio_rate${w}`, "        expr: |-", ...indent(errorRatio(s, w, true), 10), "        labels:", `          slo: ${sq(s.service)}`);
  }
  out.push(`  - name: ${sq(`slo-${s.service}-alerts`)}`, "    rules:");
  for (const r of a.rows) {
    const t = texts(s, r);
    const over = (w) => `slo:sli_error:ratio_rate${w}{slo="${s.service}"} > (${num(r.burn)} * ${num(a.budget)})`;
    const expr = [over(r.long), "and", over(r.short)];
    if (s.guard > 0) expr.push(`and on (${labels.join(", ")})`, `${trafficExpr(s, r.long)} > ${num(s.guard)}`);
    out.push(
      "      - alert: ErrorBudgetBurn",
      "        expr: |-",
      ...indent(expr.join("\n"), 10),
      "        labels:",
      ...ruleLabels(s, r).map(([k, v]) => `          ${k}: ${sq(v)}`),
      "        annotations:",
      `          summary: ${sq(t.summary)}`,
      `          description: ${sq(`Error ratio over the last ${r.long} is {{ $value | humanizePercentage }}. ${t.detail}`)}`,
      "          # Placeholder: point runbook_url at your runbook.",
      `          runbook_url: ${sq(t.runbook)}`,
    );
  }
  return out.join("\n") + "\n";
}

// ---- 2 and 3. Grafana-managed rules ----

function grafanaRule(s, r) {
  const prom = [["A", errorRatio(s, r.long)], ["B", errorRatio(s, r.short)]];
  if (s.guard > 0) prom.push(["C", trafficExpr(s, r.long)]);
  const t = num(r.threshold);
  const terms = [`$A > ${t}`, `$B > ${t}`];
  if (s.guard > 0) terms.push(`$C > ${num(s.guard)}`);
  const slug = s.service.replace(/[^A-Za-z0-9_-]/g, "-");
  const suffix = `-${r.long}-${r.short}`;
  const tx = texts(s, r);
  return {
    uid: `slo-${slug}`.slice(0, 40 - suffix.length) + suffix, // Grafana UIDs max out at 40 characters
    title: `${s.service} SLO burn ${r.long}/${r.short}`,
    condition: s.guard > 0 ? "D" : "C",
    prom,
    expression: terms.join(" && "),
    labels: ruleLabels(s, r),
    annotations: [
      ["summary", tx.summary],
      ["description", `Error ratio over the last ${r.long} is {{ humanizePercentage $values.A.Value }}. ${tx.detail}`],
      ["runbook_url", tx.runbook],
    ],
  };
}

export function grafanaRules(s) {
  const a = analyze(s);
  const out = [
    ...header(s, "Grafana alerting file provisioning"),
    "# Goes in provisioning/alerting/. Replace PROMETHEUS_DATASOURCE_UID with your Prometheus datasource UID.",
    "# runbook_url values are placeholders.",
    "apiVersion: 1",
    "groups:",
    "  - orgId: 1",
    `    name: ${sq(`slo-${s.service}`)}`,
    "    folder: SLOs",
    "    interval: 1m",
    "    rules:",
  ];
  for (const r of a.rows) {
    const g = grafanaRule(s, r);
    out.push(`      - uid: ${sq(g.uid)}`, `        title: ${sq(g.title)}`, `        condition: ${g.condition}`, "        data:");
    for (const [refId, expr] of g.prom) {
      out.push(
        `          - refId: ${refId}`,
        "            relativeTimeRange:",
        "              from: 600",
        "              to: 0",
        "            datasourceUid: PROMETHEUS_DATASOURCE_UID",
        "            model:",
        `              refId: ${refId}`,
        `              expr: ${sq(expr)}`,
        "              instant: true",
        "              range: false",
      );
    }
    out.push(
      `          - refId: ${g.condition}`,
      "            relativeTimeRange:",
      "              from: 0",
      "              to: 0",
      "            datasourceUid: __expr__",
      "            model:",
      `              refId: ${g.condition}`,
      "              type: math",
      `              expression: ${sq(g.expression)}`,
      "        noDataState: NoData",
      "        execErrState: Error",
      `        for: ${GRAFANA_FOR}`,
      "        labels:",
      ...g.labels.map(([k, v]) => `          ${k}: ${sq(v)}`),
      "        annotations:",
      ...g.annotations.map(([k, v]) => `          ${k}: ${sq(v)}`),
    );
  }
  return out.join("\n") + "\n";
}

// terraform fmt aligns "=" across consecutive single-line attributes at one indent.
// A line that opens a block or a multi-line value ends the run.
const ATTR = /^( *)([\w-]+|"[^"]*") = (.*[^{([])$/;
function alignHcl(lines) {
  const out = [];
  let run = [];
  const flush = () => {
    const w = Math.max(...run.map((m) => m[2].length));
    out.push(...run.map((m) => `${m[1]}${m[2].padEnd(w)} = ${m[3]}`));
    run = [];
  };
  for (const line of lines) {
    const m = ATTR.exec(line);
    if (run.length && (!m || m[1] !== run[0][1])) flush();
    if (m) run.push(m);
    else out.push(line);
  }
  if (run.length) flush();
  return out;
}

export function terraformRules(s) {
  const a = analyze(s);
  const name = `slo_${s.service.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const map = (k, pairs) => [`    ${k} = {`, ...pairs.map(([pk, v]) => `      ${pk} = ${hq(v)}`), "    }"];
  const L = [
    ...header(s, "Grafana-managed alert rules (grafana/grafana provider)"),
    "# runbook_url values are placeholders.",
    "",
    'variable "prometheus_datasource_uid" {',
    "  type = string",
    '  description = "UID of the Prometheus datasource the rules query."',
    "}",
    "",
    'variable "folder_uid" {',
    "  type = string",
    '  description = "UID of the Grafana folder that holds the rule group."',
    "}",
    "",
    `resource "grafana_rule_group" "${name}" {`,
    `  name = ${hq(`slo-${s.service}`)}`,
    "  folder_uid = var.folder_uid",
    "  interval_seconds = 60",
  ];
  for (const r of a.rows) {
    const g = grafanaRule(s, r);
    L.push(
      "",
      "  rule {",
      `    name = ${hq(g.title)}`,
      `    condition = "${g.condition}"`,
      `    for = "${GRAFANA_FOR}"`,
      '    no_data_state = "NoData"',
      '    exec_err_state = "Error"',
      ...map("labels", g.labels),
      ...map("annotations", g.annotations),
    );
    for (const [refId, expr] of g.prom) {
      L.push(
        "",
        "    data {",
        `      ref_id = "${refId}"`,
        "      datasource_uid = var.prometheus_datasource_uid",
        "      relative_time_range {",
        "        from = 600",
        "        to = 0",
        "      }",
        "      model = jsonencode({",
        `        refId = "${refId}"`,
        `        expr = ${hq(expr)}`,
        "        instant = true",
        "        range = false",
        "      })",
        "    }",
      );
    }
    L.push(
      "",
      "    data {",
      `      ref_id = "${g.condition}"`,
      '      datasource_uid = "__expr__"',
      "      relative_time_range {",
      "        from = 0",
      "        to = 0",
      "      }",
      "      model = jsonencode({",
      `        refId = "${g.condition}"`,
      '        type = "math"',
      `        expression = ${hq(g.expression)}`,
      "      })",
      "    }",
      "  }",
    );
  }
  L.push("}");
  return alignHcl(L).join("\n") + "\n";
}
