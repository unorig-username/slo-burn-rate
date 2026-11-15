# slo-burn-rate

A static web tool that turns an SLO into multiwindow, multi-burn-rate alerts. Live at [slo.coreyjones.dev](https://slo.coreyjones.dev).

Enter a service, an SLI (error and total counters, or a latency histogram), the SLO target, and the window. You get:

- The error budget as a fraction of events, as full downtime per window, day, week, and 30 days, and in requests if you give current traffic.
- A table per alert policy row: burn rate, the error ratio it fires above, how long a full outage takes to fire it, how much budget is gone by then, and whether a steady what-if error rate fires it at all.
- A chart of budget remaining over the window at the what-if rate, with a dot where each alert fires.
- Three configs to copy or download: a Prometheus rule file, a Grafana alerting provisioning file, and a Terraform `grafana_rule_group`.

Everything runs in the browser. There is no backend, no analytics, and no cookies. The whole config lives in the URL hash, so sharing the link shares the setup.

## The math

This is the method from [chapter 5, "Alerting on SLOs", of the Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/).

**Error budget.** `budget = 1 - SLO`. At 99.9% that is 0.1% of events. Spent as full downtime over 30 days, that is 43m 12s.

**Burn rate.** How many times faster than "exactly on budget" you are spending. A row that alerts when a share of the budget burns within a long window has

```
burn rate = budget share x SLO window hours / long window hours
```

The default policy is the workbook's starting point:

| Severity | Budget burned | Long window | Short window | Burn rate (30d) |
| --- | --- | --- | --- | --- |
| page | 2% | 1h | 5m | 14.4 |
| page | 5% | 6h | 30m | 6 |
| ticket | 10% | 1d | 2h | 3 |
| ticket | 10% | 3d | 6h | 1 |

**Alert condition.** A row fires when the error ratio over both the long and the short window is above `burn rate x (1 - SLO)`. The long window sets the sensitivity. The short window makes the alert stop soon after the errors stop, instead of firing for hours on old data. An optional traffic guard (`and on(...) sum(rate(total[long window])) > N`) keeps a handful of failed requests at 3am from paging anyone.

**Time to fire.** On a full outage the long-window ratio climbs linearly, so it crosses the threshold after `burn rate x (1 - SLO) x long window`. For 99.9% and a 14.4 burn rate over 1h that is 51.84 s. A row whose threshold is 100% or more can never fire.

**What-if.** A steady error rate `e` fires a row only when `e` is above the threshold, after `threshold x long window / e`. At that moment the budget spent is `burn rate x long window / SLO window`, which is the row's own budget share. That is the point of the method: every row spends a known slice of the budget before it fires, whatever the error rate.

The times ignore scrape and rule evaluation intervals and assume the window was clean before the errors started.

## Generated config

- **Prometheus.** Recording rules `slo:sli_error:ratio_rate<window>` with an `slo` label, one per distinct window, then one `ErrorBudgetBurn` alert per policy row with `severity`, `slo`, `long_window`, and `short_window` labels.

The SLO's name is `<service>-<sli>`, for example `checkout-availability`. It goes into the `slo` label, the rule group names, the Grafana UIDs and titles, and the Terraform resource name, so an availability and a latency SLO for the same service can be loaded side by side.
- **Grafana file provisioning.** Grafana-managed rules that query Prometheus directly, so they don't depend on the recording rules. Each rule has one instant query per window, a traffic query when the guard is on, and a math expression as the condition, such as `$A > 0.0144 && $B > 0.0144 && $C > 1`. Rules use `for: 1m`, so they fire about a minute after the Prometheus rules. Replace `PROMETHEUS_DATASOURCE_UID` before loading the file.
- **Terraform.** The same rules as a `grafana_rule_group` for the `grafana/grafana` provider, with `var.prometheus_datasource_uid` and `var.folder_uid`.

Every `runbook_url` is a placeholder. Replace it.

[`examples/`](examples) has all three files for five setups: the defaults, a latency SLI, group-by `job,route`, the traffic guard off, and 99.99% over 28 days. `npm run examples` rewrites them.

Group-by labels go into every `sum by (...)` and every `and on (...)`, so each cluster or namespace is judged against its own budget.

The availability ratio is `(sum(rate(errors[w])) or 0 * sum(rate(total[w]))) / sum(rate(total[w]))`. Client libraries create the `code="5xx"` series on the first error, so a healthy service often has none. Without the `or`, the ratio would be empty, and Grafana would turn that into a NoData alert.

Things to know before you ship the rules:

- Rates over 1d and 3d of raw counters are expensive on a large Prometheus. The recording rules help the Prometheus path. The Grafana rules query raw series every minute.
- The traffic guard averages over the long window. A series younger than that window reads as lower traffic than it has.
- Grafana rules use `noDataState: NoData`. If the total series is missing entirely, usually a wrong selector, the rule raises a `DatasourceNoData` alert with the rule's labels.
- Grafana provisioning expands environment variables in titles and labels. That is why service names are limited to letters, digits, `.`, `-`, and `_`. Queries, math expressions, and annotations are not expanded.
- For a latency SLI, check the exact `le` value with a query first. Prometheus 3 writes whole-number bucket boundaries as `1.0`, not `1`.

## How it is checked

- `npm run lint`: html-validate on every page.
- `npm run test:unit`: Node's built-in test runner against `public/slo.js`. Budget and burn-rate math for 30 and 28 day windows, 99.9% and 99.99%, latency SLIs, group-by labels in every aggregation, the traffic guard on and off, the missing-5xx fallback, distinct names for two SLOs on one service, long selectors kept whole, URL hash round trips, input validation, YAML that parses, `terraform fmt -check` on generated HCL, and committed examples that match the generators.
- `npm run test:e2e`: Playwright against `wrangler dev` on desktop and iPhone 15 (Chromium). Light and dark mode, no console or CSP errors, axe with no serious or critical WCAG 2.2 AA violations, no horizontal scroll at 390px, live updates, hash round trips, copy, and download.
- `npm run check:rules`: `promtool` from the `prom/prometheus` image in Docker. `check rules` on five variants and the five examples, then `test rules` on simulated traffic. After three days of healthy traffic: no alerts, both pages three minutes into a full outage, and all four alerts by minute five. Nothing fires when traffic is under the guard. With an availability and a latency SLO for one service loaded together: the availability ratio is 0 while no 5xx series exists, the latency ratio counts slow requests as errors, and only the latency alert fires.
- The Grafana and Terraform examples are also test fixtures in [grafana-alert-lint](https://github.com/unorig-username/grafana-alert-lint), where every check stays quiet on them. The guard-off example trips only its traffic-guard check.

## Run it

Needs Node 26. `check:rules` needs Docker. The Terraform test is skipped if `terraform` is not on the PATH.

```bash
npm ci
npx playwright install chromium   # once
npm run dev           # http://localhost:8787
npm test              # lint, unit tests, Playwright
npm run check:rules   # promtool via Docker
```

The code is plain static files in `public/`. `slo.js` holds all the math and generators as pure functions with no DOM, `app.js` wires the page, and `_headers` sets the CSP (`script-src 'self'`, no inline scripts).

## Deploy

Served by Cloudflare Workers Static Assets. `wrangler.jsonc` maps the site to the `slo.coreyjones.dev` custom domain.

```bash
npm run deploy   # wrangler deploy, needs Cloudflare auth
```

CI runs lint and tests only. It does not deploy.

## License

MIT. See [LICENSE](LICENSE).
