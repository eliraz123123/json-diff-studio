// Builds the landing page from page.html and config.json.
//   node build.mjs                    -> dist/index.html, ready to upload
//   node build.mjs --preview <file>   -> a page fragment with sample values, for previews
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const template = readFileSync(join(here, "page.html"), "utf8");
const previewIndex = process.argv.indexOf("--preview");
const preview = previewIndex !== -1;

const PREVIEW_VALUES = {
  FOUNDER_NAME: "[השם שלך]",
  FOUNDER_BLURB: "[משפט אחד עליך: מה עשית עד היום ולמה בנית את זה]",
  CONTACT_EMAIL: "[האימייל שלך]"
};
const REQUIRED = ["PRODUCT_NAME", "FOUNDER_NAME", "FOUNDER_BLURB", "CONTACT_EMAIL", "SIGNUP_ENDPOINT", "FORM_PROVIDER"];

const values = { ...config };
if (preview) {
  for (const [key, value] of Object.entries(PREVIEW_VALUES)) if (!values[key]) values[key] = value;
} else {
  const missing = REQUIRED.filter(key => !String(values[key] ?? "").trim());
  if (missing.length) {
    console.error(`Fill these in config.json before publishing: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!/^https:\/\//.test(values.SIGNUP_ENDPOINT)) {
    console.error("SIGNUP_ENDPOINT must be an https:// URL, for example https://formspree.io/f/abcdwxyz");
    process.exit(1);
  }
}

const escape = value => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
  if (!(key in values)) throw new Error(`Unknown placeholder ${match}`);
  return escape(values[key]);
});

if (preview) {
  const out = process.argv[previewIndex + 1];
  writeFileSync(out, page);
  console.log(`Preview written to ${out}`);
} else {
  // Everything above the marker belongs in <head>.
  const [head, body] = page.split("<!-- /head -->");
  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;
  mkdirSync(join(here, "dist"), { recursive: true });
  writeFileSync(join(here, "dist", "index.html"), html);
  console.log("Built dist/index.html");
}
