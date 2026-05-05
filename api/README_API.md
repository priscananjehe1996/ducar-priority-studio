# DUCAR Python ML/Geospatial API

Run:

```bash
python api/server.py
```

Base URL:

```text
http://127.0.0.1:8765
```

Endpoints:

- `GET /api/health`
- `GET /api/sample`
- `GET /api/analyse`
- `POST /api/analyse`

The API uses only Python standard library plus NumPy. It provides:

- Two-hidden-layer deterministic neural risk model.
- Road/bridge priority scoring.
- Budget selection.
- Geospatial k-means hotspot clustering.
- Bounding box calculation.
- Nearest bridge proximity analysis for roads.

Production improvement path:

1. Replace deterministic neural weights with trained historical model weights.
2. Add actual road geometry rather than point centroids.
3. Add rainfall/flood/slope/soil layers.
4. Add district and regional allocation constraints from policy.
5. Add persisted scenario storage.
