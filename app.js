import { compareJson, summarize } from "./diff.js";

const beforeInput = document.querySelector("#before");
const afterInput = document.querySelector("#after");
const results = document.querySelector("#results");
const message = document.querySelector("#message");
const summary = document.querySelector("#summary");
let currentChanges = [];

const exampleBefore = {
  service: "payments-api",
  version: 2,
  features: { refunds: false, receipts: true },
  regions: ["eu", "us"]
};
const exampleAfter = {
  service: "payments-api",
  version: 3,
  features: { refunds: true, receipts: true, webhooks: true },
  regions: ["eu", "apac"],
  owner: "platform-team"
};

function displayValue(value) {
  return JSON.stringify(value, null, 2);
}

function clearMessage() {
  message.textContent = "";
  beforeInput.removeAttribute("aria-invalid");
  afterInput.removeAttribute("aria-invalid");
}

function render(changes) {
  results.replaceChildren();
  const count = summarize(changes);
  summary.textContent = `${count.added} added · ${count.removed} removed · ${count.changed} changed`;

  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No differences found. Both JSON values match.";
    results.append(empty);
    return;
  }

  for (const change of changes) {
    const item = document.createElement("article");
    item.className = `change change--${change.type}`;
    const heading = document.createElement("div");
    heading.className = "change__heading";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = change.type;
    const path = document.createElement("code");
    path.textContent = change.path;
    heading.append(badge, path);
    item.append(heading);

    for (const side of ["before", "after"]) {
      if (!Object.hasOwn(change, side)) continue;
      const line = document.createElement("div");
      line.className = "change__value";
      const label = document.createElement("span");
      label.textContent = side === "before" ? "Before" : "After";
      const value = document.createElement("pre");
      value.textContent = displayValue(change[side]);
      line.append(label, value);
      item.append(line);
    }
    results.append(item);
  }
}

function compare() {
  clearMessage();
  let before;
  let after;
  try {
    before = JSON.parse(beforeInput.value);
  } catch (error) {
    beforeInput.setAttribute("aria-invalid", "true");
    message.textContent = `Original JSON: ${error.message}`;
    beforeInput.focus();
    return;
  }
  try {
    after = JSON.parse(afterInput.value);
  } catch (error) {
    afterInput.setAttribute("aria-invalid", "true");
    message.textContent = `Updated JSON: ${error.message}`;
    afterInput.focus();
    return;
  }
  currentChanges = compareJson(before, after);
  render(currentChanges);
}

document.querySelector("#compare").addEventListener("click", compare);
document.querySelector("#example").addEventListener("click", () => {
  beforeInput.value = displayValue(exampleBefore);
  afterInput.value = displayValue(exampleAfter);
  compare();
});
document.querySelector("#clear").addEventListener("click", () => {
  beforeInput.value = "";
  afterInput.value = "";
  currentChanges = [];
  clearMessage();
  summary.textContent = "Ready to compare";
  results.innerHTML = '<p class="empty">Paste two JSON values or load the example to see a comparison.</p>';
  beforeInput.focus();
});
document.querySelector("#copy").addEventListener("click", async () => {
  const report = currentChanges.length
    ? currentChanges.map(change => `${change.type.toUpperCase()} ${change.path}\n${Object.hasOwn(change, "before") ? `Before: ${displayValue(change.before)}\n` : ""}${Object.hasOwn(change, "after") ? `After: ${displayValue(change.after)}` : ""}`).join("\n\n")
    : "No differences found.";
  try {
    await navigator.clipboard.writeText(report);
    message.textContent = "Report copied to clipboard.";
  } catch {
    message.textContent = "Clipboard access is unavailable. Select and copy the results instead.";
  }
});

beforeInput.value = displayValue(exampleBefore);
afterInput.value = displayValue(exampleAfter);
compare();
