// Checks generated Prometheus rules with promtool, run from the official image in Docker.
// 1. `promtool check rules` on every variant (syntax, PromQL, label names).
// 2. `promtool test rules` on simulated traffic: quiet when healthy, all four alerts during a full outage,
//    a 0 error ratio (not no data) before the first 5xx, and an availability and a latency SLO for one
//    service loaded side by side without overwriting each other.
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
  # 10 req/s. Healthy for three days, so every window up to 3d sees full history,
  # then every request fails from minute 4321.
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="checkout",code="200"}'
        values: '0+600x4320 2592000+0x119'
      - series: 'http_requests_total{job="checkout",code="500"}'
        values: '0+0x4320 600+600x119'
    alert_rule_test:
      - eval_time: 4315m
        alertname: ErrorBudgetBurn
        exp_alerts: []
    promql_expr_test:
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 4315m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout-availability"}'
            value: 0
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 4330m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout-availability"}'
            value: 1
      # Three minutes in: both pages fire (they need 51.84s and 2m 10s). Both tickets need 4m 19s.
      - expr: '${FIRING}'
        eval_time: 4323m
        exp_samples:
          - labels: '{severity="page"}'
            value: 2
      - expr: '${FIRING}'
        eval_time: 4325m
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

// Availability and latency SLOs for one service, loaded together. 2 req/s, none failed and no 5xx
// series at all, 1.5 req/s under 0.3 s: availability ratio 0, latency ratio 25% (exact in floating point).
const LATENCY_TEST = `rule_files: [availability.yml, latency.yml]
evaluation_interval: 1m
tests:
  - interval: 1m
    input_series:
      - series: 'http_requests_total{job="checkout",code="200"}'
        values: '0+120x70'
      - series: 'http_request_duration_seconds_bucket{job="checkout",le="0.3"}'
        values: '0+90x70'
      - series: 'http_request_duration_seconds_count{job="checkout"}'
        values: '0+120x70'
    promql_expr_test:
      - expr: slo:sli_error:ratio_rate5m
        eval_time: 20m
        exp_samples:
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout-availability"}'
            value: 0
          - labels: 'slo:sli_error:ratio_rate5m{slo="checkout-latency"}'
            value: 0.25
      # After an hour the 1h traffic guard passes: only the latency 1h page fires.
      - expr: 'count by (slo, long_window) (ALERTS{alertname="ErrorBudgetBurn",alertstate="firing"})'
        eval_time: 65m
        exp_samples:
          - labels: '{slo="checkout-latency",long_window="1h"}'
            value: 1
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
