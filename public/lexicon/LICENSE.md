# Lexicon data license

The `*.json` files in this directory are derived from English Wiktionary's Latin
entries, via the machine-readable extract published by kaikki.org
(https://kaikki.org/dictionary/Latin/), and are ordered using lemma ranks from the
Dickinson College Commentaries Latin Core Vocabulary
(https://dcc.dickinson.edu/latin-core-list1).

- Wiktionary content: Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)
  and GFDL. https://en.wiktionary.org/wiki/Wiktionary:Copyrights
- DCC Latin Core Vocabulary: Creative Commons Attribution-ShareAlike (CC BY-SA),
  Dickinson College Commentaries.

These data files, and the derived test fixture `test/fixtures/wiktionary-classical-ipa.json`
(Wiktionary's Classical Latin IPA transcriptions), are therefore distributed under CC BY-SA 4.0. The code in this
repository is MIT-licensed (see /LICENSE); that license does not apply to these files.

Regenerate with `npm run build:lexicon`.
