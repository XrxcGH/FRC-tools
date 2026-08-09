/**
 * The small amount of linear algebra this needs, written out rather than
 * pulled in.
 *
 * An event has forty-odd teams, so the matrices are 40x40 and dense. A
 * dependency would be more code to audit than this file, and every dependency
 * is something a future maintainer has to keep alive — which, for a project
 * whose maintainers graduate, is a real cost rather than a stylistic one.
 */

export type Matrix = Float64Array;

export class LinalgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinalgError';
  }
}

/** Row-major n x n. */
export const at = (m: Matrix, n: number, i: number, j: number): number => m[i * n + j]!;
export const set = (m: Matrix, n: number, i: number, j: number, v: number): void => {
  m[i * n + j] = v;
};

export function identity(n: number, scale = 1): Matrix {
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) m[i * n + i] = scale;
  return m;
}

/**
 * Cholesky decomposition: A = L Lᵀ for symmetric positive-definite A.
 *
 * Chosen over a general solver because the normal-equations matrix is symmetric
 * positive-definite by construction once ridge regularisation is applied, and
 * Cholesky both exploits that (half the work) and *detects* when it is not true.
 * A non-positive pivot means the matrix is singular or indefinite, which for
 * this problem means the regularisation was too weak — a diagnosable condition
 * rather than silently garbage output.
 */
export function cholesky(a: Matrix, n: number): Matrix {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = at(a, n, i, j);
      for (let k = 0; k < j; k++) sum -= at(l, n, i, k) * at(l, n, j, k);
      if (i === j) {
        if (sum <= 0) {
          throw new LinalgError(
            `matrix is not positive definite at row ${i} (pivot ${sum.toExponential(2)}). ` +
              `For a ratings fit this means the ridge term is too small for the number of ` +
              `matches played.`,
          );
        }
        set(l, n, i, j, Math.sqrt(sum));
      } else {
        set(l, n, i, j, sum / at(l, n, j, j));
      }
    }
  }
  return l;
}

/** Solve L Lᵀ x = b, given L from `cholesky`. */
export function choleskySolve(l: Matrix, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= at(l, n, i, k) * y[k]!;
    y[i] = sum / at(l, n, i, i);
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= at(l, n, k, i) * x[k]!;
    x[i] = sum / at(l, n, i, i);
  }
  return x;
}

/** Inverse from a Cholesky factor. Only needed for the covariance diagonal. */
export function choleskyInverse(l: Matrix, n: number): Matrix {
  const inv = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let col = 0; col < n; col++) {
    e.fill(0);
    e[col] = 1;
    const x = choleskySolve(l, n, e);
    for (let row = 0; row < n; row++) set(inv, n, row, col, x[row]!);
  }
  return inv;
}

export function matVec(m: Matrix, n: number, v: Float64Array): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += at(m, n, i, j) * v[j]!;
    out[i] = s;
  }
  return out;
}

/** trace(A B) without forming the product. */
export function traceProduct(a: Matrix, b: Matrix, n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) t += at(a, n, i, j) * at(b, n, j, i);
  }
  return t;
}
