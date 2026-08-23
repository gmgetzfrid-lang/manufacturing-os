// Small dense linear algebra, dependency-free.
//
// The reconstruction needs eigen/SVD on matrices of fixed, tiny size (3x3, 4x4,
// 9x9) plus Cholesky on the bundle-adjustment reduced camera system. Pulling in
// a linear algebra library for that would cost more than it saves, and keeping
// this pure TypeScript means every routine is unit-testable in Node without a
// browser or a WASM runtime.
//
// Matrices are row-major Float64Array unless stated otherwise.

/** Symmetric eigendecomposition by the cyclic Jacobi method.
 *
 * Chosen over a general QR implementation because every matrix we decompose is
 * symmetric (they are all AᵀA), and Jacobi is short, has no pathological cases
 * for symmetric input, and returns eigenvectors that are orthogonal to working
 * precision — which matters when we take a null space from the smallest one.
 *
 * Returns eigenvalues ascending, with `vectors[i]` holding the i-th eigenvector
 * as a row.
 */
export function jacobiEigenSymmetric(
  input: Float64Array,
  n: number,
  maxSweeps = 100,
): { values: Float64Array; vectors: Float64Array } {
  const a = Float64Array.from(input);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // Convergence test: sum of squared off-diagonal magnitude.
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off < 1e-30) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        // t = sign(theta)/(|theta| + sqrt(theta²+1)), the numerically stable root.
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];

  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => values[x] - values[y]);
  const sortedValues = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    sortedValues[i] = values[order[i]];
    for (let k = 0; k < n; k++) vectors[i * n + k] = v[k * n + order[i]];
  }
  return { values: sortedValues, vectors };
}

/** Eigenvector of the smallest eigenvalue of AᵀA — i.e. the least-squares null
 *  space of A, which is how every homogeneous system here is solved. */
export function nullSpace(A: Float64Array, rows: number, cols: number): Float64Array {
  const ata = new Float64Array(cols * cols);
  for (let i = 0; i < cols; i++) {
    for (let j = i; j < cols; j++) {
      let sum = 0;
      for (let r = 0; r < rows; r++) sum += A[r * cols + i] * A[r * cols + j];
      ata[i * cols + j] = sum;
      ata[j * cols + i] = sum;
    }
  }
  const { vectors } = jacobiEigenSymmetric(ata, cols);
  return vectors.slice(0, cols);
}

export interface Svd3 {
  U: Float64Array;      // 3x3
  S: [number, number, number]; // descending
  V: Float64Array;      // 3x3 (not transposed)
}

/** SVD of a 3x3 matrix via the eigendecomposition of AᵀA.
 *
 * Accurate enough for essential-matrix work, where the matrix is already noisy
 * from RANSAC, and it avoids a general SVD implementation. Degenerate columns
 * (zero singular values) are completed by cross product so U stays orthonormal.
 */
export function svd3x3(M: Float64Array): Svd3 {
  const ata = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += M[k * 3 + i] * M[k * 3 + j];
      ata[i * 3 + j] = s;
    }
  }
  const { values, vectors } = jacobiEigenSymmetric(ata, 3);

  // Jacobi gives ascending order; SVD convention is descending.
  const V = new Float64Array(9);
  const S: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const src = 2 - i;
    S[i] = Math.sqrt(Math.max(0, values[src]));
    for (let k = 0; k < 3; k++) V[k * 3 + i] = vectors[src * 3 + k];
  }

  // U column i = M · V column i / σ_i.
  //
  // The rank test must be RELATIVE to the largest singular value. An essential
  // matrix is rank 2 by construction, so σ₃ is whatever rounding noise happens
  // to leave behind — often around 1e-8 rather than a clean zero. An absolute
  // threshold lets that survive, and dividing a ~1e-12 numerator by it yields a
  // near-zero third column: U stops being orthonormal and the translation
  // recovered from it collapses to nothing.
  const U = new Float64Array(9);
  const degenerate: boolean[] = [false, false, false];
  const tol = Math.max(S[0], 1e-300) * 1e-7;
  for (let i = 0; i < 3; i++) {
    if (S[i] <= tol) { degenerate[i] = true; continue; }
    let norm = 0;
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += M[r * 3 + k] * V[k * 3 + i];
      U[r * 3 + i] = s;
      norm += s * s;
    }
    norm = Math.sqrt(norm);
    if (norm <= tol) { degenerate[i] = true; continue; }
    // Normalise explicitly rather than dividing by σ_i: algebraically the same,
    // but it cannot amplify noise when σ_i is small.
    for (let r = 0; r < 3; r++) U[r * 3 + i] /= norm;
  }

  // Rebuild degenerate columns by cross product so U stays orthonormal.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 3; i++) {
      if (!degenerate[i]) continue;
      const a = (i + 1) % 3;
      const b = (i + 2) % 3;
      if (degenerate[a] || degenerate[b]) continue;
      const ua = [U[a], U[3 + a], U[6 + a]];
      const ub = [U[b], U[3 + b], U[6 + b]];
      const cross = [
        ua[1] * ub[2] - ua[2] * ub[1],
        ua[2] * ub[0] - ua[0] * ub[2],
        ua[0] * ub[1] - ua[1] * ub[0],
      ];
      const norm = Math.hypot(cross[0], cross[1], cross[2]);
      if (norm < 1e-12) continue;
      U[i] = cross[0] / norm;
      U[3 + i] = cross[1] / norm;
      U[6 + i] = cross[2] / norm;
      degenerate[i] = false;
    }
  }
  // Fully degenerate input (rank <= 1): fall back to the identity basis so the
  // caller gets an orthonormal U rather than zeros.
  for (let i = 0; i < 3; i++) {
    if (!degenerate[i]) continue;
    U[i * 3 + i] = 1;
    degenerate[i] = false;
  }
  return { U, S, V };
}

// ── 3x3 helpers ─────────────────────────────────────────────────────────────

export function mat3Mul(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      out[i * 3 + j] = s;
    }
  }
  return out;
}

export function mat3Transpose(a: Float64Array): Float64Array {
  const out = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i * 3 + j] = a[j * 3 + i];
  return out;
}

export function mat3MulVec(a: Float64Array, v: readonly number[]): [number, number, number] {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

export function mat3Det(a: Float64Array): number {
  return (
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6])
  );
}

export function mat3Inverse(a: Float64Array): Float64Array | null {
  const det = mat3Det(a);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const o = new Float64Array(9);
  o[0] = (a[4] * a[8] - a[5] * a[7]) * inv;
  o[1] = (a[2] * a[7] - a[1] * a[8]) * inv;
  o[2] = (a[1] * a[5] - a[2] * a[4]) * inv;
  o[3] = (a[5] * a[6] - a[3] * a[8]) * inv;
  o[4] = (a[0] * a[8] - a[2] * a[6]) * inv;
  o[5] = (a[2] * a[3] - a[0] * a[5]) * inv;
  o[6] = (a[3] * a[7] - a[4] * a[6]) * inv;
  o[7] = (a[1] * a[6] - a[0] * a[7]) * inv;
  o[8] = (a[0] * a[4] - a[1] * a[3]) * inv;
  return o;
}

/** Closest rotation matrix to `m` (Frobenius sense) — projects drift back onto SO(3). */
export function orthonormalize(m: Float64Array): Float64Array {
  const { U, V } = svd3x3(m);
  const R = mat3Mul(U, mat3Transpose(V));
  if (mat3Det(R) < 0) {
    // Flip the last column of U to keep a right-handed frame.
    const U2 = Float64Array.from(U);
    U2[2] = -U2[2];
    U2[5] = -U2[5];
    U2[8] = -U2[8];
    return mat3Mul(U2, mat3Transpose(V));
  }
  return R;
}

// ── Rotation parameterisation ───────────────────────────────────────────────

/** Axis-angle (Rodrigues) vector → rotation matrix. */
export function rodrigues(r: readonly number[]): Float64Array {
  const theta = Math.hypot(r[0], r[1], r[2]);
  const out = new Float64Array(9);
  if (theta < 1e-12) {
    out[0] = out[4] = out[8] = 1;
    // First-order term keeps the derivative correct for tiny rotations.
    const [x, y, z] = r;
    out[1] = -z; out[2] = y;
    out[3] = z; out[5] = -x;
    out[6] = -y; out[7] = x;
    return out;
  }
  const [x, y, z] = [r[0] / theta, r[1] / theta, r[2] / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  out[0] = c + x * x * t;
  out[1] = x * y * t - z * s;
  out[2] = x * z * t + y * s;
  out[3] = y * x * t + z * s;
  out[4] = c + y * y * t;
  out[5] = y * z * t - x * s;
  out[6] = z * x * t - y * s;
  out[7] = z * y * t + x * s;
  out[8] = c + z * z * t;
  return out;
}

/** Rotation matrix → axis-angle vector. */
export function rodriguesInverse(R: Float64Array): [number, number, number] {
  const trace = R[0] + R[4] + R[8];
  const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
  const theta = Math.acos(cos);
  if (theta < 1e-9) return [0, 0, 0];
  if (Math.PI - theta < 1e-6) {
    // Near pi the standard formula loses precision; recover the axis from the
    // largest diagonal entry of R + I instead.
    const d = [R[0] + 1, R[4] + 1, R[8] + 1];
    const i = d.indexOf(Math.max(...d));
    const axis = new Float64Array(3);
    axis[i] = Math.sqrt(Math.max(0, d[i] / 2));
    const inv = axis[i] > 1e-9 ? 1 / (2 * axis[i]) : 0;
    if (i === 0) {
      axis[1] = R[1] * inv * 1; axis[2] = R[2] * inv * 1;
      axis[1] = (R[1] + R[3]) / 2 / (2 * axis[0]);
      axis[2] = (R[2] + R[6]) / 2 / (2 * axis[0]);
    } else if (i === 1) {
      axis[0] = (R[1] + R[3]) / 2 / (2 * axis[1]);
      axis[2] = (R[5] + R[7]) / 2 / (2 * axis[1]);
    } else {
      axis[0] = (R[2] + R[6]) / 2 / (2 * axis[2]);
      axis[1] = (R[5] + R[7]) / 2 / (2 * axis[2]);
    }
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    return [(axis[0] / n) * theta, (axis[1] / n) * theta, (axis[2] / n) * theta];
  }
  const k = theta / (2 * Math.sin(theta));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}

// ── Dense solvers ───────────────────────────────────────────────────────────

/** In-place Cholesky (A = LLᵀ) for symmetric positive definite A. */
export function choleskyDecompose(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j];
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (sum <= 0) return null; // not positive definite — caller adds damping
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}

export function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return x;
}

/** Solve the symmetric system Ax = b, adding damping until A is factorable. */
export function solveSymmetric(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  let lambda = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const damped = Float64Array.from(A);
    if (lambda > 0) for (let i = 0; i < n; i++) damped[i * n + i] += lambda;
    const L = choleskyDecompose(damped, n);
    if (L) return choleskySolve(L, n, b);
    lambda = lambda === 0 ? 1e-9 : lambda * 100;
  }
  return null;
}

/** 3x3 symmetric inverse used for the per-point blocks in bundle adjustment. */
export function invertSymmetric3(m: Float64Array, damping = 0): Float64Array | null {
  const a = Float64Array.from(m);
  a[0] += damping;
  a[4] += damping;
  a[8] += damping;
  return mat3Inverse(a);
}
