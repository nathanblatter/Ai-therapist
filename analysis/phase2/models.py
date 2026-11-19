"""Estimators.

Primary estimator (growth_model): linear mixed-effects model of the outcome on
continuous study time, random intercept and random time slope per participant
(unstructured covariance), REML, fitted with statsmodels. See
PREREGISTRATION.md section 5 for which parts are protocol text and which are
this draft's proposal.

growth_model_fast is the same model and criterion in closed-form sufficient
statistics. The power simulation uses it for speed, and the analysis report
prints it beside the statsmodels fit as an independent cross-check.
"""

from __future__ import annotations

import warnings
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

ALPHA = 0.05
ACCESS_WEEKS = 8  # protocol: 8-week access period


@dataclass
class Fit:
    term: str
    estimate: float
    se: float
    df: int
    ci_low: float
    ci_high: float
    p: float
    n_participants: int
    n_obs: int
    model: str  # 'random_slope' | 'random_intercept_fallback'
    converged: bool
    var_intercept: float
    var_slope: float
    var_resid: float
    note: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def holm(pvals: list[float]) -> list[float]:
    """Holm step-down adjusted p-values, in the input order."""
    m = len(pvals)
    order = np.argsort(pvals)
    adj = [0.0] * m
    running = 0.0
    for rank, idx in enumerate(order):
        running = max(running, (m - rank) * pvals[idx])
        adj[idx] = min(1.0, running)
    return adj


def benjamini_hochberg(pvals: list[float]) -> list[float]:
    """Benjamini-Hochberg adjusted p-values (q-values), in the input order."""
    m = len(pvals)
    order = np.argsort(pvals)[::-1]
    adj = [0.0] * m
    running = 1.0
    for i, idx in enumerate(order):
        rank = m - i
        running = min(running, pvals[idx] * m / rank)
        adj[idx] = running
    return adj


# statsmodels' MixedLM can stop short of the REML optimum with a single
# optimiser, sometimes while reporting converged=True (seen on synthetic data
# with small slope variances; see analysis/README.md "Optimiser note"). The
# pre-specified rule is therefore: fit with every optimiser below and keep the
# fit with the highest restricted log-likelihood.
OPTIMIZERS = ("lbfgs", "bfgs", "powell")


def _fit_mixed(y: np.ndarray, X: pd.DataFrame, groups: np.ndarray, random_slope: str | None):
    """Fit one MixedLM by REML with each optimiser; return (best result, ok).

    best = highest restricted log-likelihood among fits with finite standard
    errors. ok is False when no optimiser produced such a fit.
    """
    Z = X[["Intercept", random_slope]] if random_slope else None
    best = None
    for method in OPTIMIZERS:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                res = sm.MixedLM(y, X, groups=groups, exog_re=Z).fit(reml=True, method=[method])
            except Exception:  # noqa: BLE001 - singular designs raise assorted linear-algebra errors
                continue
        if not np.all(np.isfinite(np.asarray(res.bse_fe))) or not np.isfinite(res.llf):
            continue
        if best is None or res.llf > best.llf:
            best = res
    return best, best is not None


def _design(d: pd.DataFrame, time: str, moderator: str | None, covariates: tuple[str, ...]) -> tuple[pd.DataFrame, str]:
    """Fixed-effects design matrix built by hand (no formula parsing: the power
    simulation calls this thousands of times)."""
    X = pd.DataFrame({"Intercept": 1.0, time: d[time].to_numpy(dtype=float)})
    term = time
    if moderator:
        X[moderator] = d[moderator].to_numpy(dtype=float)
        term = f"{time}:{moderator}"
        X[term] = X[time] * X[moderator]
    for c in covariates:
        X[c] = d[c].to_numpy(dtype=float)
    return X, term


def growth_model(
    data: pd.DataFrame,
    outcome: str = "score",
    time: str = "t_weeks",
    moderator: str | None = None,
    covariates: tuple[str, ...] = (),
) -> Fit:
    """Mixed-effects growth model:

        outcome_ij = b0 + b1*time_ij [+ b2*mod_i + b3*time_ij*mod_i] [+ covariates]
                     + u0_i + u1_i*time_ij + e_ij

    (u0_i, u1_i) ~ N(0, unstructured 2x2), e_ij ~ N(0, s2), REML.

    Without a moderator the reported term is b1, the mean change per week.
    With a moderator it is b3, the difference in weekly change per unit of the
    (numeric) moderator.

    Pre-specified fallback: if no optimiser yields a random-slope fit with
    finite standard errors, refit with a random intercept only and say so in
    `model`. The fallback is anticonservative when slopes truly vary, so the
    report flags it; it exists so the script always returns an answer.
    """
    cols = ["participant_id", outcome, time, *covariates] + ([moderator] if moderator else [])
    d = data[cols].dropna()
    y = d[outcome].to_numpy(dtype=float)
    groups = d["participant_id"].to_numpy()
    X, term = _design(d, time, moderator, covariates)

    res, ok = _fit_mixed(y, X, groups, time)
    used = "random_slope"
    note = ""
    if not ok:
        res, ok2 = _fit_mixed(y, X, groups, None)
        used = "random_intercept_fallback"
        note = "random-slope model could not be fitted; random-intercept fallback used"
        if res is None:
            raise RuntimeError(f"mixed model could not be fitted at all for outcome {outcome!r}")
        if not ok2:
            note += "; fallback also failed"

    est = float(res.fe_params[term])
    se = float(res.bse_fe[term])
    g = int(d["participant_id"].nunique())
    df = max(g - 1, 1)  # t reference on participants - 1: slightly conservative vs statsmodels' z
    tcrit = float(stats.t.ppf(1 - ALPHA / 2, df))
    p = float(2 * stats.t.sf(abs(est / se), df)) if se > 0 else float("nan")
    cov_re = np.asarray(res.cov_re)
    return Fit(
        term=term,
        estimate=est,
        se=se,
        df=df,
        ci_low=est - tcrit * se,
        ci_high=est + tcrit * se,
        p=p,
        n_participants=g,
        n_obs=int(len(d)),
        model=used,
        converged=bool(res.converged),
        var_intercept=float(cov_re[0, 0]),
        var_slope=float(cov_re[1, 1]) if cov_re.shape[0] > 1 else 0.0,
        var_resid=float(res.scale),
        note=note,
    )


def fgls_cr2(data: pd.DataFrame, outcome: str = "score", time: str = "t_weeks") -> Fit:
    """Random-intercept FGLS with CR2 cluster-robust SEs.

    A line-for-line port of random_intercept_fgls() in
    scripts/phase2-analysis-plan.py, the estimator the September 2026 power
    analysis (docs/phase2-power-analysis.md) was computed with. Kept as a
    pre-specified sensitivity analysis so the two can be compared on the same
    data; which one is confirmatory is open decision D1.
    """
    d = data[["participant_id", outcome, time]].dropna()
    pid = d["participant_id"].to_numpy()
    wk = d[time].to_numpy(dtype=float)
    y = d[outcome].to_numpy(dtype=float)
    X = np.column_stack([np.ones_like(wk), wk])
    clusters, inv = np.unique(pid, return_inverse=True)
    G = len(clusters)
    order = np.argsort(inv, kind="stable")
    bounds = np.concatenate([[0], np.cumsum(np.bincount(inv, minlength=G))])
    groups = [order[bounds[i] : bounds[i + 1]] for i in range(G)]

    beta0 = np.linalg.lstsq(X, y, rcond=None)[0]
    resid = y - X @ beta0
    num, den = 0.0, 0
    for idx in groups:
        r = resid[idx]
        if len(r) > 1:
            num += float(np.sum((r - r.mean()) ** 2))
            den += len(r) - 1
    s2e = num / max(den, 1)
    means = np.array([resid[idx].mean() for idx in groups])
    ns = np.array([len(idx) for idx in groups])
    s2u = max(float(np.var(means, ddof=1) - s2e * np.mean(1.0 / ns)), 0.0)
    theta = 1.0 - np.sqrt(s2e / (s2e + ns * s2u)) if s2u > 0 else np.zeros(G)
    Xs, ys = X.copy(), y.copy()
    for i, idx in enumerate(groups):
        Xs[idx] = Xs[idx] - theta[i] * Xs[idx].mean(axis=0)
        ys[idx] = ys[idx] - theta[i] * ys[idx].mean()
    xtx_inv = np.linalg.inv(Xs.T @ Xs)
    beta = xtx_inv @ (Xs.T @ ys)
    r2 = ys - Xs @ beta
    meat = np.zeros((2, 2))
    for idx in groups:
        Xg = Xs[idx]
        w, Q = np.linalg.eigh(np.eye(len(idx)) - Xg @ xtx_inv @ Xg.T)
        adj = Q @ np.diag(1.0 / np.sqrt(np.clip(w, 1e-10, None))) @ Q.T
        s = Xg.T @ (adj @ r2[idx])
        meat += np.outer(s, s)
    V = xtx_inv @ meat @ xtx_inv
    est, se, df = float(beta[1]), float(np.sqrt(V[1, 1])), G - 1
    tcrit = float(stats.t.ppf(1 - ALPHA / 2, df))
    return Fit(
        term=time,
        estimate=est,
        se=se,
        df=df,
        ci_low=est - tcrit * se,
        ci_high=est + tcrit * se,
        p=float(2 * stats.t.sf(abs(est / se), df)),
        n_participants=G,
        n_obs=len(y),
        model="random_intercept_fgls_cr2",
        converged=True,
        var_intercept=s2u,
        var_slope=float("nan"),
        var_resid=s2e,
    )


def pattern_mixture_slope(data: pd.DataFrame, outcome: str = "score", time: str = "t_weeks") -> dict:
    """Missing-data sensitivity: pattern-mixture model (Hedeker & Gibbons 1997).

    Lets completers and dropouts have different slopes, then reports the slope
    averaged over the observed pattern proportions (delta-method SE, pattern
    proportions treated as fixed). If dropouts have systematically different
    trajectories while observed, this moves away from the MAR estimate.
    `data` needs a 0/1 `dropout` column.
    """
    d = data[["participant_id", outcome, time, "dropout"]].dropna().copy()
    d["dropout"] = d["dropout"].astype(float)
    share = float(d.drop_duplicates("participant_id")["dropout"].mean())
    if share in (0.0, 1.0):
        return {"estimate": float("nan"), "se": float("nan"), "dropout_share": share, "note": "only one pattern present"}
    y = d[outcome].to_numpy(dtype=float)
    groups = d["participant_id"].to_numpy()
    X, _ = _design(d, time, "dropout", ())
    res, ok = _fit_mixed(y, X, groups, time)
    model = "random_slope"
    if not ok:
        res, _ = _fit_mixed(y, X, groups, None)
        model = "random_intercept_fallback"
    if res is None:
        return {"estimate": float("nan"), "se": float("nan"), "dropout_share": share, "note": "model failed"}
    names = list(res.fe_params.index)
    w = np.zeros(len(names))
    w[names.index(time)] = 1.0
    w[names.index(f"{time}:dropout")] = share
    cov = np.asarray(res.cov_params())[: len(names), : len(names)]
    est = float(w @ res.fe_params.to_numpy())
    se = float(np.sqrt(w @ cov @ w))
    return {
        "estimate": est,
        "se": se,
        "ci_low": est - 1.96 * se,
        "ci_high": est + 1.96 * se,
        "dropout_share": share,
        "slope_completers": float(res.fe_params[time]),
        "slope_difference_dropouts": float(res.fe_params[f"{time}:dropout"]),
        "model": model,
        "note": "",
    }


def growth_model_fast(data: pd.DataFrame, outcome: str = "score", time: str = "t_weeks", moderator: str | None = None) -> Fit:
    """The same model and the same REML criterion as growth_model(), computed
    from per-participant sufficient statistics so one fit takes milliseconds.

    Used ONLY by the power simulation, where statsmodels' per-group Python
    loop (about 0.4 s per fit) would cap the grid at a few dozen replicates.
    The estimator of record for real data is growth_model(). Equivalence is
    asserted in tests/test_pipeline.py and re-checked on a subsample of
    replicates in every power run (power_summary.md reports the largest gap).

    Random effects b_i ~ N(0, s2 * L L'), L lower-triangular 2x2, so the
    optimiser is unconstrained and a zero slope variance is an interior point
    (no separate random-intercept fallback is needed).
    """
    from scipy.optimize import minimize

    cols = ["participant_id", outcome, time] + ([moderator] if moderator else [])
    d = data[cols].dropna()
    y = d[outcome].to_numpy(dtype=float)
    Xdf, term = _design(d, time, moderator, ())
    X = Xdf.to_numpy()
    Z = X[:, :2]
    _, g = np.unique(d["participant_id"].to_numpy(), return_inverse=True)
    G, (N, p) = int(g.max()) + 1, X.shape

    def by_group(M: np.ndarray) -> np.ndarray:
        out = np.zeros((G, *M.shape[1:]))
        np.add.at(out, g, M)
        return out

    A = by_group(Z[:, :, None] * Z[:, None, :])  # Z_i'Z_i
    B = by_group(Z[:, :, None] * X[:, None, :])  # Z_i'X_i
    c = by_group(Z * y[:, None])  # Z_i'y_i
    XtX, Xty, yty = X.T @ X, X.T @ y, float(y @ y)
    eye = np.eye(2)

    def parts(theta: np.ndarray):
        L = np.array([[theta[0], 0.0], [theta[1], theta[2]]])
        K = eye + L.T @ A @ L  # [G, 2, 2]
        M = L @ np.linalg.solve(K, np.broadcast_to(L.T, K.shape))
        XVX = XtX - np.einsum("gij,gik,gkl->jl", B, M, B)
        XVy = Xty - np.einsum("gij,gik,gk->j", B, M, c)
        yVy = yty - np.einsum("gi,gik,gk->", c, M, c)
        beta = np.linalg.solve(XVX, XVy)
        rss = yVy - beta @ XVy
        return L, K, XVX, beta, rss

    def neg2ll(theta: np.ndarray) -> float:
        _, K, XVX, _, rss = parts(theta)
        if rss <= 0:
            return 1e12
        return float((N - p) * np.log(rss) + np.log(np.linalg.det(K)).sum() + np.linalg.slogdet(XVX)[1])

    starts = ([1.0, 0.0, 0.1], [0.5, 0.0, 0.02])
    best = min((minimize(neg2ll, np.array(s), method="BFGS") for s in starts), key=lambda r: r.fun)
    L, _, XVX, beta, rss = parts(best.x)
    s2 = rss / (N - p)
    cov = s2 * np.linalg.inv(XVX)
    D = s2 * (L @ L.T)
    idx = list(Xdf.columns).index(term)
    est, se, df = float(beta[idx]), float(np.sqrt(cov[idx, idx])), max(G - 1, 1)
    tcrit = float(stats.t.ppf(1 - ALPHA / 2, df))
    return Fit(
        term=term,
        estimate=est,
        se=se,
        df=df,
        ci_low=est - tcrit * se,
        ci_high=est + tcrit * se,
        p=float(2 * stats.t.sf(abs(est / se), df)),
        n_participants=G,
        n_obs=N,
        model="random_slope_fast_reml",
        converged=True,
        var_intercept=float(D[0, 0]),
        var_slope=float(D[1, 1]),
        var_resid=float(s2),
    )
