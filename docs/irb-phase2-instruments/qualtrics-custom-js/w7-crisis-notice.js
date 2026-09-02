/* Qualtrics custom JS — attach to W7 ("Did anything about your conversations
 * ... bother you, upset you, or feel wrong this week?") on the weekly check-in
 * survey (Question behavior -> JavaScript). Same snippet works for the
 * week-12 F7 lasting-effects question.
 *
 * The moment a participant selects "Yes", an inline support-resources notice
 * appears — before they submit the page, and independent of the one-business-
 * day human review promised for the follow-up text question. Selecting "No"
 * hides it again. No styling framework assumptions; colors match the app's
 * amber notice pattern.
 */
Qualtrics.SurveyEngine.addOnload(function () {
  var q = this;
  var container = q.getQuestionContainer();

  var notice = document.createElement('div');
  notice.setAttribute('role', 'status');
  notice.style.cssText =
    'display:none;margin-top:12px;padding:10px 12px;border:1px solid #fcd34d;' +
    'background:#fffbeb;color:#92400e;border-radius:8px;font-size:0.9em;line-height:1.4;';
  notice.textContent =
    'Support is available right now if you need it: call or text 988 (Suicide and ' +
    'Crisis Lifeline), text HELLO to 741741 (Crisis Text Line), or call BYU CAPS at ' +
    '801-422-3035. You can also describe what happened on the next question — a member ' +
    'of the research team reviews those responses within one business day.';
  container.appendChild(notice);

  function refresh() {
    var yes = false;
    var radios = container.querySelectorAll('input[type=radio]');
    radios.forEach(function (r) {
      if (!r.checked) return;
      var label = container.querySelector('label[for="' + r.id + '"]');
      var text = (label ? label.textContent : '') || '';
      if (/yes/i.test(text)) yes = true;
    });
    notice.style.display = yes ? 'block' : 'none';
  }

  container.addEventListener('change', refresh);
  refresh(); // handles back-button revisits with Yes already selected
});
