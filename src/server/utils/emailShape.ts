/** One definition of "looks like an email address" for the whole server:
 *  account email writes (researcherEmail.service) and notification recipient
 *  resolution (notification.service) must agree, or an address that is
 *  accepted on save silently gets no mail. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShaped(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length <= 254 && EMAIL_SHAPE.test(value);
}
