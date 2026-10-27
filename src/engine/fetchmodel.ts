// Model loading. The claude.ai artifact host serves .json but not .glb, so that build ships each GLB as base64
// inside JSON; the web build (GitHub Pages etc.) serves the GLB files directly.
declare const __MODEL_EXT__: string;
const EXT = typeof __MODEL_EXT__ === 'string' ? __MODEL_EXT__ : 'json';

export async function fetchModel(name: string): Promise<ArrayBuffer> {
  const r = await fetch(`assets/models/${name}.${EXT}`);
  if (!r.ok) throw new Error(`${name} (${r.status})`);
  if (EXT === 'glb') return r.arrayBuffer();
  const j = await r.json();
  const bin = atob(j.data as string);
  const n = bin.length;
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
