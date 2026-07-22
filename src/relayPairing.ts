import type { Event } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];
const EVENT_KIND = 1050;
const SESSION_TTL_SECONDS = 10 * 60;

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sessionTag(secret: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(secret)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionKey(secret: Uint8Array) {
  return crypto.subtle.importKey('raw', asArrayBuffer(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(secret: Uint8Array, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv) },
    await sessionKey(secret),
    asArrayBuffer(new TextEncoder().encode(value)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

async function decrypt(secret: Uint8Array, value: string) {
  const [ivValue, encryptedValue] = value.split('.');
  if (!ivValue || !encryptedValue) throw new Error('Повреждённое приглашение');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(fromBase64Url(ivValue)) },
    await sessionKey(secret),
    asArrayBuffer(fromBase64Url(encryptedValue)),
  );
  return new TextDecoder().decode(decrypted);
}

function roleOf(event: Event) {
  return event.tags.find((tag) => tag[0] === 'role')?.[1];
}

function createEvent(tag: string, role: 'offer' | 'answer', content: string) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent({
    kind: EVENT_KIND,
    created_at: now,
    tags: [
      ['d', tag],
      ['role', role],
      ['expiration', String(now + SESSION_TTL_SECONDS)],
    ],
    content,
  }, generateSecretKey());
}

async function publish(pool: SimplePool, event: Event) {
  const attempts = pool.publish(RELAYS, event, { maxWait: 7000 });
  try {
    await Promise.any(attempts);
  } catch {
    throw new Error('Публичные узлы связи сейчас недоступны. Попробуй ещё раз через минуту.');
  }
}

export async function createPairingLink(offer: string, onAnswer: (answer: string) => void) {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const tag = await sessionTag(secret);
  const pool = new SimplePool({ enableReconnect: true });
  let completed = false;
  const subscription = pool.subscribeMany(RELAYS, {
    kinds: [EVENT_KIND],
    '#d': [tag],
    since: Math.floor(Date.now() / 1000) - 5,
  }, {
    maxWait: SESSION_TTL_SECONDS * 1000,
    onevent: (event) => {
      if (completed || roleOf(event) !== 'answer') return;
      completed = true;
      void decrypt(secret, event.content).then((answer) => {
        subscription.close();
        pool.destroy();
        onAnswer(answer);
      });
    },
  });

  await publish(pool, createEvent(tag, 'offer', await encrypt(secret, offer)));
  return {
    link: `rift://join/${toBase64Url(secret)}`,
    stop: () => {
      subscription.close();
      pool.destroy();
    },
  };
}

export async function answerPairingLink(link: string, createAnswer: (offer: string) => Promise<string>) {
  const parsed = new URL(link.trim());
  if (parsed.protocol !== 'rift:' || parsed.hostname !== 'join') throw new Error('Это не ссылка-приглашение RIFT');
  const encodedSecret = parsed.pathname.replace(/^\//, '');
  const secret = fromBase64Url(encodedSecret);
  if (secret.length !== 32) throw new Error('Ссылка RIFT повреждена');
  const tag = await sessionTag(secret);
  const pool = new SimplePool({ enableReconnect: true });
  try {
    const events = await pool.querySync(RELAYS, {
      kinds: [EVENT_KIND],
      '#d': [tag],
      since: Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS,
      limit: 20,
    }, { maxWait: 7000 });
    const offerEvent = events.find((event) => roleOf(event) === 'offer');
    if (!offerEvent) throw new Error('Приглашение не найдено или уже устарело');
    const offer = await decrypt(secret, offerEvent.content);
    const answer = await createAnswer(offer);
    await publish(pool, createEvent(tag, 'answer', await encrypt(secret, answer)));
  } finally {
    pool.destroy();
  }
}
