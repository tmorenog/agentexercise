# Rebuilding the Word handout

`Meal Squad Exercise.docx` (in the folder above this one) is generated from the site and the slides. It doesn't update itself: after changing the site or the slides, rebuild it.

## What comes from where

| In the handout | Comes from | Updated by |
|---|---|---|
| Sample prompts | the recipes repo, `public/prompts/{scout,planner}/*.txt` | `build.py` (read fresh on every build) |
| Step titles, goals, *What you should see*, *Things you can try*, callouts, notes | the recipes repo, `public/scout.html` and `public/planner.html` | `extract_steps.py` → `steps.json` |
| Figures 1–6 (challenge, system, agent, MCP, data, Lovable) | the class slides | `screenshots.mjs --slides` → `img/crop-*.png` |
| Figures 7–10 (what each agent does) | the site's Scout, Pricer, Meal Planner and Shopper pages | `screenshots.mjs` → `img/flow-*.png` |
| Everything else: intro, Before You Start, When Something Goes Wrong, Glossary | written in `build.py` | edit `build.py` |
| Cover, headers, footers, styles | `template.docx`, the HBS exercise template | replace `template.docx` |

## Rebuild

You need Python 3 with `python-docx`, and the recipes repo checked out next to this one (`../recipes`), or set `RECIPES_REPO` to its path.

```bash
pip install python-docx
cd handout
python3 extract_steps.py   # only if a step's text changed on scout.html or planner.html
python3 build.py           # writes ../Meal Squad Exercise.docx
```

A prompt change needs only `python3 build.py`.

## Re-taking the figures (only if a slide or diagram changed)

Needs Node and Playwright with Chromium (`npm i playwright && npx playwright install chromium`).

```bash
node screenshots.mjs --slides <folder with the deck's slide .html files>   # slides and site diagrams
node screenshots.mjs                                                       # site diagrams only
```

- `--site <url>` photographs another copy of the site (default: the live site).
- The slide `.html` files come from the deck artifact's `slides/` folder. The crop of each slide is set in `SLIDES` at the top of the script.
- The fonts in `assets/fonts` (Bricolage Grotesque, Source Sans 3, JetBrains Mono, all SIL Open Font License) are used so the figures match the slides and site. `assets/lovable-dashboard.webp` is the Lovable screenshot used on the Lovable slide.

## Checking the result

Open the document in Word, or convert it to PDF with LibreOffice (`soffice --headless --convert-to pdf "Meal Squad Exercise.docx"`) and page through it. In LibreOffice the template's HBS fields show a stray "1 0" on the cover and "00" before the title in the headers. Word shows them correctly (select all and press F9 if not).
