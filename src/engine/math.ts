// Minimal vector / quaternion / matrix helpers (column-major mat4, like glTF & WebGL).

export type V3 = [number, number, number];
export type Q = [number, number, number, number]; // x y z w
export type M4 = Float32Array;

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpV = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export function quatIdentity(): Q { return [0, 0, 0, 1]; }
export function quatAxisAngle(axis: V3, angle: number): Q {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
export function quatMul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export function quatSlerp(a: Q, b: Q, t: number, out: Q = [0, 0, 0, 1]): Q {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0: number, k1: number;
  if (cos > 0.9995) { k0 = 1 - t; k1 = t; }
  else {
    const th = Math.acos(cos); const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
  }
  out[0] = a[0] * k0 + bx * k1; out[1] = a[1] * k0 + by * k1;
  out[2] = a[2] * k0 + bz * k1; out[3] = a[3] * k0 + bw * k1;
  const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
  return out;
}
export function quatRotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
/** Quaternion for a camera/object whose -Z looks along `dir` with the given up. */
export function quatLookDir(dir: V3, up: V3 = [0, 1, 0]): Q {
  const z = norm(scale(dir, -1));
  let x = cross(up, z);
  if (len(x) < 1e-6) x = cross([0, 0, 1], z);
  x = norm(x);
  const y = cross(z, x);
  return quatFromBasis(x, y, z);
}
export function quatFromBasis(x: V3, y: V3, z: V3): Q {
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2; qw = 0.25 * s;
    qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / s;
    qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / s;
    qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / s;
    qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  return [qx, qy, qz, qw];
}
/** Yaw (around +Y) then pitch (around local +X). yaw=0 looks down -Z. */
export function quatYawPitch(yaw: number, pitch: number): Q {
  return quatMul(quatAxisAngle([0, 1, 0], yaw), quatAxisAngle([1, 0, 0], pitch));
}

export function m4(): M4 { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function m4Compose(out: M4, t: V3 | number[], q: Q | number[], s: V3 | number[]): M4 {
  const [x, y, z, w] = q as number[];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}
export function m4Mul(out: M4, a: M4, b: M4): M4 {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  out.set(r); return out;
}
export function m4Invert(out: M4, m: M4): M4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
export function m4Perspective(out: M4, fovY: number, aspect: number, near: number, far: number): M4 {
  const f = 1 / Math.tan(fovY / 2); const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f; out[10] = (far + near) * nf; out[11] = -1; out[14] = 2 * far * near * nf;
  return out;
}
export function m4TransformPoint(m: M4, p: V3): V3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}
export function m4NormalMatrix(out: Float32Array, m: M4): Float32Array {
  // inverse-transpose of upper 3x3
  const a00 = m[0], a01 = m[1], a02 = m[2], a10 = m[4], a11 = m[5], a12 = m[6], a20 = m[8], a21 = m[9], a22 = m[10];
  const b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  det = det ? 1 / det : 0;
  out[0] = b01 * det; out[1] = (-a22 * a01 + a02 * a21) * det; out[2] = (a12 * a01 - a02 * a11) * det;
  out[3] = b11 * det; out[4] = (a22 * a00 - a02 * a20) * det; out[5] = (-a12 * a00 + a02 * a10) * det;
  out[6] = b21 * det; out[7] = (-a21 * a00 + a01 * a20) * det; out[8] = (a11 * a00 - a01 * a10) * det;
  // transpose
  let t = out[1]; out[1] = out[3]; out[3] = t;
  t = out[2]; out[2] = out[6]; out[6] = t;
  t = out[5]; out[5] = out[7]; out[7] = t;
  return out;
}
export function m4MaxScale(m: M4): number {
  return Math.sqrt(Math.max(
    m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
    m[4] * m[4] + m[5] * m[5] + m[6] * m[6],
    m[8] * m[8] + m[9] * m[9] + m[10] * m[10],
  ));
}

/** sRGB hex → linear rgb */
export function hexLinear(hex: string): V3 {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [c((n >> 16) & 255), c((n >> 8) & 255), c(n & 255)];
}
