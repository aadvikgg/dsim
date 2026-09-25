import { useState, type FormEvent } from 'react';
import { clearAuthToken } from '../lib/authClient';
import { CODE_MAX, normalizeCode, verifyEmailCode } from '../lib/authFlows';

/**
 * The code from the verification email, and the button that spends it.
 *
 * Neon Auth sends a CODE, not a link (see `authFlows.ts`), so this is the one
 * place an address actually gets verified: the Profile banner, the dialog right
 * after sign-up, and `/account/verify` all render it.
 *
 * On success the cached JWT is dropped, for the reason `AccountVerify` gives: it
 * was minted before the address was verified and still says so, and it is the
 * token the server's gate reads. The session itself refreshes on its own —
 * the SDK's email-OTP client signals the session store on this route — which is
 * what makes the banner disappear.
 */
export function VerifyCodeForm({
  email,
  onVerified,
  id = 'ds-verify-code',
}: {
  email: string;
  onVerified?: () => void;
  /** the input's id; two forms can be on one screen (the banner and the dialog) */
  id?: string;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await verifyEmailCode(email, code);
    setBusy(false);
    if (r.ok) {
      clearAuthToken();
      onVerified?.();
    } else {
      setError(r.message);
    }
  };

  return (
    <form className="ds-verifycode" onSubmit={submit}>
      <label htmlFor={id} className="ds-sr">
        Verification code
      </label>
      <div className="ds-field-row">
        <input
          id={id}
          className="ds-input code grow"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Code"
          maxLength={CODE_MAX}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError('');
          }}
          aria-invalid={!!error}
          aria-describedby={`${id}-msg`}
        />
        <button
          className={`ds-btn primary${busy ? ' busy' : ''}`}
          type="submit"
          disabled={busy || !normalizeCode(code)}
          aria-busy={busy}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </div>
      <div id={`${id}-msg`} className={`ds-form-hint${error ? ' err' : ''}`} role="alert">
        {error}
      </div>
    </form>
  );
}
