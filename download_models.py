"""
download_models.py
==================
Downloads the face-api.js model weight files needed by the browser client.

Models downloaded
-----------------
- tiny_face_detector  — fast face detection (< 200 KB)
- face_landmark_68    — 68-point landmark localisation
- face_expression     — 7-class expression recognition

Run once before starting the server:
    python download_models.py
"""

import os
import urllib.request
import pathlib

BASE_URL = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights"

FILES = [
    # Tiny face detector
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    # 68-point landmark model
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    # Expression model
    "face_expression_model-weights_manifest.json",
    "face_expression_model-shard1",
]

models_dir = pathlib.Path("models")
models_dir.mkdir(exist_ok=True)

for fname in FILES:
    dest = models_dir / fname
    if dest.exists():
        print(f"[SKIP] {fname} already exists")
        continue
    url = f"{BASE_URL}/{fname}"
    print(f"[DL]   {fname} ...", end=" ", flush=True)
    try:
        urllib.request.urlretrieve(url, dest)
        print(f"✓  ({dest.stat().st_size // 1024} KB)")
    except Exception as e:
        print(f"✗  FAILED: {e}")

print("\nDone! All model weights are in ./models/")
