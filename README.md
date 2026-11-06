# Latin for Suno

Converts Latin into spellings that push Suno toward reconstructed **Classical Latin**
pronunciation (educated speech of the early to mid 1st century BC), and translates
between English and Latin.

Live: https://latin-suno.reloru.workers.dev

## What it does

One parse per word (vowel length, consonantal *i*/*u*, diphthongs, syllables, stress),
rendered four ways:

| Output | Example (*Iterum atque nōn iterum*) | Use |
| --- | --- | --- |
| Suno Latin | `Iterūm atque nōn iterūm` | Latin spelling; macrons kept, misread letters fixed |
| Lyric respelling | `Iteroom ahtkweh nōn iteroom` | English-style whole words |
| Stressed respelling | `IH-teh-room AHT-kweh nōn IH-teh-room` | Syllables, stress in capitals (toggleable) |
| IPA | `ˈɪ.tɛ.rũː ˈat.kʷɛ ˈnoːn ˈɪ.tɛ.rũː` | Reference transcription |

The phonology follows W. S. Allen, *Vox Latina* (2nd ed., 1978): *c* = [k], *v* = [w],
*ae* = [ae̯], *qu* = [kʷ], *gn* = [ŋn], *b* before *s*/*t* = [p], long nasal vowels before
*ns*/*nf*, accent by the penultimate law with enclitic and apocope exceptions. No
Ecclesiastical, Vulgar or Medieval values are used.

The Suno-specific spellings (short *u* written *ū* so *sum* is not sung "suhm", *c* always
written *k*, and so on) are **heuristics drawn from observed Suno behaviour**, not from Suno
documentation. Expect to tune them as more lines are tested. Known history: final *-ck*
(*Hīck*) worked on an older Suno model but was sung "heeks" on later ones, and *rec-* was
read as the English prefix "ree-"; plain *k* fixed both.

### Vowel length

Unmarked words get their vowel lengths from a lexicon of about one million Latin word forms
extracted from English Wiktionary. When one spelling has several readings, the reading
whose lemma ranks highest in the Dickinson College Commentaries Latin Core Vocabulary
becomes the default and the others are offered in the UI. Typed macrons are always trusted
(a breve marks a vowel as deliberately short). Translator output runs in a *verify* mode
that accepts a macron only when the dictionary has that reading.

IPA output is checked against Wiktionary's own Classical Latin transcriptions for 1,654
lemmas (`test/fixtures`): 93% match exactly and 98.9% agree on stress and syllable count.
Most of the remaining differences are transcription conventions (where *s* + consonant is
syllabified, optional *h*), not stress errors.

### Translator

`/api/translate` tries Claude (`claude-opus-5-5`) through Cloudflare AI Gateway with
Unified Billing, which charges Cloudflare credits and needs no Anthropic API key. If the
gateway has no credits, or Claude fails, it falls back to Workers AI
`@cf/zai-org/glm-5.3`. The response says which model answered.

Translation providers are tried in this order:

1. **VM bridge** (`bridge/`) — Relo's own machine runs the unmodified `claude` CLI on his
   Claude subscription, reached over Cloudflare Tunnel. Best Latin, about 7-15 seconds.
2. **Claude via AI Gateway** — spends Cloudflare Unified Billing credits.
3. **Workers AI `@cf/zai-org/glm-5.3`** — free, and noticeably weaker at Latin.

The first two spend Relo's own resources, so both are locked to requests carrying the
Worker secret `CLAUDE_ACCESS_KEY` in an `x-access-key` header (entered once under
Translate → Claude access, stored only in that browser). Everyone else gets Workers AI.
Anthropic's policy permits an end user to run the unmodified binary on their own plan but
not to route other people's requests through it, so that gate is load-bearing — see
`bridge/README.md`.

## Home-screen app

The site is an installable web app (`public/manifest.webmanifest`, icons in `public/icons/`,
regenerated with `node scripts/make-icons.cjs`). On iPhone: Safari → Share → Add to Home
Screen. It opens full screen with no Safari bars; it does not work offline.

## API

- `GET /api/convert?text=Hīc+ego+sum` returns all outputs plus per-word analysis as JSON.
  Add `&format=text&output=lyric` (or `hybrid`, `respell`, `ipa`) for plain text, e.g. from
  iOS Shortcuts. The options `elision`, `shortU`, `lyricMacrons`, `stressCaps` and
  `ipaFinalM` are query parameters.
- `POST /api/translate` with `{"text", "direction": "en-la"|"la-en", "style": "lyrical"|"literal", "greek": bool}`.
- `POST /api/lookup` with `{"keys": [...]}` returns dictionary entries.
- `GET /api/health` returns the deployed commit and translator configuration.

## The VM bridge

`bridge/server.js` runs as the `claude-bridge` systemd service on the VM and exposes one
operation: translate. The spawned CLI has **every tool denied**, no MCP servers, no hooks,
an empty working directory and a 90-second timeout, because its input is text from the
internet. `bridge/README.md` has the install steps and the canary test to run after any
Claude Code upgrade.

## Run locally

```sh
npm ci
npm test
npx wrangler dev
```

`wrangler dev` needs Cloudflare credentials for the Workers AI binding. For the Claude path,
put `CLAUDE_GATEWAY_TOKEN` (an API token with only *AI Gateway Run*) and `CF_ACCOUNT_ID` in
`.dev.vars`, which git ignores.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`: tests, a dry-run deploy, then
`wrangler deploy` with the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, then
a check that `/api/health` on the live URL reports the new commit. Pull requests run the
tests and dry run only. The Worker secret `CLAUDE_GATEWAY_TOKEN` is set once with
`wrangler secret put` and persists across deploys.

## Rebuilding the lexicon

```sh
npm run build:lexicon
```

This streams the kaikki.org Wiktionary extract (about 1.25 GB, never stored) and rewrites
`public/lexicon/*.json` and the IPA test fixture. Shards are keyed by a three-letter prefix,
split further wherever a shard would exceed about 150 KB; `manifest.json` lists the split
prefixes. `node scripts/reshard.mjs` re-shards existing files without downloading.

## Licenses

Code: MIT (see `LICENSE`). Lexicon data in `public/lexicon/` and `data/`, and the test
fixture `test/fixtures/wiktionary-classical-ipa.json`: CC BY-SA 4.0, derived from Wiktionary
and the DCC Latin Core Vocabulary (see `public/lexicon/LICENSE.md`).
