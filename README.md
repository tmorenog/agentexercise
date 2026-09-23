# Costar Chain

A "six degrees of Kevin Bacon" engine for the whole [TMDB](https://www.themoviedb.org/) credit graph. Pick any two actors and it finds a chain of shared films connecting them, then lays the chain out as a filmstrip.

## Deploy to Vercel

The TMDB key stays on the server. The browser calls `/api/tmdb`, a Vercel function that adds the key and forwards the request to TMDB. The function only forwards the five endpoints the app uses.

1. Push this repo to GitHub.
2. In Vercel, click **Add New → Project** and import the repo. Leave **Framework Preset** as **Other** with no build command or output directory.
3. Under **Environment Variables**, add `TMDB_API_KEY` with your TMDB key, for Production and Preview.
4. Click **Deploy**.

If you add or change the variable after deploying, redeploy (**Deployments → ⋯ → Redeploy**) so the change takes effect.

## Run locally

```sh
npm i -g vercel
cp .env.example .env.local   # then put your key in it
vercel dev                   # http://localhost:3000
```

A plain static server or opening `index.html` directly won't work, because the page needs the `/api/tmdb` function.

Deep links: `/#from=31&to=1245` connects Tom Hanks to Scarlett Johansson.

## How the search works

The credit graph has two kinds of node: people and films. A person links to every film they have a cast credit in. `app.js` runs a **bidirectional breadth-first search** over that graph:

- The search runs outward from both actors at once. Each round it grows whichever side has the smaller frontier, which keeps the number of API calls far below a one-sided search.
- Each round expands only the 160 most prominent nodes on that side (films ranked by vote count, people by popularity). This keeps a search to a few hundred calls. The trade-off is that a chain through obscure titles can be missed.
- The chain is returned as soon as the two sides touch.
- Some credits would make trivial or meaningless links, so these are dropped: documentaries, "Self" / "Himself" / archive-footage credits, films with fewer than 25 votes, and cast billed below 25th.
- Requests run 10 at a time. Responses are cached in the browser and at Vercel's edge (a day for credits, an hour for search), and HTTP 429 (rate limited) responses are retried with backoff.

The limits (`MAX_DEGREES`, `LAYER_CAP`, `MIN_VOTES`, and so on) are constants at the top of `app.js`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Styles, with light and dark themes |
| `app.js` | TMDB client, the graph search, and the UI |
| `api/tmdb.js` | Vercel function that proxies TMDB and holds the key |
| `.env.example` | Template for the local `.env.local` |

This product uses the TMDB API but is not endorsed or certified by TMDB.
