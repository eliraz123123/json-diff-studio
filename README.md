# JSON Diff Studio

A browser-based tool for comparing JSON values. Paste two API responses or configuration files to see which fields were added, removed, or changed.

## Features

- Recursive comparison of objects and arrays
- Readable JSON paths for every difference
- Clear validation errors for invalid input
- Copyable text report
- Runs locally in your browser; the app does not upload your JSON
- No runtime dependencies or build step

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open <http://localhost:4173>. The app starts with sample data. Select **Clear** to paste your own JSON.

## Run tests

```bash
npm test
```

## How it works

`diff.js` walks both JSON values recursively. Object keys are compared by name; array items are compared by index. A field that exists on one side only is reported as added or removed. A pair of unequal primitive values or different container types is reported as changed.

## Limitations

Array items are compared by index, so inserting an item near the beginning can produce several changes. The tool compares parsed JSON values, not formatting or key order.
