// Writes the generated configs for a few common setups to examples/, one folder per setup,
// with the same file names the page's Download buttons use. Run: npm run examples
// A unit test fails when the committed files no longer match the generators.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, validate, sloName, prometheusRules, grafanaRules, terraformRules } from "../public/slo.js";

export const EXAMPLES = {
  availability: {},
  latency: { sli: "latency" },
  "group-by-job-route": { groupBy: "job,route" },
  "guard-off": { guard: 0 },
  "28d-99.99": { days: 28, slo: 99.99 },
};

export const DIR = join(import.meta.dirname, "..", "examples");

// Folder name -> { file name: contents }.
export function render() {
  const out = {};
  for (const [name, over] of Object.entries(EXAMPLES)) {
    const s = { ...structuredClone(DEFAULTS), ...over };
    const errs = validate(s);
    if (errs.length) throw new Error(`${name}: ${errs.join(" ")}`);
    out[name] = {
      [`${sloName(s)}-slo-rules.yml`]: prometheusRules(s),
      [`${sloName(s)}-slo-grafana.yml`]: grafanaRules(s),
      [`${sloName(s)}-slo.tf`]: terraformRules(s),
    };
  }
  return out;
}

if (import.meta.main) {
  rmSync(DIR, { recursive: true, force: true });
  for (const [name, files] of Object.entries(render())) {
    mkdirSync(join(DIR, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(DIR, name, file), text);
  }
  console.log(`wrote ${Object.keys(EXAMPLES).length} examples to examples/`);
}
