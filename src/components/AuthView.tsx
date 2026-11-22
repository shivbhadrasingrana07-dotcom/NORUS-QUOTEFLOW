import { useEffect, useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { ArrowRight, CheckCircle2, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { auth, googleAuthProvider } from '../lib/firebase.ts';
import type { AuthStatePayload } from '../types.ts';

interface AuthViewProps {
  initialInviteToken?: string | null;
  initialVerifyToken?: string | null;
  initialResetToken?: string | null;
  onAuthenticated: (payload: AuthStatePayload) => Promise<void>;
  onClearUrlParams: () => void;
}

type AuthMode = 'login' | 'register' | 'forgot' | 'reset';

export function AuthView({
  initialInviteToken,
  initialVerifyToken,
  initialResetToken,
  onAuthenticated,
  onClearUrlParams,
}: AuthViewProps) {
  const [mode, setMode] = useState<AuthMode>(initialResetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('Purchase Manager');
  const [organizationName, setOrganizationName] = useState('');
  const [resetToken, setResetToken] = useState(initialResetToken || '');
  const [inviteToken, setInviteToken] = useState(initialInviteToken || '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!initialVerifyToken) return;
    let active = true;
    setBusy(true);
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: initialVerifyToken }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!active) return;
        if (!res.ok) {
          setError(data.error || 'Email verification failed.');
        } else {
          setInfo('Your email address has been verified. Sign in to access your workspace.');
          onClearUrlParams();
        }
      })
      .catch(() => {
        if (active) setError('Unable to verify email link.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [initialVerifyToken, onClearUrlParams]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign in failed.');

      if (inviteToken && data.csrfToken) {
        await fetch('/api/invitations/accept', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': data.csrfToken,
          },
          credentials: 'include',
          body: JSON.stringify({ token: inviteToken }),
        });
      }
      onClearUrlParams();
      await onAuthenticated(data as AuthStatePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email,
          password,
          fullName,
          title,
          organizationName: inviteToken ? undefined : organizationName,
          inviteToken: inviteToken || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed.');
      onClearUrlParams();
      await onAuthenticated(data as AuthStatePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create account.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (busy) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await cred.user.getIdToken();
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          idToken,
          inviteToken: inviteToken || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Google Sign-In failed.');
      onClearUrlParams();
      await onAuthenticated(data as AuthStatePayload);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setError('Google Sign-In window was closed before completing sign-in.');
      } else if (code === 'auth/popup-blocked') {
        setError('Browser blocked the Google Sign-In popup. Allow popups for this site and retry.');
      } else if (code === 'auth/unauthorized-domain') {
        setError(
          'This domain is not yet added to Firebase Authorized Domains. Use email/password sign-in or authorize this domain in Firebase Console.'
        );
      } else if (code === 'auth/operation-not-allowed') {
        setError('Google Sign-In is not enabled in the configured Firebase Authentication project.');
      } else {
        setError(
          err instanceof Error
            ? err.message
            : 'Google Sign-In could not be completed. Check popup permissions.'
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed.');
      setInfo(data.message || 'If an account matches that email, a reset link has been sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send reset request.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInfo(null);
    try {
      setBusy(true);
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: resetToken, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Password reset failed.');
      setInfo('Password updated. Sign in with your new credentials.');
      setPassword('');
      setMode('login');
      onClearUrlParams();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-[#E2E8F0] rounded-xl shadow-sm p-6 sm:p-8 space-y-5">
        <div className="border-b border-[#E2E8F0] pb-4">
          <div className="font-display text-lg font-bold tracking-tight text-[#0F172A]">
            NORUS QUOTEFLOW
          </div>
          <p className="text-xs text-[#475569] mt-1">
            Pre-PO Supplier Quotation Normalization & Commercial Comparison
          </p>
        </div>

        {inviteToken && (
          <div className="p-3 bg-[#0F4C81]/5 border border-[#0F4C81]/20 rounded-lg text-xs text-[#0F172A] flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-[#0F4C81]">Organization Invitation Detected</div>
              <div className="text-[#475569] mt-0.5">
                Sign in or create your account using the invited email to join the workspace.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setInviteToken('')}
              className="text-[11px] text-[#475569] hover:text-[#0F172A] shrink-0"
            >
              Clear
            </button>
          </div>
        )}

        {error && (
          <div className="p-3 bg-[#FEF2F2] border border-[#FECACA] text-[#DC2626] text-xs rounded-lg">
            {error}
          </div>
        )}

        {info && (
          <div className="p-3 bg-[#ECFDF5] border border-[#A7F3D0] text-[#059669] text-xs rounded-lg flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{info}</span>
          </div>
        )}

        {(mode === 'login' || mode === 'register') && (
          <>
            <div className="grid grid-cols-2 gap-1 p-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg text-xs font-medium">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`py-2 rounded-md transition-colors ${
                  mode === 'login'
                    ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                    : 'text-[#475569]'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
                className={`py-2 rounded-md transition-colors ${
                  mode === 'register'
                    ? 'bg-white text-[#0F172A] shadow-sm border border-[#E2E8F0]'
                    : 'text-[#475569]'
                }`}
              >
                Create Account
              </button>
            </div>

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={busy}
              className="w-full py-2.5 px-4 text-xs font-medium text-[#0F172A] bg-white border border-[#CBD5E1] rounded-lg hover:bg-[#F8FAFC] transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4 text-[#0F4C81]" />
              <span>Continue with Google</span>
            </button>

            <div className="relative flex items-center py-1">
              <div className="flex-grow border-t border-[#E2E8F0]" />
              <span className="shrink-0 mx-3 text-[11px] text-[#475569]">or use work email</span>
              <div className="flex-grow border-t border-[#E2E8F0]" />
            </div>
          </>
        )}

        {mode === 'login' && (
          <form onSubmit={handlePasswordLogin} className="space-y-3.5 text-xs">
            <div>
              <label className="block font-medium text-[#475569] mb-1">Work Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="priya@company.com"
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-medium text-[#475569]">Password</label>
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot');
                    setError(null);
                  }}
                  className="text-[#0F4C81] hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <span>{busy ? 'Signing in...' : 'Sign In'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        {mode === 'register' && (
          <form onSubmit={handleRegister} className="space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-[#475569] mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Priya Sharma"
                  className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
                />
              </div>
              <div>
                <label className="block font-medium text-[#475569] mb-1">Job Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Purchase Manager"
                  className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
                />
              </div>
            </div>
            {!inviteToken && (
              <div>
                <label className="block font-medium text-[#475569] mb-1">
                  Organization / Company Name
                </label>
                <input
                  type="text"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Kalyani Fluid Systems Pvt. Ltd."
                  className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
                />
              </div>
            )}
            <div>
              <label className="block font-medium text-[#475569] mb-1">Work Email *</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="priya@company.com"
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-[#475569] mb-1">
                Password * (8+ chars, letter + number)
              </label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50"
            >
              {busy
                ? 'Creating workspace...'
                : inviteToken
                ? 'Create Account & Join Organization'
                : 'Create Account & Organization'}
            </button>
          </form>
        )}

        {mode === 'forgot' && (
          <form onSubmit={handleForgotPassword} className="space-y-3.5 text-xs">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
              <Mail className="w-4 h-4 text-[#0F4C81]" />
              <span>Request Password Reset</span>
            </div>
            <p className="text-[#475569]">
              Enter your registered email address and we will issue a one-hour reset link.
            </p>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50"
            >
              {busy ? 'Sending...' : 'Send Reset Link'}
            </button>
            <button
              type="button"
              onClick={() => setMode('login')}
              className="w-full py-1.5 text-xs text-[#475569] hover:text-[#0F172A]"
            >
              Back to Sign In
            </button>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={handleResetPassword} className="space-y-3.5 text-xs">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
              <KeyRound className="w-4 h-4 text-[#0F4C81]" />
              <span>Set New Password</span>
            </div>
            <div>
              <label className="block font-medium text-[#475569] mb-1">Reset Token</label>
              <input
                type="text"
                required
                value={resetToken}
                onChange={(e) => setResetToken(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <div>
              <label className="block font-medium text-[#475569] mb-1">
                New Password (8+ chars, letter + number)
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full py-2.5 text-sm font-medium text-white bg-[#0F4C81] rounded-lg hover:bg-[#0A365C] disabled:opacity-50"
            >
              {busy ? 'Resetting...' : 'Reset Password'}
            </button>
            <button
              type="button"
              onClick={() => setMode('login')}
              className="w-full py-1.5 text-xs text-[#475569] hover:text-[#0F172A]"
            >
              Back to Sign In
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
