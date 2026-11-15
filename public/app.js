// Page wiring: form <-> state <-> URL hash, then render. All math and config text comes from slo.js.
import {
  WORKBOOK_POLICY, analyze, validate, toHash, fromHash, formatDuration, percent,
  prometheusRules, grafanaRules, terraformRules,
} from "./slo.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const field = (k) => form.querySelector(`[name="${k}"]`);
const FIELDS = ["service", "errors", "total", "good", "count", "groupBy", "slo", "days", "guard", "rps", "whatIf"];
const NUMBERS = new Set(["slo", "days", "guard", "rps", "whatIf"]);
const FILES = {
  prom: { gen: prometheusRules, name: (s) => `${s.service}-slo-rules.yml`, type: "application/yaml" },
  grafana: { gen: grafanaRules, name: (s) => `${s.service}-slo-grafana.yml`, type: "application/yaml" },
  terraform: { gen: terraformRules, name: (s) => `${s.service}-slo.tf`, type: "text/plain" },
};
let current = null; // last valid state, used by copy and download

function read() {
  const s = { sli: form.querySelector('[name="sli"]:checked')?.value ?? "" };
  for (const k of FIELDS) {
    const v = field(k).value.trim();
    s[k] = NUMBERS.has(k) ? (v === "" ? null : Number(v)) : v;
  }
  s.guard ??= 0;
  s.whatIf ??= 0;
  s.policy = [...$("policy").rows].map((tr) => {
    const f = (k) => tr.querySelector(`[data-f="${k}"]`).value.trim();
    return { pct: f("pct") === "" ? NaN : Number(f("pct")), long: f("long"), short: f("short"), severity: f("severity") };
  });
  return s;
}

function rowEl(r) {
  const tr = $("rowTpl").content.firstElementChild.cloneNode(true);
  for (const k of ["pct", "long", "short", "severity"]) tr.querySelector(`[data-f="${k}"]`).value = r[k] ?? "";
  return tr;
}

// Row numbers in accessible names, so "Long window, row 2" is unambiguous.
function renumber() {
  [...$("policy").rows].forEach((tr, i) => {
    for (const el of tr.querySelectorAll("[data-f]")) el.setAttribute("aria-label", `${el.closest("td").dataset.k}, row ${i + 1}`);
    tr.querySelector("[data-remove]").setAttribute("aria-label", `Remove row ${i + 1}`);
  });
}

function write(s) {
  for (const k of FIELDS) field(k).value = s[k] ?? "";
  for (const r of form.querySelectorAll('[name="sli"]')) r.checked = r.value === s.sli;
  $("policy").replaceChildren(...s.policy.map(rowEl));
  renumber();
}

const out = (k, v) => { for (const el of document.querySelectorAll(`[data-out="${k}"]`)) el.textContent = v; };
const td = (k, ...kids) => { const c = document.createElement("td"); c.dataset.k = k; c.append(...kids); return c; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; };

function render(s) {
  for (const box of document.querySelectorAll("[data-sli]")) box.hidden = box.dataset.sli !== s.sli;
  const errs = validate(s);
  $("errorList").replaceChildren(...errs.map((e) => el("li", "", e)));
  $("errors").hidden = !errs.length;
  for (const sec of document.querySelectorAll(".out")) sec.hidden = errs.length > 0;
  if (errs.length) { current = null; return; }
  current = s;

  const a = analyze(s);
  out("budget", percent(a.budget));
  out("budgetNote", `${s.slo}% over ${s.days} days`);
  out("window", formatDuration(a.downtime.window));
  out("windowLabel", `of full downtime per ${s.days}-day window`);
  out("day", formatDuration(a.downtime.day));
  out("week", formatDuration(a.downtime.week));
  out("month", formatDuration(a.downtime.month));
  if (a.requests) {
    out("requests", Math.round(a.requests.window).toLocaleString("en-US"));
    out("requestsLabel", `failed requests allowed per ${s.days} days at ${s.rps} req/s (${Math.round(a.requests.day).toLocaleString("en-US")} per day)`);
  } else {
    out("requests", "n/a");
    out("requestsLabel", "budget in requests: enter current traffic above");
  }

  out("whatIfHead", `At ${s.whatIf}% errors`);
  $("analysis").replaceChildren(...a.rows.map((r, i) => {
    const tr = document.createElement("tr");
    const policy = td("Policy", el("span", `sev ${r.severity}`, r.severity), ` #${i + 1}: ${r.pct}% of budget in ${r.long}`, el("small", "", `short window ${r.short}`));
    const outage = r.outage == null ? el("span", "never", "never (threshold is 100% or more)") : formatDuration(r.outage);
    const whatIf = r.whatIfAfter == null ? el("span", "never", `never (${s.whatIf}% is not above ${percent(r.threshold)})`) : `fires in ${formatDuration(r.whatIfAfter)}`;
    tr.append(policy, td("Burn rate", `${r.burn}x`), td("Fires above", `${percent(r.threshold)} errors`), td("Full outage fires in", outage), td("Budget spent by then", percent(r.consumed)), td(`At ${s.whatIf}% errors`, whatIf));
    return tr;
  }));
  chart(s, a);

  for (const [k, f] of Object.entries(FILES)) $(`out-${k}`).textContent = f.gen(s);
}

// Budget remaining over the window at a constant error rate, with a dot where each alert fires.
function chart(s, a) {
  const svg = $("chart");
  const NS = "http://www.w3.org/2000/svg";
  const node = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  // viewBox matches the drawn width so 12px labels stay 12px on a phone.
  const VW = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 600);
  svg.setAttribute("viewBox", `0 0 ${VW} 220`);
  const [L, R, T, B] = [44, VW - 14, 14, 190];
  const W = a.windowSec;
  const e = s.whatIf / 100;
  const left = (t) => Math.max(0, 1 - (e * t) / (a.budget * W));
  const x = (t) => L + (t / W) * (R - L);
  const y = (f) => T + (1 - f) * (B - T);
  const kids = [];
  for (const f of [0, 0.5, 1]) kids.push(node("line", { class: "grid", x1: L, x2: R, y1: y(f), y2: y(f) }), node("text", { class: "tick", x: L - 8, y: y(f) + 4, "text-anchor": "end" }, `${f * 100}%`));
  for (const f of [0, 0.5, 1]) kids.push(node("text", { class: "tick", x: x(f * W), y: B + 20, "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle" }, `day ${+(f * s.days).toFixed(1)}`));
  const end = Math.min(W, a.exhaustAfter);
  const pts = [[0, 1], [end, left(end)]];
  if (end < W) pts.push([W, 0]);
  const d = pts.map(([t, f], i) => `${i ? "L" : "M"}${x(t).toFixed(1)} ${y(f).toFixed(1)}`).join(" ");
  kids.push(node("path", { class: "area", d: `${d} L${R} ${B} L${L} ${B} Z` }), node("path", { class: "curve", d }));
  const fired = new Map(); // rows that fire at the same moment share one dot
  a.rows.forEach((r, i) => {
    if (r.whatIfAfter == null) return;
    const g = fired.get(r.whatIfAfter) ?? { rows: [], severity: r.severity };
    g.rows.push(i + 1);
    if (r.severity === "page") g.severity = "page";
    fired.set(r.whatIfAfter, g);
  });
  [...fired].forEach(([t, g], k) => {
    const far = x(t) > R - 60; // keep labels near the right edge inside the chart
    const cy = y(left(t));
    const above = cy - 10 - k * 16; // above-right of the dot is empty because the line only falls
    kids.push(
      node("circle", { class: `mark ${g.severity}`, cx: x(t), cy, r: 6 }),
      node("text", { class: "mark-label", x: x(t) + (far ? -10 : 10), y: above < 12 ? cy + 22 + k * 16 : above, "text-anchor": far ? "end" : "start" }, `#${g.rows.join(",")}`),
    );
  });
  svg.replaceChildren(...kids);

  const gone = a.exhaustAfter <= W ? `the ${s.days}-day budget is gone in ${formatDuration(a.exhaustAfter)}` : `${percent(left(W))} of the budget is left at the end of the window`;
  const fires = [...fired].map(([t, g]) => `row ${g.rows.join(" and ")} fires in ${formatDuration(t)}`);
  $("chartCaption").textContent = `At a steady ${s.whatIf}% error rate, ${gone}. ${fires.length ? `First alerts: ${fires.join("; ")}.` : "No alert in the policy fires at this rate."}`;
  out("chartNote", `${s.whatIf}% errors`);
}

function update() {
  const s = read();
  const h = toHash(s);
  history.replaceState(null, "", h ? `#${h}` : location.pathname);
  render(s);
}

let statusTimer;
function announce(btn, text) {
  const label = btn.textContent;
  btn.textContent = text;
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { btn.textContent = label; $("status").textContent = ""; }, 1600);
}

async function copy(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    announce(btn, "Copied");
  } catch {
    announce(btn, "Copy failed");
  }
}

form.addEventListener("input", update);
form.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.matches("[data-remove]")) {
    t.closest("tr").remove();
    renumber();
    update();
    $("addRow").focus();
  } else if (t.id === "addRow") {
    const rows = read().policy;
    const tr = rowEl(rows.at(-1) ?? WORKBOOK_POLICY[0]);
    $("policy").append(tr);
    renumber();
    update();
    tr.querySelector("input").focus();
  } else if (t.id === "resetPolicy") {
    $("policy").replaceChildren(...WORKBOOK_POLICY.map(rowEl));
    renumber();
    update();
  } else if (t.id === "copyLink") {
    copy(t, location.href);
  } else if (t.dataset.copy && current) {
    copy(t, $(`out-${t.dataset.copy}`).textContent);
  } else if (t.dataset.download && current) {
    const f = FILES[t.dataset.download];
    const url = URL.createObjectURL(new Blob([f.gen(current)], { type: f.type }));
    const link = Object.assign(document.createElement("a"), { href: url, download: f.name(current) });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});

function load() {
  write(fromHash(location.hash));
  render(read());
}
addEventListener("hashchange", load);
new ResizeObserver(() => current && chart(current, analyze(current))).observe($("chart"));
load();
