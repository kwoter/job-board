import { webcrypto, randomBytes } from 'node:crypto';

const kp = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);
const publicKey = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
const privateKey = await webcrypto.subtle.exportKey('jwk', kp.privateKey);
const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', kp.publicKey));

const words = ['amber', 'birch', 'cobalt', 'delta', 'ember', 'flint', 'grove', 'harbour', 'indigo', 'juno', 'krait', 'lumen', 'marble', 'nimbus', 'onyx', 'pico', 'quartz', 'rook', 'slate', 'tonic', 'umber', 'vault', 'wren', 'xenon', 'yarrow', 'zephyr'];
const pick = () => words[randomBytes(1)[0] % words.length];
const password = `${pick()}-${pick()}-${randomBytes(2).readUInt16BE(0)}`;

console.log(JSON.stringify({
  vapidJwk: { publicKey, privateKey },
  appServerKey: raw.toString('base64url'),
  cronSecret: randomBytes(24).toString('hex'),
  password
}, null, 2));
