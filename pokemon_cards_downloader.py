#!/usr/bin/env python3
"""
PkmnCards Downloader
Downloads Pokémon TCG card images from pkmncards.com
"""

import os
import sys
import json
import time
import re
import requests
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from bs4 import BeautifulSoup

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL      = "https://pkmncards.com"
SETS_URL      = f"{BASE_URL}/sets/"
DOWNLOAD_DIR  = Path("pokemon_cards")
LOG_FILE      = DOWNLOAD_DIR / ".download_log.json"
DELAY         = 0.4          # seconds between requests (be polite)
DEFAULT_WORKERS = 4          # default parallel download threads
HEADERS       = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; PkmnCardsDownloader/1.0; "
        "personal use)"
    )
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def clear():
    os.system("cls" if os.name == "nt" else "clear")


def load_log() -> dict:
    if LOG_FILE.exists():
        try:
            return json.loads(LOG_FILE.read_text())
        except Exception:
            pass
    return {}          # {set_slug: {"done": bool, "count": int, "date": str}}


def sync_log_with_disk(log: dict) -> dict:
    """
    Walk every sub-folder of DOWNLOAD_DIR and make sure the log reflects
    what is actually on disk.  This lets the downloader pick up sets that
    were downloaded by a previous run (or whose log entry was lost) without
    re-downloading them.

    Rules
    -----
    * If a folder exists and has image files but no log entry  → add a
      tentative entry marked done=False (partial) so the user can see it
      and decide whether to top it up.
    * If a log entry says done=True but the folder is empty / gone  → reset
      to done=False so it will be re-downloaded.
    * If a log entry exists and the on-disk count matches log["total"]  →
      keep done=True (already verified).
    * Cards without the numeric prefix (old-style filenames) are still
      counted so we do not incorrectly flag a set as empty.
    """
    if not DOWNLOAD_DIR.exists():
        return log

    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

    for folder in sorted(DOWNLOAD_DIR.iterdir()):
        if not folder.is_dir() or folder.name.startswith("."):
            continue
        slug = folder.name
        on_disk = [
            f for f in folder.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS
        ]
        count_on_disk = len(on_disk)

        if slug not in log:
            # Unknown set on disk – register it as partial so it shows up
            if count_on_disk > 0:
                log[slug] = {
                    "name":   slug.replace("-", " ").title(),
                    "done":   False,
                    "count":  count_on_disk,
                    "total":  count_on_disk,   # real total unknown
                    "failed": [],
                    "date":   "detected from disk",
                }
        else:
            entry = log[slug]
            if entry.get("done") and count_on_disk == 0:
                # Log says done but folder is empty → needs re-download
                entry["done"] = False
                entry["count"] = 0
            elif not entry.get("done") and count_on_disk > 0:
                # Update count from disk in case previous run was interrupted
                entry["count"] = count_on_disk
                # If we now have as many as the known total, mark done
                if entry.get("total") and count_on_disk >= entry["total"]:
                    entry["done"] = True

    return log


def save_log(log: dict):
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOG_FILE.write_text(json.dumps(log, indent=2))


CARDS_JSON      = Path("cards.json")
CARDS_DATA_JS   = Path("cards_data.js")

# Matches filenames like:
#   001_Alakazam_-_Base_Set_(BS)_#1.jpg          (plain number)
#   H008_Forretress_-_Skyridge_(SK)_#H8.jpg      (letter-prefixed)
_FNAME_RE = re.compile(
    r"^([A-Z]*)(\d+)_(.+)\.(jpg|jpeg|png|webp|gif)$", re.IGNORECASE
)

def generate_cards_json():
    """
    Scan pokemon_cards/ and write:
      cards.json      — standard JSON for server-based use
      cards_data.js   — JS module (window.CARDS_DATA = {...}) so
                        index.html works when opened directly via
                        file:// without any web server.
    """
    result = {}
    if not DOWNLOAD_DIR.exists():
        return
    for d in sorted(DOWNLOAD_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        cards = []
        for f in sorted(d.iterdir()):
            if not f.is_file() or f.name.startswith("."):
                continue
            m = _FNAME_RE.match(f.name)
            if not m:
                continue
            letter  = m.group(1).upper()   # e.g. "H", "SH", or ""
            number  = int(m.group(2))       # numeric part
            rest    = m.group(3)            # everything after the prefix
            # Card name is the part before the first " - "
            card_name = rest.split(" - ")[0].replace("_", " ").strip()
            # Human-readable card number: "H8", "SH3", or plain "42"
            display_num = f"{letter}{number}" if letter else str(number)
            cards.append({
                "number":   display_num,
                "name":     card_name,
                "filename": f.name,
            })
        if cards:
            result[d.name] = cards

    payload = json.dumps(result, indent=2)
    CARDS_JSON.write_text(payload, encoding="utf-8")
    # Also write the JS shim so file:// loading works
    CARDS_DATA_JS.write_text(
        f"/* Auto-generated by pokemon_cards_downloader.py — do not edit */\n"
        f"window.CARDS_DATA = {payload};\n",
        encoding="utf-8",
    )
    print(f"  ✓  cards.json + cards_data.js updated ({len(result)} sets)")


def get_page(url: str) -> BeautifulSoup | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
        r.raise_for_status()
        return BeautifulSoup(r.text, "html.parser")
    except Exception as e:
        print(f"  ⚠  Could not fetch {url}: {e}")
        return None


def slugify(name: str) -> str:
    """Convert a set name to a safe folder name."""
    name = re.sub(r"[^\w\s-]", "", name).strip()
    return re.sub(r"[\s-]+", "_", name)


def ask_workers() -> int:
    """
    Prompt the user for a parallel worker count.
    Returns the chosen number (1 = sequential, like the old behaviour).
    """
    print()
    print(f"  ┌─ Parallel downloads ─────────────────────────────────┐")
    print(f"  │  How many simultaneous downloads?                    │")
    print(f"  │  1 = sequential  |  recommended: 4–8                 │")
    print(f"  │  (Press Enter for default: {DEFAULT_WORKERS})                        │")
    print(f"  └──────────────────────────────────────────────────────┘")
    raw = input("  Workers > ").strip()
    if raw == "":
        workers = DEFAULT_WORKERS
    elif raw.isdigit() and int(raw) >= 1:
        workers = int(raw)
    else:
        print(f"  ⚠  Invalid input, using default ({DEFAULT_WORKERS}).")
        workers = DEFAULT_WORKERS
    print(f"  → Using {workers} worker(s).\n")
    return workers


# ── Scraping ──────────────────────────────────────────────────────────────────

def fetch_sets() -> list[dict]:
    """
    Returns a list of dicts:
      {name, slug, url, series}
    """
    print("Fetching set list from pkmncards.com …")
    soup = get_page(SETS_URL)
    if soup is None:
        print("ERROR: could not load sets page.")
        sys.exit(1)

    sets = []
    # Each series is an <h2> followed by a <ul>
    content = soup.find("div", class_="entry-content")
    if content is None:
        print("ERROR: could not parse sets page.")
        sys.exit(1)

    current_series = "Unknown"
    seen_slugs = set()

    for tag in content.find_all(["h2", "li"]):
        if tag.name == "h2":
            current_series = tag.get_text(strip=True)
        elif tag.name == "li":
            a = tag.find("a")
            if a and "/set/" in a.get("href", ""):
                href = a["href"]
                # extract slug from URL like /set/base-set/
                m = re.search(r"/set/([^/]+)/", href)
                if m:
                    slug = m.group(1)
                    if slug in seen_slugs:
                        continue
                    seen_slugs.add(slug)
                    # name is the link text, strip the abbreviation in parens
                    name = re.sub(r"\s*\([^)]+\)\s*$", "", a.get_text(strip=True))
                    sets.append({
                        "name":   name,
                        "slug":   slug,
                        "url":    href if href.startswith("http") else BASE_URL + href,
                        "series": current_series,
                    })

    return sets


def fetch_card_images(set_url: str) -> list[dict]:
    """
    Returns list of {title, card_url, img_url} for every card in a set.
    Handles pagination automatically.
    """
    cards = []
    page_url = set_url
    page_num  = 1

    while page_url:
        soup = get_page(page_url)
        if soup is None:
            break

        articles = soup.find_all("article", class_="type-pkmn_card")
        for art in articles:
            a = art.find("a", class_="card-image-link")
            img = art.find("img", class_="card-image")
            if a and img:
                # Best quality: the largest srcset entry or src
                best_url = img.get("src", "")
                srcset = img.get("srcset", "")
                if srcset:
                    parts = [p.strip() for p in srcset.split(",")]
                    best_url = parts[-1].split()[0]   # last (largest) entry
                cards.append({
                    "title":    a.get("title", "unknown"),
                    "card_url": a["href"],
                    "img_url":  best_url,
                })

        # Check for next page
        next_link = soup.select_one("a.next.page-numbers, a[title='Next Page']")
        if next_link:
            page_url = next_link["href"]
            page_num += 1
            time.sleep(DELAY)
        else:
            break

    return cards


# ── Filename helpers ──────────────────────────────────────────────────────────

def extract_card_token(title: str) -> tuple:
    """
    Pull the card identifier from the LAST #<token> in the title.

    Handles both plain numbers and letter-prefixed variants:
      #1    -> ("",   1)
      #97   -> ("",  97)
      #H8   -> ("H",  8)
      #H32  -> ("H", 32)
      #SH3  -> ("SH", 3)

    Always uses the LAST occurrence so that cards whose names contain
    their own # (e.g. "Blaine's Quiz #1 - Gym Heroes #97") get the
    correct set card-number, which is always at the end of the title.

    Returns (letter_prefix, number) or (None, None) if no match.
    """
    matches = re.findall(r"#([A-Z]*)(\d+)", title)
    if not matches:
        return None, None
    letter, digits = matches[-1]
    return letter, int(digits)


def safe_filename(title: str, total: int) -> str:
    """
    Turn a card title into a safe filename with a sort-friendly prefix.

    Plain numbers:
      total=102, #1  ->  001_Alakazam_-_Base_Set_(BS)_#1.jpg
      total=102, #72 ->  072_Devolution_Spray_-_Base_Set_(BS)_#72.jpg

    Letter-prefixed numbers (holofoil, secret-rare, etc.):
      #H8   ->  H008_Forretress_-_Skyridge_(SK)_#H8.jpg
      #H32  ->  H032_Umbreon_-_Skyridge_(SK)_#H32.jpg
      #SH3  ->  SH003_...jpg

    The numeric part is always zero-padded to max(3, digits in total).
    The letter prefix, if any, is prepended as-is so like cards sort
    together (H001, H002 ... H032) after all plain-numbered cards.
    """
    letter, num = extract_card_token(title)
    pad = max(3, len(str(total)))

    # Build clean base name
    base = re.sub(r"[^\w\s·#()'-]", "", title)
    base = base.replace("·", "-").replace(" ", "_")
    base = re.sub(r"_+", "_", base).strip("_")

    if num is not None:
        prefix = f"{letter}{str(num).zfill(pad)}"
        return f"{prefix}_{base}.jpg"
    else:
        return "0" * pad + f"_{base}.jpg"


# ── Download ──────────────────────────────────────────────────────────────────

def download_image(img_url: str, dest: Path) -> bool:
    """Download a single image. Returns True on success."""
    if dest.exists():
        return True   # already have it
    try:
        r = requests.get(img_url, headers=HEADERS, timeout=30, stream=True)
        r.raise_for_status()
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"    ✗  {dest.name}: {e}")
        return False


def download_set(set_info: dict, log: dict, workers: int = 1) -> bool:
    """
    Download all cards for one set using `workers` parallel threads.
    Returns True if fully completed.
    """
    slug   = set_info["slug"]
    name   = set_info["name"]
    url    = set_info["url"]
    folder = DOWNLOAD_DIR / slug
    folder.mkdir(parents=True, exist_ok=True)

    print(f"\n{'═'*60}")
    print(f"  Downloading: {name}")
    print(f"  URL: {url}")
    print(f"  Saving to: {folder}")
    print(f"  Workers: {workers}")
    print(f"{'═'*60}")

    print("  Fetching card list …")
    cards = fetch_card_images(url)
    if not cards:
        print("  ⚠  No cards found – skipping.")
        return False

    total   = len(cards)
    success = 0
    failed  = []

    # Build (img_url, dest_path) pairs up-front so filenames are consistent
    tasks = [
        (card["img_url"], folder / safe_filename(card["title"], total), card["title"])
        for card in cards
    ]

    completed = 0
    bar_w = 30

    def _print_bar():
        done = int(bar_w * completed / total)
        bar  = "█" * done + "░" * (bar_w - done)
        pct  = 100 * completed // total
        print(f"\r  [{bar}] {pct:3d}%  {completed}/{total}", end="", flush=True)

    if workers == 1:
        # Sequential – original behaviour with per-card delay
        for img_url, dest, title in tasks:
            fname = dest.name
            ok = download_image(img_url, dest)
            completed += 1
            if ok:
                success += 1
            else:
                failed.append(title)
            _print_bar()
            time.sleep(DELAY)
    else:
        # Parallel – each thread handles its own request; light inter-submit delay
        # to avoid hammering the server all at once.
        import threading
        lock = threading.Lock()

        def _worker(args):
            img_url, dest, title = args
            ok = download_image(img_url, dest)
            return title, ok

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {}
            for i, task in enumerate(tasks):
                fut = pool.submit(_worker, task)
                futures[fut] = task
                # Stagger submissions slightly so we don't hammer the server
                time.sleep(DELAY / workers)

            for fut in as_completed(futures):
                title, ok = fut.result()
                with lock:
                    completed += 1
                    if ok:
                        success += 1
                    else:
                        failed.append(title)
                    _print_bar()

    print()   # newline after progress bar

    fully_done = len(failed) == 0
    log[slug] = {
        "name":    name,
        "done":    fully_done,
        "count":   success,
        "total":   total,
        "failed":  failed,
        "date":    datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    save_log(log)

    if fully_done:
        print(f"  ✓  Complete! Downloaded {success}/{total} cards.")
    else:
        print(f"  ⚠  Partial: {success}/{total} cards. Failed: {len(failed)}")

    generate_cards_json()
    return fully_done


# ── Raw keypress (cross-platform) ────────────────────────────────────────────

def _getch_unix():
    """Read a single keypress on Unix/macOS without requiring Enter."""
    import tty, termios
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.buffer.read(1)
        # Escape sequences (arrow keys) are 3 bytes: ESC [ A/B/C/D
        if ch == b"\x1b":
            ch2 = sys.stdin.buffer.read(1)
            if ch2 == b"[":
                ch3 = sys.stdin.buffer.read(1)
                return b"\x1b[" + ch3
            return b"\x1b"
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _getch_win():
    """Read a single keypress on Windows."""
    import msvcrt
    ch = msvcrt.getch()
    if ch in (b"\x00", b"\xe0"):          # special / arrow prefix
        ch2 = msvcrt.getch()
        return b"\x00" + ch2
    return ch


def getch():
    """Return a raw byte string for the next keypress."""
    if os.name == "nt":
        return _getch_win()
    return _getch_unix()


# Key constants
KEY_UP    = b"\x1b[A"
KEY_DOWN  = b"\x1b[B"
KEY_UP_W  = b"\x00H"   # Windows arrow up
KEY_DOWN_W= b"\x00P"   # Windows arrow down
KEY_SPACE = b" "
KEY_ENTER = b"\r"
KEY_ENTER2= b"\n"
KEY_q     = b"q"
KEY_Q     = b"Q"
KEY_a     = b"a"
KEY_A     = b"A"
KEY_r     = b"r"
KEY_R     = b"R"
KEY_n     = b"n"
KEY_N     = b"N"
KEY_p     = b"p"
KEY_P     = b"P"
KEY_ESC   = b"\x1b"


# ── UI ────────────────────────────────────────────────────────────────────────

PAGE_SIZE = 30   # rows of sets visible at once

def _set_status(s: dict, log: dict) -> tuple[str, str]:
    """Return (icon, status_text) for a set row."""
    entry = log.get(s["slug"])
    if entry and entry["done"]:
        return "✓", f"✓ {entry['count']} cards  {entry['date'][:10]}"
    elif entry and entry.get("count", 0) > 0:
        return "○", f"○ partial {entry['count']}/{entry.get('total','?')}"
    return " ", ""


def print_menu(
    sets: list[dict],
    log: dict,
    cursor: int,
    selected: set,
    page: int,
    message: str = "",
):
    """
    Render the interactive set browser.

    cursor   – index into `sets` of the highlighted row
    selected – set of slugs marked for download (shown with *)
    page     – current page (0-based)
    message  – one-line status / hint shown at the bottom
    """
    clear()
    total_sets  = len(sets)
    total_pages = max(1, (total_sets - 1) // PAGE_SIZE + 1)
    start       = page * PAGE_SIZE
    end         = min(start + PAGE_SIZE, total_sets)
    page_sets   = sets[start:end]

    done_count = sum(1 for s in sets if log.get(s["slug"], {}).get("done"))
    total_imgs = sum(e.get("count", 0) for e in log.values())
    sel_count  = len(selected)

    print("╔══════════════════════════════════════════════════════════════╗")
    print("║           PkmnCards Downloader  –  pkmncards.com            ║")
    print("╠══════════════════════════════════════════════════════════════╣")
    print(f"║  Sets completed: {done_count}/{total_sets:<4}   Images saved: {total_imgs:<6}             ║")
    sel_info = f"  Marked: {sel_count}" if sel_count else ""
    page_line = f"  Page {page+1}/{total_pages}  (sets {start+1}–{end} of {total_sets}){sel_info}"
    print(f"║{page_line:<62}║")
    print("╠══════════════════════════════════════════════════════════════╣")

    current_series = None
    for idx, s in enumerate(page_sets):
        global_idx = start + idx          # index in the full `sets` list
        is_cursor  = (global_idx == cursor)
        is_done    = log.get(s["slug"], {}).get("done", False)
        is_marked  = s["slug"] in selected

        if s["series"] != current_series:
            current_series = s["series"]
            print(f"║  ── {current_series:<56} ║")

        icon, status = _set_status(s, log)

        # Selection marker: * if marked, > if cursor, space otherwise
        if is_cursor and is_marked:
            left_marker = "►*"
        elif is_cursor:
            left_marker = "► "
        elif is_marked:
            left_marker = " *"
        else:
            left_marker = "  "

        num  = f"{global_idx+1:>3}."
        name = s["name"][:33]

        # Dim completed sets slightly using a bracket indicator
        done_tag = " [done]" if is_done else "       "
        row = f"║ {left_marker}{num} [{icon}] {name:<33}{done_tag} {status:<10} ║"
        print(row)

    print("╠══════════════════════════════════════════════════════════════╣")
    print("║  ↑↓ Move   Space Mark/Unmark   Enter Download marked        ║")
    print("║  a  Mark all incomplete   u  Unmark all   r  Refresh        ║")
    print("║  n/p Next/Prev page       q  Quit                           ║")
    print("╚══════════════════════════════════════════════════════════════╝")
    if message:
        print(f"  {message}")
    else:
        print()


def run_download_queue(queue: list[dict], log: dict, workers: int):
    """Download a list of sets in order, skipping already-complete ones."""
    pending = [s for s in queue if not log.get(s["slug"], {}).get("done")]
    skipped = len(queue) - len(pending)

    if skipped:
        print(f"\n  Skipping {skipped} already-completed set(s).")
    if not pending:
        print("  Nothing left to download.")
        input("  Press Enter to return to menu …")
        return

    print(f"\n  Downloading {len(pending)} set(s) …\n")
    overall_start = time.time()
    for idx, s in enumerate(pending, 1):
        print(f"\n[{idx}/{len(pending)}] ", end="")
        download_set(s, log, workers=workers)
    elapsed = time.time() - overall_start
    print(f"\n\n  All done in {elapsed/60:.1f} minutes.")
    input("  Press Enter to return to menu …")


def run():
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    log = load_log()

    print("Scanning local pokemon_cards/ folder …")
    log = sync_log_with_disk(log)
    save_log(log)

    print("Refreshing cards.json from existing files …")
    generate_cards_json()

    print("Fetching set list …")
    sets = fetch_sets()

    if not sets:
        print("Could not retrieve any sets. Check your internet connection.")
        sys.exit(1)

    cursor   = 0          # index into full sets list
    selected = set()      # slugs marked for download
    page     = 0
    message  = ""

    while True:
        total_pages = max(1, (len(sets) - 1) // PAGE_SIZE + 1)
        # Keep cursor on the current page
        page = cursor // PAGE_SIZE

        print_menu(sets, log, cursor, selected, page, message)
        message = ""

        key = getch()

        # ── Navigation ──────────────────────────────────────────────────────
        if key in (KEY_UP, KEY_UP_W):
            if cursor > 0:
                cursor -= 1

        elif key in (KEY_DOWN, KEY_DOWN_W):
            if cursor < len(sets) - 1:
                cursor += 1

        elif key in (KEY_n, KEY_N):
            if page < total_pages - 1:
                cursor = (page + 1) * PAGE_SIZE   # jump to top of next page

        elif key in (KEY_p, KEY_P):
            if page > 0:
                cursor = (page - 1) * PAGE_SIZE   # jump to top of prev page

        # ── Selection ───────────────────────────────────────────────────────
        elif key == KEY_SPACE:
            slug = sets[cursor]["slug"]
            is_done = log.get(slug, {}).get("done", False)
            if is_done:
                # Allow re-selecting a completed set but warn the user
                if slug in selected:
                    selected.discard(slug)
                    message = f"  Unmarked '{sets[cursor]['name']}' (already complete)."
                else:
                    selected.add(slug)
                    message = f"  * Marked '{sets[cursor]['name']}' — already complete, will re-download."
            else:
                if slug in selected:
                    selected.discard(slug)
                    message = f"  Unmarked '{sets[cursor]['name']}'."
                else:
                    selected.add(slug)
                    message = f"  * Marked '{sets[cursor]['name']}' for download."
            # Auto-advance cursor after marking
            if cursor < len(sets) - 1:
                cursor += 1

        elif key in (KEY_a, KEY_A):
            # Mark all incomplete sets
            newly = 0
            for s in sets:
                if not log.get(s["slug"], {}).get("done", False):
                    selected.add(s["slug"])
                    newly += 1
            message = f"  Marked {newly} incomplete set(s) for download."

        elif key == b"u" or key == b"U":
            count = len(selected)
            selected.clear()
            message = f"  Cleared {count} selection(s)."

        # ── Download marked ─────────────────────────────────────────────────
        elif key in (KEY_ENTER, KEY_ENTER2):
            if not selected:
                message = "  Nothing marked. Use Space to mark sets."
            else:
                queue   = [s for s in sets if s["slug"] in selected]
                workers = ask_workers()
                selected.clear()
                run_download_queue(queue, log, workers)

        # ── Misc ────────────────────────────────────────────────────────────
        elif key in (KEY_r, KEY_R):
            clear()
            print("Refreshing set list …")
            sets    = fetch_sets()
            log     = sync_log_with_disk(log)
            save_log(log)
            cursor  = 0
            message = "  Set list refreshed."

        elif key in (KEY_q, KEY_Q, KEY_ESC):
            clear()
            print("Bye!")
            break


if __name__ == "__main__":
    run()
