"""Build the encrypted static dashboard (index.html).

Usage:
    pip install cryptography
    WRIKE_DASH_PASSWORD='your-password' python build.py

Reads the Wrike exports from data/ (never committed; see .gitignore) and the page
code from src/, then writes index.html with everything AES-256-GCM encrypted.
The key is derived from the password with PBKDF2-SHA256 (600,000 iterations).
"""
import base64
import datetime
import gzip
import json
import os
import pathlib
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ROOT = pathlib.Path(__file__).parent
ITER = 600_000
D3_SRI = "sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i"
DATASETS = {
    "projects": "projects.csv",
    "monthly": "timelog_monthly.csv",
    "tasks": "timelog_tasks.csv",
    "weekly": "timelog_weekly.csv",
    "calendar": "calendar.csv",
    "teams": "teams.csv",
}
DEFAULT_PARAMS = {"po": "4389613829", "uc_po": "", "ppl": "active", "region": "", "account": "", "team": ""}


def main() -> None:
    password = os.environ.get("WRIKE_DASH_PASSWORD")
    if not password or len(password) < 12:
        sys.exit("Set WRIKE_DASH_PASSWORD (at least 12 characters).")

    app = {
        "html": (ROOT / "src/app.html").read_text(encoding="utf-8"),
        "js": (ROOT / "src/app.js").read_text(encoding="utf-8"),
        "shim": (ROOT / "src/shim.js").read_text(encoding="utf-8"),
        "params": DEFAULT_PARAMS,
        "asof": os.environ.get("ASOF") or datetime.date.today().isoformat(),
        "data": {k: (ROOT / "data" / f).read_text(encoding="utf-8") for k, f in DATASETS.items()},
    }
    plain = gzip.compress(json.dumps(app, ensure_ascii=False).encode("utf-8"), compresslevel=9)

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode("utf-8"))
    ct = AESGCM(key).encrypt(iv, plain, None)

    b = lambda x: base64.b64encode(x).decode()
    payload = json.dumps({"salt": b(salt), "iv": b(iv), "iter": ITER, "ct": b(ct)})
    shell = (ROOT / "src/shell.html").read_text(encoding="utf-8")
    out = shell.replace("__D3_SRI__", D3_SRI).replace("__PAYLOAD__", payload)
    (ROOT / "index.html").write_text(out, encoding="utf-8")
    print(f"Wrote index.html ({len(out) / 1e6:.2f} MB, {len(plain) / 1e6:.2f} MB compressed payload)")


if __name__ == "__main__":
    main()
