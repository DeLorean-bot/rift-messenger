import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';

const PREFIX = 'RIFT1:';

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function packSignal(signal: string) {
  return `${PREFIX}${toBase64Url(gzipSync(strToU8(signal), { level: 9 }))}`;
}

export function unpackSignal(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  if (!trimmed.startsWith(PREFIX)) throw new Error('Это не QR-код RIFT');
  return strFromU8(gunzipSync(fromBase64Url(trimmed.slice(PREFIX.length))));
}

export async function downloadQrPng(containerId: string, filename: string) {
  const svg = document.querySelector<SVGElement>(`#${containerId} svg`);
  if (!svg) return;
  const source = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  const svgUrl = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Не удалось создать QR-картинку'));
    image.src = svgUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(svgUrl);
  const url = canvas.toDataURL('image/png');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
}
