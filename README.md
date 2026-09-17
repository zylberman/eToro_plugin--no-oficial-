# eToro ATR, Fourier and Wavelet Assistant

## Overview

This browser extension is an experimental market-analysis tool for eToro. It combines ATR(14), logarithmic Fourier analysis, Haar Wavelet zones, TP/SL planning, cost estimates, market filters, historical calibration and a multi-asset opportunity scanner.

It downloads closed OHLCV candles from Yahoo Finance and reads executable or visible prices from the eToro page. Yahoo prices are indicative and may differ from eToro CFDs because the feeds, sessions and instruments are not identical.

## Main features

- ATR(14) in price units, percentages and position dollars.
- Automatic symbol and timeframe detection.
- eToro bid/ask monitoring with Yahoo Finance as historical-data source and fallback.
- Break-even prices for long and short positions using estimated opening and closing fees.
- Four-column analysis layout plus a separate opportunity scanner.
- Compact Simple mode and full Analysis mode.
- Movable, resizable and minimizable panel with independently scrollable columns.
- Log-price Fourier spectrum, reconstruction and direction for each active harmonic.
- A ten-candle Fourier projection anchored to the latest closed candle, with widening illustrative dispersion bands.
- Haar Wavelet reconstruction and support/resistance zones based on repeated pivots.
- Up to four supports and four resistances beyond the recommended ATR distance.
- TP/SL combination search across Wavelet zones.
- ATR fallback plan when no usable Wavelet target exists: TP is at least 1.5 times SL and is increased when needed to cover costs.
- Historical walk-forward calibration in exact 0.01 increments with chronological 80% training, 10% test and 10% validation splits.
- Market context from approximate ADX, directional efficiency, relative volume, rolling VWAP and historical ATR percentile.
- Diagnostic JSON export containing candles, calculations, projections, zones, costs, decisions and scanner output. It excludes account identifiers, email, total balance and personal data.

## “Worth opening?” rule

The main decision and the scanner share one rule. Assuming the Fourier trajectory is fulfilled, a setup is considered viable only when:

1. Fourier reaches the selected TP in the selected direction within the next ten candles.
2. A valid TP and SL plan exists.
3. SL distance is at least 1.50 ATR, outside ordinary candle noise.
4. TP/SL is at least 1.5.
5. Gross potential profit is at least twice the estimated round-trip opening and closing cost.

Wavelet supplies structural target and stop zones. If a complete Wavelet pair is unavailable, the extension clearly labels an ATR/RR fallback. Volume, regime and ATR percentile affect the risk ranking but do not independently veto an otherwise viable setup.

The scanner sorts low-, medium- and high-risk setups in that order. Within each level, it favors the highest potential net reward relative to loss and costs. Missing or unknown fees prevent an affirmative entry decision.

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

The extension removes a logarithmic linear trend, decomposes the residual series into spectral components and reconstructs the selected dominant harmonics with their amplitude and phase. The forecast continues those fitted components from the last real close; it does not replay the original price curve exactly.

Fourier extrapolation assumes that recently observed cycles persist. Abrupt news, gaps, regime changes and non-stationary behavior can invalidate that assumption. The dispersion band is illustrative and is not a calibrated confidence interval.

## Wavelet interpretation

The Haar transform separates price behavior across multiple time scales. Reconstructed pivots are grouped into zones whose width depends on ATR. More contacts and greater recency increase a zone score, but that score is not a probability of success. Zones are ranges because market reactions normally occur across an area rather than at one exact price.

## Historical calibration

Up to 60 chronological historical cuts are produced. Each sample uses only prior candles and freezes the calculation before observing the following outcome window. Coordinate descent adjusts Fourier, Wavelet, alignment and threshold parameters in increments of 0.01 using only the training partition. Test and validation data are kept chronologically later.

Calibration metrics describe the downloaded sample only. They are not guaranteed future probabilities.

## Data and fee limitations

Fee profiles are estimates based on eToro’s published fee pages. Always confirm the execution ticket because fees, spreads, financing, currency conversion, taxes and slippage may change or may not be represented.

The current price priority is:

1. eToro executable Sell/Buy prices.
2. The latest visible eToro chart candle.
3. The latest Yahoo Finance close as a fallback.

The open candle is kept separate and excluded from ATR, Fourier, Wavelet and calibration until it closes.

## Files

- `manifest.json`: Manifest V3 configuration and network permissions.
- `background.js`: Network proxy for historical Yahoo Finance requests.
- `analytics.js`: Pure calculations for fees, ATR-based plans, Fourier, Wavelet, filters, calibration and ranking.
- `content.js`: eToro page integration, UI, scanner and diagnostic export.
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
npm test
```

## Disclaimer

This software is intended for education and technical analysis. It does not provide financial advice and cannot guarantee a Fourier projection, Wavelet level, TP, SL, profit or loss. Trading involves substantial risk. Verify all prices and costs in the eToro order ticket before acting.
