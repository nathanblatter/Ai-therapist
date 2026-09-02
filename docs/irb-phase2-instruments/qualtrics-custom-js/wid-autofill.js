/* Qualtrics custom JS — attach to the WID (study ID) question of the weekly
 * check-in survey (Question behavior -> JavaScript). Pairs with a
 * "Set Embedded Data: sid (from URL)" element in the survey flow.
 *
 * The app (or the reminder email) links each participant to the survey as
 *   .../SV_xxx?sid=23
 * so the study ID fills itself, becomes read-only, and can't be mistyped —
 * the classic linkage failure in longitudinal survey data. With no sid in the
 * URL the question behaves exactly as before (manual entry).
 */
Qualtrics.SurveyEngine.addOnload(function () {
  var sid = '${e://Field/sid}';
  if (!/^\d{1,6}$/.test(sid)) return; // no/invalid sid: leave manual entry alone

  var container = this.getQuestionContainer();
  var input = container.querySelector('input[type=text], input:not([type]), textarea');
  if (!input) return;

  input.value = sid;
  input.readOnly = true;
  input.setAttribute('aria-readonly', 'true');
  input.style.background = '#f5f5f4';

  var note = document.createElement('div');
  note.style.cssText = 'margin-top:6px;font-size:0.8em;color:#57534e;';
  note.textContent = 'Filled in automatically from your personal survey link.';
  input.parentNode.appendChild(note);
});
