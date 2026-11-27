import { LogIn, UserX } from 'react-feather';
import type { AccountSignedOutNotice } from '../lib/accountSignedOut';

/**
 * Shown over everything when the study team changed or removed this account
 * while the page was open: the server has already signed the account out and
 * ended any session, so nothing underneath works any more. Says why, and
 * offers the way back to sign-in.
 *
 * It covers whatever was on the page, a crisis-resources screen included, and
 * a session may have been cut short. So it always names 988 and 911 itself,
 * whether or not the study has a crisis line configured.
 */
/** The study's own line, unless it is missing or is one of the two always shown. */
export function studyCrisisLine(
  crisisLine: { hotline: string; phone: string } | null | undefined,
): { hotline: string; phone: string } | null {
  const phone = crisisLine?.phone?.trim() ?? '';
  const digits = phone.replace(/\D/g, '');
  if (!crisisLine || !digits || digits === '988' || digits === '911') return null;
  return { hotline: crisisLine.hotline?.trim() ?? '', phone };
}

export default function AccountSignedOutScreen({
  notice,
  crisisLine,
}: {
  notice: AccountSignedOutNotice;
  /** The study's crisis line (name and number), shown because a session may have been cut short. */
  crisisLine?: { hotline: string; phone: string } | null;
}) {
  const studyLine = studyCrisisLine(crisisLine);
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-gray-900/80 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="account-signed-out-title"
      aria-describedby="account-signed-out-message"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-700">
          <UserX size={24} aria-hidden="true" />
        </div>
        <h2 id="account-signed-out-title" className="text-lg font-semibold text-gray-900">
          You have been signed out
        </h2>
        <p id="account-signed-out-message" className="mt-2 text-sm text-gray-700">
          {notice.message}
        </p>
        <p className="mt-2 text-sm text-gray-600">If you have questions, contact the study team.</p>
        <p className="mt-2 text-sm text-gray-600" data-testid="signed-out-crisis-help">
          If you need support right now, call or text{' '}
          <a className="font-semibold underline" href="tel:988">
            988
          </a>{' '}
          (Suicide and Crisis Lifeline)
          {studyLine && (
            <>
              , or call{' '}
              <a className="font-semibold underline" href={`tel:${studyLine.phone}`}>
                {studyLine.phone}
              </a>
              {studyLine.hotline ? ` (${studyLine.hotline})` : ''}
            </>
          )}
          . In an emergency, call{' '}
          <a className="font-semibold underline" href="tel:911">
            911
          </a>
          .
        </p>
        <a
          href="/login"
          className="mt-5 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-royal px-5 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          <LogIn size={16} aria-hidden="true" />
          {notice.canSignIn ? 'Sign in again' : 'Go to the sign-in page'}
        </a>
      </div>
    </div>
  );
}
