import crypto from 'node:crypto';

// Bearer-token auth at the WS handshake edge (ADR-004).
// Token is stored/compared as a sha256 digest so timingSafeEqual always operates
// on equal-length 32-byte buffers (length-leak safe), regardless of token length.
export class AuthN {
  constructor({ token }) {
    if (typeof token !== 'string' || token.length < 8) {
      throw new Error('config.token must be a string of at least 8 characters');
    }
    this._tokenHash = crypto.createHash('sha256').update(token).digest();
  }

  check(provided) {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    return crypto.timingSafeEqual(providedHash, this._tokenHash);
  }
}
