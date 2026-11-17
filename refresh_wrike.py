"""Pull time logs, projects and PO budgets from Wrike and write the dashboard CSVs to data/.

Needs a Wrike permanent API token with read access to the Account Management space:
    WRIKE_TOKEN=...  [WRIKE_HOST=app-eu.wrike.com]  [WRIKE_SPACE="Account Management"]  python refresh_wrike.py
"""
import collections
import csv
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time

import requests

HOST = os.environ.get("WRIKE_HOST", "app-eu.wrike.com")
SPACE_TITLE = os.environ.get("WRIKE_SPACE", "Account Management")
START = os.environ.get("WRIKE_START", "2025-01-01")
OUT = pathlib.Path(__file__).parent / "data"
API = f"https://{HOST}/api/v4"
S = requests.Session()
S.headers["Authorization"] = "Bearer " + os.environ["WRIKE_TOKEN"]

PROJECT_TYPES = {"PO", "Lead - Opportunity", "PoV", "Uncharged Project", "Business Development (non billable)"}
BUDGET_FIELDS = {
    "budget_eur": "Total PO Budget (€)", "current_budget_eur": "Current Budget", "budget_pd": "PD",
    "budget_hours": "Total PO Hours", "avg_rate_eur_per_pd": "Avg Rate", "po_type": "PO Type",
    "region": "Celonis Region", "engagement_lead": "Engagement Lead", "delivery_lead": "Delivery Lead",
}
# Client-specific name fixes live in the WRIKE_ACCOUNT_ALIASES secret (JSON: {"alias": {...}, "display": {...}})
# so that no client names are stored in this repository.
_names = json.loads(os.environ.get("WRIKE_ACCOUNT_ALIASES") or "{}")
ALIAS = _names.get("alias", {})      # lower-case text found in item/task names -> account name
DISPLAY = _names.get("display", {})  # normalised account key -> preferred display name


def get(path, **params):
    params = {k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in params.items()}
    for attempt in range(6):
        r = S.get(API + path, params=params, timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(5 * (attempt + 1)); continue
        if not r.ok:
            raise SystemExit(f"Wrike API {r.status_code} on {path}: {r.text[:300]}")
        return r.json()
    raise SystemExit(f"Wrike API kept failing on {path}")


def paged(path, **params):
    out, token = [], None
    while True:
        p = dict(params, pageSize=1000) if token is None else {"nextPageToken": token}
        j = get(path, **p)
        out += j.get("data", [])
        token = j.get("nextPageToken")
        if not token:
            return out


def batched(path_fmt, ids, **params):
    out, ids = [], list(ids)
    for i in range(0, len(ids), 100):
        path = path_fmt.format(",".join(ids[i:i + 100]))
        try:
            out += get(path, **params).get("data", [])
        except SystemExit:
            if not params:
                raise
            params = {}  # optional fields not supported: fall back to the default model
            out += get(path).get("data", [])
    return out


def plain_type(name):
    return re.sub(r"^[^\w]+", "", name or "").strip()


def clean(t):
    if not t or len(t) > 90 or re.search(r"No changes are needed|Rename the project|as per the instruction|have been (marked|updated)|where this agent", t, re.I):
        return None
    t = re.sub(r"^\[?DO NOT USE\]?\s*", "", t, flags=re.I)
    t = re.sub(r"\s*(Tag Note|Note tag added).*$", "", t, flags=re.I)
    return re.sub(r"\s*do not use\s*$", "", t, flags=re.I).strip()


def key(s):
    k = re.sub(r"[^a-z0-9]", "", (s or "").lower())
    for p in _names.get("prefixes", []):
        if k.startswith(p):
            return p
    return k


def main():
    today = dt.date.today()
    OUT.mkdir(exist_ok=True)

    space = next((s for s in get("/spaces")["data"] if s["title"].strip().lower() == SPACE_TITLE.lower()), None)
    if not space:
        raise SystemExit(f"Space '{SPACE_TITLE}' not found for this token.")
    cf = {c["id"]: c for c in get("/customfields")["data"]}
    cf_by_title = collections.defaultdict(list)
    for c in cf.values():
        cf_by_title[c["title"].strip()].append(c)
    wanted = {}
    for col, title in BUDGET_FIELDS.items():
        cands = [c for c in cf_by_title.get(title, []) if "Link" not in c.get("type", "")]
        if cands:
            wanted[col] = cands[0]
    statuses = {s["id"]: s["name"] for w in get("/workflows")["data"] for s in w.get("customStatuses", [])}
    item_types = {}
    for path in ("/custom_item_types", "/customitemtypes"):
        try:
            item_types = {t["id"]: plain_type(t["title"]) for t in get(path).get("data", [])}
            break
        except SystemExit:
            continue
    contacts = {c["id"]: c for c in get("/contacts", deleted="true")["data"]}

    def person(uid):
        c = contacts.get(uid)
        if not c:
            return uid
        name = f"{c.get('firstName', '')} {c.get('lastName', '')}".strip()
        return name + (" (inactive)" if c.get("deleted") else "")

    # Folders and projects in the space, with full detail
    tree = paged(f"/spaces/{space['id']}/folders", descendants="true")
    folders = {f["id"]: f for f in batched("/folders/{}", [f["id"] for f in tree], fields=["customItemTypeId"])}
    parents = collections.defaultdict(list)
    for f in folders.values():
        for c in f.get("childIds", []):
            parents[c].append(f["id"])
        for p in f.get("parentIds", []):
            if p not in parents[f["id"]]:
                parents[f["id"]].append(p)

    def cfval(f, col):
        c = wanted.get(col)
        if not c:
            return ""
        for v in f.get("customFields", []):
            if v["id"] == c["id"]:
                val = v.get("value", "")
                if col in ("engagement_lead", "delivery_lead") and val:
                    ids = json.loads(val) if val.startswith("[") else [x.strip() for x in val.split(",")]
                    return ", ".join(person(i) for i in ids if i)
                return val
        return ""

    def ftype(f):
        t = item_types.get(f.get("customItemTypeId"))
        if t:
            return t
        if not f.get("project"):
            return "Folder"
        if cfval(f, "po_type") or cfval(f, "budget_eur"):
            return "PO"
        if "business development" in f["title"].lower():
            return "Business Development (non billable)"
        kids = [folders[c] for c in f.get("childIds", []) if c in folders]
        if kids and any(k.get("project") for k in kids) and not any(folders.get(p, {}).get("project") for p in parents[f["id"]]):
            return "Account"
        if any(ftype_cache.get(p) == "PO" for p in parents[f["id"]]):
            return "Use Case or Sub Project"
        return "PO"

    ftype_cache = {}
    for fid in folders:
        ftype_cache[fid] = None
    for _ in range(2):
        for fid, f in folders.items():
            ftype_cache[fid] = ftype(f)

    accounts = {fid: f for fid, f in folders.items() if ftype_cache[fid] == "Account"}
    acc_names = [(fid, clean(f["title"]) or f["title"]) for fid, f in accounts.items()]

    def guess(text):
        if not text:
            return None
        s = text.lower()
        best = max((n for _, n in acc_names if len(n) >= 3 and n.lower() in s), key=len, default=None)
        if best:
            return best
        return next((v for k, v in ALIAS.items() if k in s), None)

    def chain(fid):
        seen, q, first = set(), [[fid]], None
        while q:
            path = q.pop(0); cur = path[-1]
            if cur in seen or cur not in folders:
                continue
            seen.add(cur); first = first or path
            if ftype_cache[cur] == "Account":
                return path
            q += [path + [p] for p in parents[cur]]
        return first or [fid]

    # Time logs, month by month
    logs = []
    m = dt.date.fromisoformat(START)
    end = (today.replace(day=1) + dt.timedelta(days=95)).replace(day=1)
    while m < end:
        nxt = (m + dt.timedelta(days=32)).replace(day=1)
        logs += get("/timelogs", trackedDate={"start": m.isoformat(), "end": (nxt - dt.timedelta(days=1)).isoformat()}).get("data", [])
        m = nxt
    print(f"{len(logs)} time logs fetched")
    tasks = {t["id"]: t for t in batched("/tasks/{}", {l["taskId"] for l in logs if l.get("taskId")})}

    projects, info = {}, {}

    def classify(task):
        cands = [p for p in task.get("parentIds", []) + task.get("superParentIds", []) if p in folders]
        if not cands:
            return None
        paths = [chain(c) for c in cands]
        path = next((p for p in paths if ftype_cache.get(p[-1]) == "Account"), paths[0])
        ck = tuple(path)
        if ck in info:
            return info[ck]
        fs = [folders[i] for i in path if i in folders]
        acc = next((f for f in fs if ftype_cache[f["id"]] == "Account"), None)
        po = next((f for f in fs if ftype_cache[f["id"]] in PROJECT_TYPES), None)
        uc = next((f for f in fs if ftype_cache[f["id"]] == "Use Case or Sub Project"), None)
        acc_name = (clean(acc["title"]) if acc else None) or guess(fs[0]["title"]) or guess(task.get("title"))
        if po:
            pid, pname = po["id"], clean(po["title"]) or "(archived item, title overwritten)"
            if pid not in projects:
                projects[pid] = {
                    "po_id": pid, "project": pname, "account": acc_name or "Unassigned", "acc_id": acc["id"] if acc else None,
                    "item_type": ftype_cache[pid], "status": statuses.get((po.get("project") or {}).get("customStatusId"), ""),
                    **{c: cfval(po, c) for c in BUDGET_FIELDS if c != "region"},
                    "start": (po.get("project") or {}).get("startDate", "")[:10], "due": (po.get("project") or {}).get("endDate", "")[:10],
                    "wrike_link": po.get("permalink", ""),
                }
        else:
            pid = "nopo-" + (acc_name or "unassigned")
            pname = "Other / archived work (no PO)" if acc_name else "Unassigned (archived items)"
            projects.setdefault(pid, {"po_id": pid, "project": pname, "account": acc_name or "Unassigned", "acc_id": acc["id"] if acc else None,
                                      "item_type": "No PO", "status": "", **{c: "" for c in BUDGET_FIELDS if c != "region"},
                                      "start": "", "due": "", "wrike_link": ""})
        if uc and (not po or fs.index(uc) < fs.index(po)):
            ucn = clean(uc["title"]) or "(archived use case)"
        elif po and fs[0]["id"] != po["id"] and ftype_cache[fs[0]["id"]] not in ("Folder",):
            ucn = clean(fs[0]["title"]) or "(archived item)"
        else:
            ucn = "(PO-level work)"
        info[ck] = (pid, ucn)
        return info[ck]

    M, T, W = collections.Counter(), collections.Counter(), collections.Counter()
    week0 = today - dt.timedelta(days=today.weekday()) - dt.timedelta(weeks=12)
    kept = 0
    for l in logs:
        t = tasks.get(l.get("taskId"))
        if not t:
            continue
        c = classify(t)
        if not c:
            continue  # task outside the Account Management space
        kept += 1
        pid, ucn = c
        who = person(l.get("userId"))
        d = dt.date.fromisoformat(l["trackedDate"][:10])
        month = d.strftime("%Y-%m")
        bill = "Billable" if l.get("billingType") == "Billable" else "Non-billable"
        h = float(l.get("hours", 0))
        title = t.get("title", "")
        title = "(archived task)" if clean(title) is None else title
        M[(pid, ucn, who, month, bill)] += h
        T[(pid, ucn, title, who, month)] += h
        if d >= week0:
            W[(pid, who, (d - dt.timedelta(days=d.weekday())).isoformat())] += h
    print(f"{kept} time logs in '{SPACE_TITLE}', {sum(M.values()):,.1f} hours")
    if kept == 0:
        raise SystemExit("No time logs matched the space; refusing to publish an empty dashboard.")

    # Account names and regions
    best = {}
    for p in projects.values():
        acc = accounts.get(p["acc_id"]) if p["acc_id"] else None
        reg = cfval(acc, "region") if acc else ""
        k = key(p["account"])
        if k not in best or (reg and not best[k][1]):
            best[k] = (p["account"], reg)
    norm = {"Nord": "Nordics", "Nordix": "Nordics"}
    for p in projects.values():
        k = key(p["account"])
        p["account"] = DISPLAY.get(k, best[k][0])
        p["region"] = "Unknown" if p["account"] == "Unassigned" else (norm.get(best[k][1], best[k][1]) or "Not set")

    write = lambda name, header, rows: csv.writer(open(OUT / name, "w", newline="", encoding="utf-8")).writerows([header, *rows])
    cols = ["po_id", "project", "account", "region", "item_type", "status", "budget_eur", "current_budget_eur", "budget_pd",
            "budget_hours", "avg_rate_eur_per_pd", "po_type", "engagement_lead", "delivery_lead", "start", "due", "wrike_link"]
    write("projects.csv", cols, [[p.get(c, "") for c in cols] for p in projects.values()])
    write("timelog_monthly.csv", ["po_id", "use_case", "person", "month", "billable", "hours"], [[*k, round(v, 2)] for k, v in M.items()])
    write("timelog_tasks.csv", ["po_id", "use_case", "task", "person", "month", "hours"], [[*k, round(v, 2)] for k, v in T.items()])
    write("timelog_weekly.csv", ["po_id", "person", "week", "hours"], [[*k, round(v, 2)] for k, v in W.items()])
    months = sorted({k[3] for k in M})
    cal = []
    for mo in months:
        y, mm = map(int, mo.split("-")); d = dt.date(y, mm, 1); n = 0
        while d.month == mm:
            n += d.weekday() < 5 and d <= today; d += dt.timedelta(days=1)
        cal.append([mo, n, n * 8])
    write("calendar.csv", ["month", "working_days", "capacity_hours"], cal)
    print(f"Wrote {len(projects)} projects, {len(M)} monthly rows to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
