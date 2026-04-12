import crypto from "crypto";

const SCRM_TOKEN = () => process.env.SCRM_TOKEN || "";
const SCRM_AES_KEY = () => process.env.SCRM_ENCODING_AES_KEY || "";
const SCRM_APP_KEY = () => process.env.SCRM_APP_KEY || "";

/**
 * 验签：sha1(sort([token, timestamp, nonce, encrypt]))
 * 与企业微信回调验签规则一致
 */
export function verifySignature(
  signature: string,
  timestamp: string,
  nonce: string,
  encrypt: string
): boolean {
  const token = SCRM_TOKEN();
  const arr = [token, timestamp, nonce, encrypt].sort();
  const hash = crypto.createHash("sha1").update(arr.join("")).digest("hex");
  return hash === signature;
}

/**
 * 解密 encoding_content
 *
 * 尝试两种常见方案：
 * 1. AES key = hex(EncodingAESKey) → 16 bytes, AES-128-CBC, iv = key
 * 2. AES key = base64(EncodingAESKey + '=') → 32 bytes, AES-256-CBC, iv = key[0:16]
 *
 * 解密后格式：random(16B) + msgLen(4B big-endian) + msg + appKey
 */
export function decryptMessage(encodingContent: string): string {
  const aesKeyHex = SCRM_AES_KEY();

  // 方案1：hex key（32 hex chars → 16 bytes → AES-128）
  if (/^[0-9a-f]{32}$/i.test(aesKeyHex)) {
    try {
      return decryptWithKey(encodingContent, Buffer.from(aesKeyHex, "hex"));
    } catch {
      // fall through
    }
  }

  // 方案2：base64 key（43 chars → 32 bytes → AES-256）
  try {
    const keyBase64 = aesKeyHex.length === 43 ? aesKeyHex + "=" : aesKeyHex;
    return decryptWithKey(encodingContent, Buffer.from(keyBase64, "base64"));
  } catch {
    // fall through
  }

  // 方案3：原文可能就是明文 JSON（开发模式）
  try {
    const plain = Buffer.from(encodingContent, "base64").toString("utf-8");
    JSON.parse(plain);
    return plain;
  } catch {
    // fall through
  }

  throw new Error("Failed to decrypt encoding_content with any known scheme");
}

function decryptWithKey(cipherBase64: string, key: Buffer): string {
  const iv = key.subarray(0, 16);
  const algorithm = key.length === 16 ? "aes-128-cbc" : "aes-256-cbc";
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAutoPadding(true);

  const ciphertext = Buffer.from(cipherBase64, "base64");
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // 格式：random(16) + msgLen(4, big-endian) + msg + appKey
  if (decrypted.length < 20) throw new Error("decrypted content too short");

  const msgLen = decrypted.readUInt32BE(16);
  if (msgLen <= 0 || 20 + msgLen > decrypted.length) {
    // 有些平台不用 random+len 包装，直接就是 JSON
    const raw = decrypted.toString("utf-8");
    JSON.parse(raw); // 验证是合法 JSON
    return raw;
  }

  return decrypted.subarray(20, 20 + msgLen).toString("utf-8");
}

/**
 * 加密响应（用于 URL 验证时回传 echostr）
 */
export function encryptMessage(replyMsg: string): string {
  const aesKeyHex = SCRM_AES_KEY();
  const appKey = SCRM_APP_KEY();

  let key: Buffer;
  if (/^[0-9a-f]{32}$/i.test(aesKeyHex)) {
    key = Buffer.from(aesKeyHex, "hex");
  } else {
    const keyBase64 = aesKeyHex.length === 43 ? aesKeyHex + "=" : aesKeyHex;
    key = Buffer.from(keyBase64, "base64");
  }

  const iv = key.subarray(0, 16);
  const algorithm = key.length === 16 ? "aes-128-cbc" : "aes-256-cbc";

  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(replyMsg, "utf-8");
  const appKeyBuf = Buffer.from(appKey, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);

  const plaintext = Buffer.concat([random, lenBuf, msgBuf, appKeyBuf]);

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
}
