# Qualtrics survey skin (BYU-branded)

`byu_skin.css` is the shared custom CSS applied (2026-09-09, via the survey-definitions
API `PUT /options` -> `CustomStyles.customCSS`) to all five Phase 2 surveys:
baseline SV_aW32vA2r2yHrpI2, weekly SV_emV8ohMB6FujVLU, exit SV_cZPBcn5vOkfXOCi,
week12 SV_6QIBQHIbJeGgR70, withdrawal SV_esmJYmrhsHOayWy.

Design: BYU navy (#002E5D) gradient page, white content card, royal (#0047BA)
actions/accents, lightBlue (#BDD6E6) matrix striping and rules, and the participant
app's monospace voice (Consolas) for the header wordmark, progress text, scale
anchors, crisis callouts, and the WAI-SR attribution footnote. Selectors target the
JFE6 renderer (#page, section#contents, .matrix-*, #next-button) plus its theme CSS
variables (--mixes-primary-*, --background-color).

Each survey also gets a per-survey `Header` HTML block (ws-head wordmark + title)
and `ProgressBarDisplay: Text`. Intro DB questions have their crisis-resource
sentences wrapped in `<div class="ws-crisis">` (wording unchanged - visual only,
so the IRB instrument docx files are unaffected).

Re-apply after any survey rebuild: PUT the options payload with this file's
contents; question wording itself lives in the qualtrics_*.txt import files.
