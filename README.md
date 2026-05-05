# DUCAR Priority Studio

Dynamic React and Python decision-support tool for DUCAR road and bridge maintenance prioritisation.

## What It Does

- Runs a modern React dashboard for budget rationalisation and allocation.
- Uses a Python standard-library API with NumPy for deterministic neural risk scoring.
- Performs geospatial hotspot clustering, bounding-box analysis and nearest bridge proximity checks.
- Allocates budget by priority while preserving region, district and functional classification visibility.
- Exports GIS-ready GeoJSON from the browser.

## Architecture

- `src/main.jsx` - React interface and dynamic dashboard.
- `src/styles.css` - modern editable CSS design system.
- `src/prioritisation.js` - browser-side fallback scoring logic.
- `api/server.py` - Python ML/geospatial API.
- `data/sample_assets.json` - spatial DUCAR sample records.
- `tests/prioritisation.test.js` - lightweight logic tests.

## Local Development

Install dependencies:

```bash
npm install
```

Start the Python ML/geospatial API:

```bash
npm run api
```

Start the React app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/
```

## Machine Learning Note

The backend includes an auditable two-hidden-layer NumPy neural risk model. It uses fixed weights so the tool runs without heavy dependencies. For production, replace the fixed weights with trained weights from historical DUCAR deterioration, completed works, cost outturn and post-maintenance condition data.

## GitHub Pages Note

The React app can be built as a static frontend, but the Python ML API requires local/server hosting. Without the Python API, the browser fallback risk model still runs.
