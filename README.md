# DUCAR Decision Support App

GitHub-ready offline web app for DUCAR road and bridge maintenance prioritisation.

## Features

- Runs offline in a browser
- Calculates road and bridge priority scores
- Applies maintainability/referral rules
- Selects eligible works against the received budget
- Exports CSV and GeoJSON-ready programme data

## Repository Structure

- `index.html` - standalone browser app
- `src/prioritisation.js` - reusable scoring logic
- `data/sample_assets.json` - sample DUCAR records
- `docs/` - implementation notes
- `tests/` - lightweight Node tests

## Local Use

Open `index.html` directly, or run:

```bash
npm test
```

Generated: 2026-05-05
