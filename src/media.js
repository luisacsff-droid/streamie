// Validación de archivos subidos: solo audio e imágenes reales (por su firma, no por el nombre).
const SIGNATURES = [
  { mime: 'audio/mpeg', kind: 'audio', test: (b) => b.slice(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { mime: 'audio/wav', kind: 'audio', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WAVE' },
  { mime: 'audio/ogg', kind: 'audio', test: (b) => b.slice(0, 4).toString('latin1') === 'OggS' },
  { mime: 'audio/mp4', kind: 'audio', test: (b) => b.slice(4, 8).toString('latin1') === 'ftyp' },
  { mime: 'image/png', kind: 'image', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', kind: 'image', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', kind: 'image', test: (b) => ['GIF87a', 'GIF89a'].includes(b.slice(0, 6).toString('latin1')) },
  { mime: 'image/webp', kind: 'image', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
];

// Devuelve { kind, mime } o null si el archivo no es un audio/imagen permitido.
function detect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const hit = SIGNATURES.find((s) => s.test(buf));
  return hit ? { kind: hit.kind, mime: hit.mime } : null;
}

function cleanName(name) {
  return (
    String(name || 'archivo')
      .replace(/[\u0000-\u001f<>"'`\\/]/g, '')
      .trim()
      .slice(0, 60) || 'archivo'
  );
}

const mediaUrl = (id) => (id ? `/media/${id}` : '');

module.exports = { detect, cleanName, mediaUrl };
