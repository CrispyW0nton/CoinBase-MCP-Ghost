# Grinold & Kahn — *Active Portfolio Management*

**Why it matters here:** how skill turns into sized bets — the link between
signal quality and position size.

## Core: The Fundamental Law of Active Management
- **IR ≈ IC · √breadth** (Information Ratio ≈ skill × √(independent bets)).
- **MCP rule:** scale `kellyFraction` with the signal's measured **IC** and the
  **breadth** of independent opportunities — not with momentary conviction.

## Alpha & forecasting (early chapters)
- Refine raw signals into expected residual returns (alpha = volatility · IC ·
  score). Shrink toward zero when skill is uncertain (ties to Kahneman).

## Risk & portfolio construction
- Optimize expected residual return vs residual risk; respect the risk model's
  covariance (mirrors Chan's `F = C⁻¹M`).
- Transaction costs reduce realized alpha → trade only when expected alpha
  exceeds cost (Harris).

## Performance analysis
- Attribute returns to skill vs luck; an honest IR estimate prevents
  overconfidence in sizing.

> Cross-ref `03-chan...md` (Kelly), `07-harris...md` (costs), `15-kahneman...md`.
