import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const envKey = process.env.SALES_MCP_ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error(
      'SALES_MCP_ENCRYPTION_KEY environment variable is not set. ' +
      'Provide a 32-byte hex string (64 hex characters).'
    );
  }
  const keyBuffer = Buffer.from(envKey, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `SALES_MCP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ` +
      `Got ${keyBuffer.length} bytes.`
    );
  }
  return keyBuffer;
}

// Built by Christos Ferlachidis & Daniel Hedenberg

export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(text, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(data: string): string {
  const key = getKey();
  const parts = data.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid encrypted data format. Expected "iv:authTag:ciphertext" but got ${parts.length} segment(s).`
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}
