import { getApps, initializeApp } from 'firebase-admin/app';
import { type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };

if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

export const adminAuth = getAuth();

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
  aud?: string;
  iss?: string;
}

export type FirebaseTokenVerifier = (idToken: string) => Promise<VerifiedFirebaseUser>;

export async function verifyFirebaseIdToken(idToken: string): Promise<DecodedIdToken> {
  // Default checkRevoked=false so verification uses Google's public X.509 certificates and
  // validates signature, expiry, aud, and iss without requiring IAM access on host project ADC
  // (in AI Studio containers, checkRevoked=true calls Identity Toolkit under the sandbox project).
  // Set FIREBASE_CHECK_REVOKED=true when running with an authorized service account.
  const checkRevoked = process.env.FIREBASE_CHECK_REVOKED === 'true';
  const decoded = await adminAuth.verifyIdToken(idToken, checkRevoked);
  const expectedIssuer = `https://securetoken.google.com/${firebaseConfig.projectId}`;
  if (decoded.aud !== firebaseConfig.projectId) {
    throw new Error('Firebase ID token audience mismatch.');
  }
  if (decoded.iss !== expectedIssuer) {
    throw new Error('Firebase ID token issuer mismatch.');
  }
  return decoded;
}
