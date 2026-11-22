import { getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
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
  // checkRevoked=true rejects tokens for disabled accounts or revoked refresh tokens
  const decoded = await adminAuth.verifyIdToken(idToken, true);
  const expectedIssuer = `https://securetoken.google.com/${firebaseConfig.projectId}`;
  if (decoded.aud !== firebaseConfig.projectId) {
    throw new Error('Firebase ID token audience mismatch.');
  }
  if (decoded.iss !== expectedIssuer) {
    throw new Error('Firebase ID token issuer mismatch.');
  }
  return decoded;
}
