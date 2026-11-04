# CLAUDE.md

Latin → Suno phonetic engine plus an English/Latin translator, served by one Cloudflare
Worker (`latin-suno`) with static assets.

## Layout

- `public/js/engine.js`: the phonology engine (parse → syllables → stress → four
  renderers). Pure ES module, shared by the browser, the Worker and the tests. All
  Latin-phonology changes go here.
- `public/js/lexkey.js`: spelling normalization shared by the engine and the lexicon builder.
- `public/js/app.js`, `public/index.html`, `public/css/app.css`: the UI (no build step).
- `public/lexicon/*.json`: generated vowel-length lexicon (CC BY-SA), sharded by key prefix
  (`shardOf` + `manifest.json` splits; every shard ≤ 150 KB so the Worker's byte-capped
  cache stays small). Do not hand-edit; regenerate with `npm run build:lexicon`.
- `src/worker.js`: `/api/lookup`, `/api/convert`, `/api/translate`, `/api/health`; everything
  else is served from `public/`.
- `data/dcc-core-vocabulary.json`: lemma frequency ranks used to order ambiguous readings.
- `test/engine.test.js`: golden Suno outputs from the user's own Suno tests, phonology unit
  tests, and an accuracy gate against Wiktionary's Classical IPA (`test/fixtures`).

## Checks

```sh
npm test                      # node --test
npx wrangler deploy --dry-run # bundling + config validation
```

## Deploy

GitHub Actions (`.github/workflows/deploy.yml`) deploys on push to `main` and verifies that
`https://latin-suno.reloru.workers.dev/api/health` reports the pushed commit.
`CF_ACCOUNT_ID` and `COMMIT` are passed with `--var`; the secret `CLAUDE_GATEWAY_TOKEN` (API
token scoped to AI Gateway Run) and `CLAUDE_ACCESS_KEY` (gates the Claude path) live on
the Worker, not in the repo.

## Conventions

- Target pronunciation is Classical (1st century BC) per Allen, *Vox Latina*. Never add
  Ecclesiastical, Vulgar or Medieval values.
- The user's Suno-tested examples in the golden tests are ground truth for the Suno
  renderers. Change them only with new evidence from Suno.
- Suno spelling rules are heuristics; label them as such in docs and UI.
- Typed macrons are trusted; translator output is checked in `mode: "verify"`.
- Breves are an input-only marker for "deliberately short"; no output may contain one.
- Translator: Claude through AI Gateway Unified Billing first, Workers AI glm-5.3 as
  fallback. Never use a Claude subscription/OAuth token from Worker code.
