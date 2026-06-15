/**
 * WhatsApp Flow encryption / decryption
 *
 * Flow:
 *  1. Meta sends an encrypted request to our endpoint.
 *     - encrypted_aes_key : RSA-OAEP-SHA256 encrypted 128-bit AES key
 *     - encrypted_flow_data : AES-128-GCM ciphertext  (last 16 bytes = auth tag)
 *     - initial_vector : 16-byte IV (Base64)
 *  2. We decrypt with our RSA private key → get AES key → decrypt payload.
 *  3. We bit-flip the IV and use the same AES key to encrypt our response.
 *  4. Response body: { "encrypted_response": "<base64>" }
 */

'use strict';

const crypto = require('crypto');

/**
 * Decrypt an incoming WhatsApp Flow request body.
 *
 * @param {object} body          - Parsed request body from Meta
 * @param {string} privateKeyPem - RSA private key in PEM format
 * @returns {{ body: object, aesKey: Buffer, initialVector: string }}
 */
function decryptRequest(body, privateKeyPem) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    throw new Error('Missing required encrypted fields in request body');
  }

  // 1. Decrypt the AES key with our RSA private key (OAEP + SHA-256)
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encrypted_aes_key, 'base64'),
  );

  // 2. Separate ciphertext from the 16-byte GCM auth tag
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');
  const authTag   = encryptedData.subarray(-16);
  const ciphertext = encryptedData.subarray(0, -16);

  const iv = Buffer.from(initial_vector, 'base64');

  // 3. Decrypt with AES-128-GCM
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return {
    body: JSON.parse(decrypted.toString('utf8')),
    aesKey,
    initialVector: initial_vector,
  };
}

/**
 * Encrypt a response object to send back to WhatsApp Flow.
 *
 * @param {object} responseData  - Plain-object response
 * @param {Buffer} aesKey        - AES key obtained during decryption
 * @param {string} initialVector - Original IV (Base64) – will be bit-flipped
 * @returns {string} Base64 encoded encrypted response
 */
function encryptResponse(responseData, aesKey, initialVector) {
  // Bit-flip every byte of the IV
  const iv = Buffer.from(initialVector, 'base64');
  const flippedIv = Buffer.from(iv.map(b => ~b & 0xff));

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(responseData), 'utf8'),
    cipher.final(),
  ]);

  // Append 16-byte auth tag
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}

module.exports = { decryptRequest, encryptResponse };
