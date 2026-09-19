# eToro ATR, Fourier and Wavelet Assistant

## Overview

This browser extension is a focused market-analysis panel for eToro. A single shared price chart overlays the original closed-candle series, logarithmic Fourier reconstruction, Haar Wavelet reconstruction and a twenty-candle Fourier projection with dispersion.

It downloads closed OHLCV candles from Yahoo Finance and reads executable or visible prices from the eToro page. Yahoo history is translated by the current price difference rather than multiplied, avoiding artificial ATR scaling. Closed eToro candles observed while the page is open are cached locally and replace matching proxy candles over time. The remaining Yahoo history is still indicative and may differ from the eToro CFD because the feeds, sessions and instruments are not identical.

## Main features

- ATR(14) in price units, percentages and position dollars.
- Automatic symbol and timeframe detection.
- eToro bid/ask monitoring with Yahoo Finance as historical-data source and fallback.
- One unified price chart with actual, Fourier, Wavelet and projected values on the same scale.
- Movable, resizable, minimizable and vertically scrollable panel.
- Log-price Fourier spectrum, reconstruction and direction for each active harmonic.
- A selectable-horizon Fourier projection that preserves its measured endpoint error instead of being visually forced onto the latest close.
- Hann-windowed spectra, adaptive 64/96/128-candle fitting, chronological validation and an empirical widening error band.
- Fourier is disabled when dominant period, direction, normalized amplitude or phase are unstable across the available windows.
- Every retained harmonic is shown as a cumulative F1…Fn reconstruction; requested harmonics rejected by chronological validation are explicitly identified instead of silently drawn.
- A discrepancy panel compares the adjusted historical close with eToro, the raw Yahoo basis, executable spread, Fourier fit error, endpoint error and validation accuracy.
- Intraday consensus is blocked when the latest closed historical candle is more than 1.5 timeframe bars old; stale projections remain visible only as diagnostics.
- Projection harmonics must have a period of at least ten candles, reducing short-cycle noise and Fourier overfitting.
- Directional ATR, TP and SL levels are drawn for the side indicated by the current trend.
- Selectable historical window and Fourier projection horizon.
- Independent chart switches for Fourier, ATR, TP and SL overlays.
- Selectable OHLC candlesticks or close-price line.
- Auto, Buy/LONG or Sell/SHORT chart direction; directional ATR, TP and SL follow the selected side.
- Chronological Fourier simulator: the first 80% selects the harmonic count and minimum period, the next 10% is a fixed-parameter test, and the final 10% is an untouched out-of-sample holdout.
- Configurable Fourier outcome rule: maximum candles after prediction and target distance in ATR; reports projected/actual arrival time, wins, losses and score (`+1` win, `-2` loss, `0` unresolved).
- Downloadable JSON comparison containing original Yahoo candles, plugin-aligned candles, observed eToro OHLC/quotes, chart settings and calculated indicators for the active timeframe.
- Unsupported native Yahoo intervals are constructed from complete lower-timeframe OHLC groups (for example, eToro 10m from two closed Yahoo 5m candles); irregular/current quote points are excluded from indicators.
- Haar Wavelet reconstruction with one pivot per plateau, OHLC confirmation, separated contacts, bounce/break classification and explicit temporal decay.
- Up to four supports and four resistances beyond the recommended ATR distance.
- TP/SL combination search across Wavelet zones.
- ATR fallback plan when no usable Wavelet target exists: TP is at least 1.5 times SL and is increased when needed to cover costs.
- Rolling VWAP(21) when volume is available and a 16-candle logarithmic trend.
- Direction and nearest estimated turn, in candles, for every selected Fourier harmonic.
- Simultaneous long and short TP/SL combinations with entry, TP, SL, dollar gain/loss, opening-plus-closing cost and remaining profit margin.

## Trade-plan information

Wavelet supplies structural target and stop zones beyond the recommended 1.50 ATR distance. The panel evaluates the available support/resistance combinations for both long and short positions. If a complete Wavelet pair is unavailable, it labels an ATR/RR fallback.

Each combination reports the executable entry reference, TP and SL prices, their dollar difference for the configured investment and leverage, reward/risk, estimated opening-plus-closing cost and profit margin after those costs. Unknown fees are shown as unverified rather than treated as zero.

## TP and SL calculations

For a position with investment `I`, leverage `L`, entry price `P` and price distance `D`:

```text
exposure = I × L
units = exposure / P
dollar result = units × D
```

For a long position, Wavelet resistances are TP candidates and supports are SL candidates. For a short position, supports are TP candidates and resistances are SL candidates. A 0.10 ATR structural buffer is added to stops. Candidate pairs must satisfy the ATR, reward/risk and cost constraints before ranking.

When eToro only accepts TP or SL as a dollar amount, the extension displays both the corresponding price and the estimated dollar gain or loss.

## Fourier interpretation

The extension removes a logarithmic linear trend, applies a Hann window and decomposes the residual series into spectral components. It selects the harmonic count by chronological validation rather than magnitude alone, compares dominant period, direction, normalized amplitude and phase across 64, 96 and 128 candles, and disables the signal when those windows disagree. The forecast continues the fitted model without forcing its first point onto the latest price, so the visible endpoint error remains honest.

Fourier extrapolation assumes that recently observed cycles persist. Abrupt news, gaps, regime changes and non-stationary behavior can invalidate that assumption. The widening band uses the 90th percentile of chronological validation errors; it is empirical, but its small and overlapping sample does not make it a formal confidence interval.

The simulator reports next-candle directional accuracy and mean price error. Its “Real” block means the final historical holdout was not used for parameter selection; it is not live trading performance and does not include execution slippage.

## Wavelet interpretation

The Haar transform separates price behavior across multiple time scales. A flat reconstructed plateau contributes only one pivot, and the original OHLC high or low must confirm it. Contacts must be separated by a minimum number of candles; later price action classifies each contact as a bounce, break or unconfirmed event. Scores use explicit exponential time decay, while the reported regime distinguishes range behavior from upward or downward breaks. The score is not a probability of success.

## Data and fee limitations

Fee profiles are estimates based on eToro’s published fee pages. Always confirm the execution ticket because fees, spreads, financing, currency conversion, taxes and slippage may change or may not be represented.

The current price priority is:

1. eToro executable Sell/Buy prices.
2. The latest visible eToro chart candle.
3. The latest Yahoo Finance close as a fallback.

The open candle is kept separate and excluded from ATR, Fourier and Wavelet until it closes.

## Files

- `manifest.json`: Manifest V3 configuration and network permissions.
- `background.js`: Network proxy for historical Yahoo Finance requests.
- `analytics.js`: Pure calculations for fees, ATR-based plans, Fourier, Wavelet and market metrics.
- `content.js`: eToro page integration and the unified-chart interface.
- `style.css`: Panel layout and visual states.
- `tests/analytics.test.js`: Unit tests for analytical and risk calculations.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions/` or `edge://extensions/`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select this repository folder.
5. Reload the extension after updating the local files.
6. Open an eToro market chart and press the extension’s refresh button.

## Testing

```bash
node --test tests/analytics.test.js
```

## Disclaimer

This software is intended for education and technical analysis. It does not provide financial advice and cannot guarantee a Fourier projection, Wavelet level, TP, SL, profit or loss. Trading involves substantial risk. Verify all prices and costs in the eToro order ticket before acting.
