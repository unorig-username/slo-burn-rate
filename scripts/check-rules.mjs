// Checks generated Prometheus rules with promtool, run from the official image in Docker.
// 1. `promtool check rules` on every variant (syntax, PromQL, label names).
// 2. `promtool test rules` on simulated traffic: quiet when healthy, all four alerts during a full outage,
//    and the latency SLI counting slow requests as errors.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, prometheusRules } from "../public/slo.js";

const IMAGE = "prom/prometheus:v3.16.0";
const state = (over) => ({ ...structuredClone(DEFAULTS), ...over });
const VARIANTS = {
  availability: {},
  latency: { sli: "latency" },
  grouped: { groupBy: "cluster, namespace" },
  "guard-off": { guard: 0 },
  "28d-9999-grouped-latency": { days: 28, slo: 99.99, sli: "latency", groupBy: "cluster" },
};

const FIRING = 'count by (severity) (ALERTS{alertname="ErrorBudgetBurn",alertstate="firing"})';
const OUTAGE_TEST = `rule_files: [availability.yml]
evaluation_interval: 1m
tests:
  # 10 req/s. Healthy for a day (so the 1d and 3d traffic guards see real volume),
  # then every request fails from minute 1441.
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="checkout",code="200"}'
        values: '0+600x1440 864000+0x119'
      - series: 'http_requests_total{job="checkout",code="500"}'
        values: '0+0x1440 600+600x119'
    alert_rule_test:
      - eval_time: 1435m
        alertname: ErrorBudgetBurn
        exp_alerts: []
    promql_expr_test:
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 1435m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout"}'
            value: 0
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 1450m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout"}'
            value: 1
      # Three minutes in: both pages and the 3d ticket fire. The 1d ticket needs about 4.3 minutes.
      - expr: '${FIRING}'
        eval_time: 1443m
        exp_samples:
          - labels: '{severity="page"}'
            value: 2
          - labels: '{severity="ticket"}'
            value: 1
      - expr: '${FIRING}'
        eval_time: 1450m
        exp_samples:
          - labels: '{severity="page"}'
            value: 2
          - labels: '{severity="ticket"}'
            value: 2
  # 0.5 req/s, every request failing: below the 1 req/s guard, so nothing fires.
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="checkout",code="500"}'
        values: '0+30x180'
    alert_rule_test:
      - eval_time: 170m
        alertname: ErrorBudgetBurn
        exp_alerts: []
`;

// 2 req/s, 1.5 of them under 0.3 s: a 25% error ratio (values chosen to be exact in floating point).
const LATENCY_TEST = `rule_files: [latency.yml]
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      - series: 'http_request_duration_seconds_bucket{job="checkout",le="0.3"}'
        values: '0+90x30'
      - series: 'http_request_duration_seconds_count{job="checkout"}'
        values: '0+120x30'
    promql_expr_test:
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 20m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout"}'
            value: 0.25
`;

// Inside the repo, not the OS temp dir: Colima and some Docker setups only share the home directory.
const base = join(import.meta.dirname, "..", ".tmp");
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, "promtool-"));
let failed = false;
try {
  for (const [name, over] of Object.entries(VARIANTS)) writeFileSync(join(dir, `${name}.yml`), prometheusRules(state(over)));
  writeFileSync(join(dir, "outage.test.yml"), OUTAGE_TEST);
  writeFileSync(join(dir, "latency.test.yml"), LATENCY_TEST);
  const promtool = (...args) => spawnSync("docker", ["run", "--rm", "--entrypoint", "promtool", "-v", `${dir}:/w:ro`, "-w", "/w", IMAGE, ...args], { stdio: "inherit" });
  for (const args of [["check", "rules", ...Object.keys(VARIANTS).map((n) => `${n}.yml`)], ["test", "rules", "outage.test.yml", "latency.test.yml"]]) {
    const r = promtool(...args);
    if (r.error || r.status !== 0) failed = true;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "promtool: FAILED" : "promtool: all checks passed");
process.exit(failed ? 1 : 0);
