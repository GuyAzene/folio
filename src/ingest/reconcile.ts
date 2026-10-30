import { normalizeText } from "../kb/normalize.ts";

/**
 * Deterministic checks that a model's words carry a region's words. They establish presence,
 * not correctness: a fluent wrong explanation can still pass.
 */

const STOPWORDS = new Set(
  "the a an and or of to in on for is are was were be by with as at from that this these those it its into than then so if not no".split(
    " ",
  ),
);

/** LaTeX commands a reader may write for a symbol the PDF prints. */
const LATEX: Record<string, string> = {
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  in: "∈",
  notin: "∉",
  subseteq: "⊆",
  subset: "⊂",
  supseteq: "⊇",
  supset: "⊃",
  cup: "∪",
  cap: "∩",
  setminus: "\\",
  sum: "∑",
  prod: "∏",
  infty: "∞",
  to: "→",
  rightarrow: "→",
  Rightarrow: "⇒",
  implies: "⇒",
  leftarrow: "←",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  iff: "⇔",
  mapsto: "↦",
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  emptyset: "∅",
  varnothing: "∅",
  langle: "⟨",
  rangle: "⟩",
  ldots: "…",
  dots: "…",
  cdots: "…",
  mid: "|",
  circ: "∘",
  oplus: "⊕",
  otimes: "⊗",
  equiv: "≡",
  approx: "≈",
  sim: "∼",
  cong: "≅",
  perp: "⊥",
  vdash: "⊢",
  models: "⊨",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  Gamma: "Γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  varepsilon: "ε",
  lambda: "λ",
  Lambda: "Λ",
  mu: "μ",
  pi: "π",
  Pi: "Π",
  rho: "ρ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  theta: "θ",
  Theta: "Θ",
  phi: "φ",
  varphi: "φ",
  Phi: "Φ",
  psi: "ψ",
  Psi: "Ψ",
  omega: "ω",
  Omega: "Ω",
};
const BLACKBOARD: Record<string, string> = { N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ", C: "ℂ" };

/**
 * Math as a PDF prints it, from the LaTeX a reader may write instead: \le as ≤, x_{1} as x1,
 * \frac{a}{b} as a/b, \{ … \} as { … }; sub- and superscript marks go on both sides alike.
 */
function plainMath(text: string): string {
  return text
    .replace(/\\mathbb\{([A-Z])\}/g, (all, letter: string) => BLACKBOARD[letter] ?? letter)
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√$1")
    .replace(
      /\\(?:text|mathrm|mathit|mathbf|mathcal|mathsf|operatorname|textbf|textit)\{([^{}]*)\}/g,
      "$1",
    )
    .replace(/\\([{}])/g, (_, brace: string) => (brace === "{" ? "\uE000" : "\uE001"))
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\([A-Za-z]+)/g, (all, name: string) => LATEX[name] ?? all)
    .replace(/[{}$_^]/g, "")
    .replace(/\uE000/g, "{")
    .replace(/\uE001/g, "}");
}

/**
 * The search index's normalization (NFKC, so a PDF's math-italic 𝑀𝐿, subscript ₁ and ligature
 * ﬁ read as ML, 1 and fi; bidi and zero-width marks, niqqud and final letters as there), with
 * LaTeX read as the symbols it stands for and quote marks dropped. Kept the same on both sides.
 */
export function normalize(text: string): string {
  return normalizeText(plainMath(text)).replace(/[״"׳'`’‘“”^_]/g, "");
}

/** Words of three or more letters that carry content, in normalized form. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalize(text).split(/[^\p{L}\p{N}]+/u)) {
    // Letters, not UTF-16 units: a math-italic pair is two letters, like the ASCII it stands for.
    if (/^.{3,}$/u.test(token) && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/**
 * Share of the source's content words found in the candidate. Hebrew words also match with one
 * attached prefix letter (ו ה ב כ ל מ ש) removed on either side.
 */
export function tokenRecall(source: string, candidate: string): number {
  const wanted = contentTokens(source);
  if (!wanted.size) return 1;
  const have = contentTokens(candidate);
  const stripped = new Set([...have].map(stripPrefix));
  let found = 0;
  for (const token of wanted)
    if (have.has(token) || stripped.has(stripPrefix(token)) || have.has(stripPrefix(token)))
      found++;
  return found / wanted.size;
}

function stripPrefix(token: string): string {
  return /^[והבכלמש][א-ת]{2,}/.test(token) ? token.slice(1) : token;
}

/** Numbers and math tokens from the source that the candidate lacks (spaces ignored). */
export function missingNumbers(numbers: string[], candidate: string): string[] {
  const squeezed = normalize(candidate).replace(/\s+/g, "");
  return numbers.filter((number) => !squeezed.includes(normalize(number).replace(/\s+/g, "")));
}
