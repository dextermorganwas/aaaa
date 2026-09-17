# stremio-art-bridge

A self-hosted artwork resolver/proxy for Stremio's **AIOMetadata** add-on. It brings the
Plex/Jellyfin "pick your own poster from ThePosterDB" feeling to Stremio by giving AIOMetadata
one URL per art type; this app figures out (and caches) the actual image behind the scenes.

**Provider chain**

- **Poster:** ThePosterDB (English, Show Cover for series, Variation = Original) → TMDB (English)
  → TVDB (English) → TMDB (original language) → TVDB (original language) → Metahub → TMDB's
  primary poster → TVDB's primary image.
- **Backdrop:** TMDB (textless) → TVDB (textless) → Metahub → TMDB's primary backdrop → TVDB's
  primary image.
- **Logo:** same as poster, minus ThePosterDB (it doesn't host logos).

ThePosterDB results are cached **forever**. Everything else is cached for a configurable number
of days and re-checked afterwards. All resolved art is downloaded once and served from local
disk, not re-fetched from upstream on every request.

By default, no request ever waits on ThePosterDB — it's the slowest provider by a wide margin
(it has no API, so each candidate requires opening a couple of its actual web pages), so every
request falls straight through to TMDB/TVDB/Metahub while ThePosterDB is checked in the
background. If it finds a qualifying poster, it silently upgrades the cache so the *next*
request gets the ThePosterDB version. (You can opt into waiting on the first request instead via
`TPDB_INLINE_ENABLED=true` - see `.env.example`.)

A small admin dashboard (at `/admin`) lists every item that's ever been requested, shows what
art is currently being served for it, and lets you browse everything each provider has and
pick a different one, or paste in your own URL.

---

## 1. Configure AIOMetadata in Stremio

In AIOMetadata's configuration, set your custom art URLs to (replacing the domain with wherever
you deploy this):

```
Poster:   https://your-domain.example/poster/tmdb:{type}:{tmdb_id?}&imdb:{imdb_id?}&tvdb:{tvdb_id?}.jpg
Backdrop: https://your-domain.example/backdrop/tmdb:{type}:{tmdb_id?}&imdb:{imdb_id?}&tvdb:{tvdb_id?}.jpg
Logo:     https://your-domain.example/logo/tmdb:{type}:{tmdb_id?}&imdb:{imdb_id?}&tvdb:{tvdb_id?}.jpg
```

The trailing `?` on each id placeholder is required — it's what tells AIOMetadata to blank the
placeholder instead of dropping the whole URL when that particular ID isn't available for an
item. This app parses whichever IDs actually show up and resolves art from any combination of
them.

## 2. Get API keys

- **TMDB:** create a free account at themoviedb.org → Settings → API → request an API key
  (the "v3 auth" key is fine; either that or a v4 Read Access Token work — see `.env.example`).
- **TVDB:** create an account at thetvdb.com → Dashboard → API Keys. TVDB is optional — leave
  `TVDB_API_KEY` blank and the app will just skip every TVDB step in the chain.
- **ThePosterDB and Metahub** need no API key; both are used via their public pages.

## 3. Configure `.env`

Copy `.env.example` to `.env` and fill in your API keys. Every setting is commented — sizes,
cache lifetimes, timeouts, and concurrency (turn `MAX_CONCURRENT_FETCHES` down on something like
a Raspberry Pi, up on a beefier server).

## 4. Run it

```bash
docker compose up -d
```

The app listens on port 8990 by default (change with `PORT` in `.env` + the port mapping in
`docker-compose.yml`). Visit `http://your-server:8990/admin` for the dashboard.

All state (the SQLite database and every cached image) lives under `./data`, which is bind-mounted
so it survives container recreation/updates.

---

## Admin dashboard

- **Grid view** — every item ever requested, with a poster thumbnail and a badge per art type
  showing which provider it came from (green = auto-resolved, blue = manual override).
- **Search** — by title or by tmdb/imdb/tvdb id.
- **Item view** — for each of poster/backdrop/logo you can:
  - **Re-run chain** — clears the cached pick and resolves it fresh.
  - **Browse all options** — live-queries every provider and shows every candidate image side by
    side; click one to make it the override (cached forever, never auto-replaced).
  - **Remove override** — goes back to the automatic chain.

Set `ADMIN_USER`/`ADMIN_PASSWORD` in `.env` to put HTTP Basic Auth in front of `/admin` if this
box is reachable from the internet.

---

## Upgrading an existing deployment

**Latest fix:** the `Language:`/`Type:`/`Variation:` fields on a poster's detail page render as
three separate lines, not one line joined by a separator - an earlier version of this scraper
assumed a separator that doesn't exist, so it found real candidates but could never confirm
their language/variation and rejected all of them. Verified directly against live pages this
time (not inferred) and rewritten to match the real structure. The poster's caption is now also
read from the page's own `<title>` tag (`"{Caption} Poster | TPDb"`), which is far more reliable
than the previous body-text approach.

Earlier fix in this same update: ThePosterDB sits behind Cloudflare, which was silently
blocking/degrading requests from this app's plain custom User-Agent. Every request now presents
as a real browser (matching what the reference community scrapers do). It also reads candidate
posters directly off the disambiguation page (which already lists exactly one - the "Cover" -
entry per uploader by default, confirmed by fetching it directly) instead of opening each
`/set/{id}` page separately.

This also changes the database schema (adds a `reason` column and a couple of new tables) and
migrates your existing `./data/db` in place automatically on startup - no manual steps needed,
just pull the new image and restart:

```bash
docker compose pull && docker compose up -d
```

If you want previously "not found" items to be retried with the fixed scraper right away rather
than waiting out the `TPDB_NEGATIVE_CACHE_DAYS` cooldown, use "Re-run chain" on those items in the
admin dashboard (or wait - the cooldown is only a few days).

**Other behavior changes worth knowing about:**

- **ThePosterDB is now skipped inline by default** (`TPDB_INLINE_ENABLED=false`). Every request
  gets an immediate answer from TMDB/TVDB/Metahub while ThePosterDB is checked in the background;
  if it finds a qualifying poster, it silently upgrades the cache for next time. Set
  `TPDB_INLINE_ENABLED=true` if you'd rather the *first* request for an item wait up to
  `TPDB_TIMEOUT_MS` for ThePosterDB before falling through.
- **ThePosterDB candidates are now evaluated in parallel**, not one at a time.
- A scraping failure (couldn't parse the page at all) is now distinguished from a genuine
  "ThePosterDB has nothing for this title" - only the latter gets the multi-day negative cache;
  a parsing failure backs off for just `TPDB_ERROR_BACKOFF_MINUTES` and logs a **warning** (not
  just a debug line) so a real breakage is visible in your logs instead of looking like a clean
  miss.
- A general negative cache (`NEGATIVE_CACHE_TTL_HOURS`, default 12) now covers "nothing was found
  anywhere for this item" so a bad/mismatched id doesn't hit every provider on every request.
- Replacing an item's art (auto re-resolution, an admin override, or a background ThePosterDB
  upgrade) now deletes the old cached file instead of leaving it orphaned on disk.
- The admin dashboard's "Re-run chain" button no longer clears the existing art before trying
  again - if the fresh attempt fails, the item keeps showing its previous art instead of going
  blank.
- Each resolved art entry now records *why* it was picked (which chain step matched), shown as
  "Why:" in the admin dashboard.
- **"Browse all options" now defaults to only what the real chain would actually pick from**
  (English/original-language posters, textless backdrops, English/original-language logos, plus
  ThePosterDB and Metahub which are chain-relevant by construction) - with a "Show N more
  options" button per art type to reveal everything else (other languages, non-textless
  backdrops) for manual picking.

## Troubleshooting

- **`EACCES: permission denied, mkdir '/data/db'`** — the container fixes ownership of the
  bind-mounted `./data` folder itself on startup (via `PUID`/`PGID` in `.env`, default
  `1000:1000`), so this shouldn't happen on a fresh `./data` folder. If you hit it anyway (e.g.
  you're re-using a `./data` folder from before this fix, or you set a custom `user:` in
  compose), run `sudo chown -R 1000:1000 ./data` on the host once (or match `PUID`/`PGID` to
  whatever `./data` is currently owned by), then `docker compose up -d` again.

## Notes, limitations & things worth knowing

- **ThePosterDB has no official API.** This app scrapes its public pages the same way community
  tools like `artwork-uploader-plex` do (searches `/search`, walks `/posters/{id}` →
  `/set/{id}` → `/poster/{id}` to read the Language/Variation metadata). If TPDB changes its
  HTML, `src/providers/theposterdb.js` is the file to fix — it already has a regex fallback for
  each scraping step, but a big redesign on their end could still break it.
- **TVDB artwork type IDs** are looked up dynamically via TVDB's `/artwork/types` endpoint
  (matched by slug: `poster`, `background`/`fanart`, `clearlogo`/`logo`) rather than hardcoded,
  since those numeric IDs aren't guaranteed stable across movie/series records.
- **TVDB extended records:** the app reads the `artworks` array straight off
  `GET /movies/{id}/extended` / `GET /series/{id}/extended`. If TVDB ever stops including that
  array by default for your API key tier, `src/providers/tvdb.js`'s `getExtended()` is the one
  line to adjust (e.g. add a `?meta=` query param) — everything downstream already just consumes
  whatever ends up in `extended.artworks`.
- **TVDB matching currently requires an IMDb id** (it resolves a TVDB id via
  `/search/remoteid/{imdbId}` when you don't already have one cached). If AIOMetadata sends you
  a tvdb id directly, that's used as-is and this doesn't matter.
- **Metahub** only has one image per art type (no language choice), and is IMDb-id only — items
  with no IMDb id skip that step.
- **Concurrency / dedupe:** simultaneous requests for the same item+art-type are coalesced into a
  single in-flight resolution (`src/lib/singleflight.js`) rather than triggering redundant
  provider calls.
- **Graceful shutdown:** `SIGTERM`/`SIGINT` stop accepting new connections, let in-flight
  requests finish (up to 15s), then exit — Docker's default `docker stop` behaviour works as
  expected.
- If literally nothing is found anywhere, the app 302-redirects to the placeholder URLs you set
  in `.env` (recommended, so Stremio never shows a broken-image icon) or returns a 404 if you
  leave those blank.

---

## 5. Publish this to GitHub + GHCR (complete walkthrough)

This section assumes you've never used Git before. You have GitHub Desktop installed, which is
genuinely the easier path here — you won't need the command line for any of this.

### 5.1 Create the GitHub repository

1. Go to https://github.com and sign in (create a free account first if you don't have one).
2. Click the **+** icon top-right → **New repository**.
3. Name it something like `stremio-art-bridge`. Choose **Public** or **Private** (both work
   fine with GHCR — see the note about package visibility in step 5.5). Don't check "Add a
   README" — you already have one. Click **Create repository**.
4. GitHub will show you an empty repo with a URL like
   `https://github.com/YOUR_USERNAME/stremio-art-bridge`. Keep this tab open.

### 5.2 Put this project's files on your computer

Take everything in the project folder you downloaded from this chat and put it in a folder on
your Windows machine, e.g. `C:\Users\you\stremio-art-bridge`. Make sure the folder directly
contains `package.json`, `Dockerfile`, `server.js`, etc. — not a subfolder.

### 5.3 Connect GitHub Desktop to that folder and the repo

1. Open **GitHub Desktop**. Sign in with your GitHub account if you haven't (`File` → `Options`
   → `Accounts` → `Sign in`).
2. `File` → **Add local repository...**
3. Browse to your `stremio-art-bridge` folder and select it. GitHub Desktop will say "This
   directory does not appear to be a Git repository" with a link that says **create a
   repository**. Click that link.
4. In the dialog that appears, the name should already match your folder. Leave everything else
   default and click **Create Repository**. GitHub Desktop has now turned that folder into a Git
   repo on your computer (this is completely local so far — nothing is on GitHub yet).
5. You'll now see the main GitHub Desktop window with a list of "Changes" on the left (all your
   project files, shown as new/added) and a diff view on the right. At the bottom-left, type a
   commit message, e.g. `Initial commit`, and click **Commit to main**.
6. At the top of the window, click **Publish repository**.
7. A dialog appears with the repo name pre-filled. **Important:** uncheck "Keep this code
   private" only if you actually want it public — either is fine. If you already created the
   repo on GitHub.com in step 5.1, instead of "Publish repository" you may see a prompt to
   choose an existing remote — pick the `stremio-art-bridge` repo you created. If GitHub Desktop
   instead tries to create a *second* new repo with the same name, that's fine too — just publish
   it, then on GitHub.com delete whichever of the two ends up empty/duplicate, or simplest: skip
   creating the repo manually on GitHub.com in step 5.1 and just let "Publish repository" create
   it for you here in one click.
8. Click **Publish repository**. GitHub Desktop uploads everything. Refresh the GitHub.com tab —
   your files are now there.

From now on, whenever you change a file locally: GitHub Desktop's "Changes" tab shows what
changed → type a commit message → **Commit to main** → **Push origin** (top of the window). That
last step, "Push", is what actually uploads your commit to GitHub.

### 5.4 Let GitHub Actions build and publish the Docker image

The workflow file at `.github/workflows/docker-publish.yml` is already in your repo (you just
pushed it). It needs **no configuration or secrets** — GitHub automatically provides a
`GITHUB_TOKEN` with permission to publish packages under your own account, which the workflow
uses to log in to GHCR.

It runs automatically:
- every time you push to the `main` branch (which you just did in step 5.3 — go check!)
- every time you push a version tag like `v1.0.0`
- or manually: on GitHub.com, go to your repo → **Actions** tab → click the workflow name on the
  left → **Run workflow** button → **Run workflow**.

To watch it work: on GitHub.com, open your repo → **Actions** tab. Click the running workflow to
see live logs. The first run takes a few minutes (it builds for both Intel/AMD and ARM). A green
checkmark means your image is now published.

### 5.5 Make the package pullable

1. On GitHub.com, go to your repo's main page. In the right sidebar you should see a
   **Packages** section with your image listed once the first workflow run finishes — click it.
2. On the package page, click **Package settings** (gear icon, or via the "..." menu).
3. If your repo is private, or if you just want to be able to `docker pull` without logging in,
   scroll to **Danger Zone** → **Change visibility** → set to **Public**. (If you're fine with
   authenticating Docker to GHCR on your server instead, you can skip this and use
   `docker login ghcr.io` there with a
   [Personal Access Token](https://github.com/settings/tokens) that has `read:packages` scope.)
4. While you're on the package settings page, under **Manage Actions access**, confirm your repo
   is listed (it should be automatically) so future pushes keep permission to publish new
   versions.

### 5.6 Deploy on your Docker server

On your Linux server:

```bash
mkdir -p ~/stremio-art-bridge && cd ~/stremio-art-bridge
# Grab just the two files you need to run the published image (or copy your whole repo, either works):
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/stremio-art-bridge/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/stremio-art-bridge/main/.env.example
mv .env.example .env
nano .env   # fill in your TMDB/TVDB keys etc.
```

Edit `docker-compose.yml`:
- Replace `YOUR_GITHUB_USERNAME` in the `image:` line with your actual GitHub username (all
  lowercase — GHCR requires lowercase image names).
- Delete or comment out the `build: .` line now that you're pulling a pre-built image.

Then:

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

Visit `http://your-server-ip:8990/admin` to confirm it's running, then point AIOMetadata at
`http://your-server-ip:8990/poster/...` etc. (or a domain/reverse-proxy in front of it).

### 5.7 Updating later

Whenever you (or I, in a future chat) change the code: commit + push in GitHub Desktop as in
5.3 → Actions rebuilds and republishes the `latest` tag automatically → on your server, just run
`docker compose pull && docker compose up -d` again to pick up the new image.

---

## Project layout

```
server.js                     Express bootstrap, graceful shutdown
src/config.js                 All environment variables, in one place
src/db.js                     SQLite schema + queries (media, art, tpdb match cache, request log)
src/lib/                      httpClient (timeouts+concurrency), singleflight, disk cache,
                               id-string parsing, ISO language code mapping
src/providers/                One file per art source: tmdb.js, tvdb.js, theposterdb.js, metahub.js
src/resolvers/resolveArt.js   The actual fallback-chain logic per your spec, per art type
src/resolvers/browseOptions.js  Live "show me everything" lookup for the admin UI
src/jobs/backgroundQueue.js    Concurrency-capped queue for post-response background work
src/routes/artRoutes.js       GET /poster|backdrop|logo/* - what AIOMetadata calls
src/routes/adminApi.js        JSON API behind /admin
public/admin/                 The dashboard itself (plain HTML/CSS/JS, no build step)
```
