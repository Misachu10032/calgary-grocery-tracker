"""Weekly job: collect prices from every source, export the site data, publish.

Usage:
    python scripts/run_weekly.py              # collect, export, git commit + push
    python scripts/run_weekly.py --no-push    # collect and export only
    python scripts/run_weekly.py --skip-tnt   # skip T&T (it opens a Chrome window)

Each collector runs on its own; one failing (e.g. a store blocking us) doesn't stop
the others. Pushing the updated web/data/site-data.json makes GitHub Pages rebuild the site
(.github/workflows/pages.yml).
"""
import argparse
import subprocess
import sys
from datetime import date

from db import ROOT
from export_site_data import OUT_PATH
from export_site_data import main as export_main

SCRIPTS = ROOT / "scripts"
COLLECTORS = [
    ("Flipp (flyers + Walmart online)", ["flipp_prices.py", "--quiet"]),
    ("Save-On-Foods website", ["saveon_prices.py"]),
    ("T&T website", ["tnt_prices.py", "--headed"]),
]


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True)


def publish():
    if git("rev-parse", "--is-inside-work-tree").returncode != 0:
        print("Not a git repository yet: skipped publishing. Set up the repo to auto-deploy.")
        return
    data_file = str(OUT_PATH.relative_to(ROOT))
    git("add", data_file)
    if git("diff", "--cached", "--quiet", "--", data_file).returncode == 0:
        print("Site data unchanged: nothing to publish.")
        return
    commit = git("commit", "-m", f"Weekly prices {date.today().isoformat()}", "--", data_file)
    print(commit.stdout.strip() or commit.stderr.strip())
    if not git("remote").stdout.strip():
        print("No git remote configured: committed locally, not pushed.")
        return
    push = git("push")
    print("Pushed: GitHub Pages will rebuild the site in a minute or two." if push.returncode == 0
          else f"Push failed: {push.stderr.strip()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-push", action="store_true", help="don't commit or push the exported data")
    parser.add_argument("--skip-tnt", action="store_true", help="skip the T&T collector")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    failures = []
    for label, command in COLLECTORS:
        if args.skip_tnt and command[0] == "tnt_prices.py":
            continue
        print(f"\n=== {label} ===", flush=True)
        result = subprocess.run([sys.executable, str(SCRIPTS / command[0]), *command[1:]], cwd=ROOT)
        if result.returncode != 0:
            failures.append(label)
            print(f"!! {label} failed (exit {result.returncode}); continuing.")

    print("\n=== Export site data ===")
    export_main()
    if not args.no_push:
        print("\n=== Publish ===")
        publish()
    if failures:
        print(f"\nDone with failures: {', '.join(failures)}")
        sys.exit(1)
    print("\nDone.")


if __name__ == "__main__":
    main()
