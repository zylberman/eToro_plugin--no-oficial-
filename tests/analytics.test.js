const assert = require('node:assert/strict');
const test = require('node:test');
const {
    calculateBreakEvenTP, getEtoroFeeProfile, calculateTradePlan, calculateMultiLevelTradePlan, estimateTrendBreak,
    haarTransitionScore, haarScalogram, haarDecompose,
    haarReconstruct, haarWaveletAnalysis, findWaveletZones,
    analyzeCombined, calibrateCombinedModel
} = require('../analytics.js');

test('long TP covers percentage and fixed round-trip costs', () => {
    const result = calculateBreakEvenTP({
        side: 'long', entryPrice: 100, investment: 1000, leverage: 2,
        spreadPercent: 0.2, openFeePercent: 0.1, closeFeePercent: 0.1,
        fixedOpenFee: 1, fixedCloseFee: 1, financingCost: 2
    });
    assert.equal(result.ok, true);
    const grossProfit = result.units * (result.targetPrice - 100);
    assert.ok(Math.abs(grossProfit - result.estimatedCostAtTarget) < 1e-8);
});

test('short TP covers percentage and fixed round-trip costs', () => {
    const result = calculateBreakEvenTP({
        side: 'short', entryPrice: 100, investment: 1000, leverage: 2,
        spreadPercent: 0.2, openFeePercent: 0.1, closeFeePercent: 0.1,
        fixedOpenFee: 1, fixedCloseFee: 1, financingCost: 2
    });
    assert.equal(result.ok, true);
    const grossProfit = result.units * (100 - result.targetPrice);
    assert.ok(Math.abs(grossProfit - result.estimatedCostAtTarget) < 1e-8);
});

test('leverage reduces the price move needed to cover fixed costs', () => {
    const base = { side: 'long', entryPrice: 50, investment: 500, fixedOpenFee: 5, fixedCloseFee: 5 };
    const x1 = calculateBreakEvenTP({ ...base, leverage: 1 });
    const x5 = calculateBreakEvenTP({ ...base, leverage: 5 });
    assert.ok(x5.distancePercent < x1.distancePercent);
});

test('official SILVER CFD profile applies 0.03% on opening and closing', () => {
    const fee = getEtoroFeeProfile('SILVER', 10);
    assert.equal(fee.known, true);
    assert.equal(fee.openFeePercent, 0.03);
    assert.equal(fee.closeFeePercent, 0.03);
    const result = calculateBreakEvenTP({
        side: 'long', entryPrice: 63.5, investment: 10, leverage: 10,
        openFeePercent: fee.openFeePercent, closeFeePercent: fee.closeFeePercent
    });
    assert.ok(Math.abs(result.estimatedCostAtTarget - 0.06) < 0.001);
});

test('long trade plan compares resistance target against buffered support stop', () => {
    const result = calculateTradePlan({
        side: 'long', entryPrice: 100, investment: 1000, leverage: 2, atr: 2,
        support: { low: 96, high: 97 }, resistance: { low: 108, high: 109 },
        openFeePercent: 0.15, stopBufferAtr: 0.1
    });
    assert.equal(result.ok, true);
    assert.equal(result.technicalTarget, 108);
    assert.equal(result.technicalStop, 95.8);
    assert.equal(result.targetFartherThanStop, true);
    assert.equal(result.targetCoversTwiceOpening, true);
});

test('short trade plan reverses support and resistance roles', () => {
    const result = calculateTradePlan({
        side: 'short', entryPrice: 100, investment: 1000, leverage: 2, atr: 2,
        support: { low: 90, high: 92 }, resistance: { low: 104, high: 105 },
        openFeePercent: 0.15, stopBufferAtr: 0.1
    });
    assert.equal(result.ok, true);
    assert.equal(result.technicalTarget, 92);
    assert.equal(result.technicalStop, 105.2);
    assert.equal(result.costTarget, 99.7);
});

test('minimum plan strictly satisfies ATR, distance and opening-cost rules', () => {
    const result = calculateTradePlan({
        side: 'long', entryPrice: 100, investment: 1000, leverage: 2, atr: 2,
        support: { low: 99, high: 99.5 }, resistance: { low: 110, high: 111 },
        openFeePercent: 0.15, recommendedAtrMultiple: 1.5, openingCostMultiple: 2
    });
    assert.equal(result.ok, true);
    assert.ok(result.stopDistance > 2);
    assert.ok(result.targetDistance > result.stopDistance);
    assert.ok(result.potentialProfit > result.minimumProfit);
    assert.equal(result.targetFartherThanStop, true);
    assert.equal(result.targetCoversTwiceOpening, true);
    assert.equal(result.stopExceedsAtr, true);
});

test('multi-level long plan orders several targets and stops by proximity', () => {
    const result = calculateMultiLevelTradePlan({
        side: 'long', entryPrice: 100, investment: 1000, leverage: 2, atr: 2,
        supports: [
            { low: 90, high: 91, center: 90.5, strength: 0.8 },
            { low: 96, high: 97, center: 96.5, strength: 0.9 }
        ],
        resistances: [
            { low: 112, high: 113, center: 112.5, strength: 0.7 },
            { low: 105, high: 106, center: 105.5, strength: 0.9 }
        ],
        openFeePercent: 0.15, maxLevels: 4
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.targets.map(target => target.price), [105, 112]);
    assert.deepEqual(result.stops.map(stop => stop.price), [95.8, 89.8]);
    assert.ok(result.targets[1].rewardRisk > result.targets[0].rewardRisk);
});

test('multi-level short plan swaps target and stop zone lists', () => {
    const result = calculateMultiLevelTradePlan({
        side: 'short', entryPrice: 100, investment: 1000, leverage: 1, atr: 1,
        supports: [
            { low: 93, high: 94, center: 93.5, strength: 0.8 },
            { low: 97, high: 98, center: 97.5, strength: 0.9 }
        ],
        resistances: [
            { low: 102, high: 103, center: 102.5, strength: 0.9 },
            { low: 106, high: 107, center: 106.5, strength: 0.7 }
        ]
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.targets.map(target => target.price), [98, 94]);
    assert.deepEqual(result.stops.map(stop => stop.price), [103.1, 107.1]);
});

test('Haar score reacts to a recent regime change', () => {
    const quiet = Array.from({ length: 96 }, (_, i) => 100 + Math.sin(i / 5) * 0.05);
    const changed = quiet.map((value, i) => i < 92 ? value : value + (i - 91) * 0.8);
    assert.ok(haarTransitionScore(changed).score > haarTransitionScore(quiet).score);
});

test('Haar scalogram creates one causal row per scale', () => {
    const prices = Array.from({ length: 64 }, (_, i) => 100 + Math.sin(i / 4));
    const result = haarScalogram(prices, [2, 4, 8, 16]);
    assert.deepEqual(result.scales, [2, 4, 8, 16]);
    assert.equal(result.rows.length, 4);
    assert.ok(result.rows.every(row => row.length === prices.length));
    assert.ok(result.cap > 0);
});

test('Haar reconstruction is exact when every component is selected', () => {
    const prices = Array.from({ length: 128 }, (_, i) => 50 + i * 0.02 + Math.sin(i / 7));
    const decomposition = haarDecompose(prices);
    const reconstruction = haarReconstruct(decomposition);
    assert.equal(reconstruction.length, prices.length);
    reconstruction.forEach((value, index) => assert.ok(Math.abs(value - prices[index]) < 1e-10));
});

test('Wavelet component count controls the reconstruction', () => {
    const prices = Array.from({ length: 128 }, (_, i) => 50 + Math.sin(i / 3) + Math.sin(i / 17));
    const one = haarWaveletAnalysis(prices, 1);
    const three = haarWaveletAnalysis(prices, 3);
    assert.equal(one.selected.length, 1);
    assert.equal(three.selected.length, 3);
    assert.notDeepEqual(one.reconstruction, three.reconstruction);
});

test('Wavelet zones expose support and resistance candidates', () => {
    const prices = Array.from({ length: 128 }, (_, i) => 100 + Math.sin((2 * Math.PI * i) / 24));
    const zones = findWaveletZones(prices, 0.5);
    assert.ok(zones.supports.length > 0);
    assert.ok(zones.resistances.length > 0);
    assert.ok(zones.supports.every(zone => zone.low < zone.high));
});

test('combined analysis returns a bounded alignment score', () => {
    const prices = Array.from({ length: 128 }, (_, i) => 100 + i * 0.01 + Math.sin((2 * Math.PI * i) / 32));
    const result = analyzeCombined(prices, 0.6);
    assert.ok(result.score >= 0 && result.score <= 1);
    assert.ok(Array.isArray(result.zones.supports));
});

test('historical calibration changes constants only in 0.01 steps', () => {
    const prices = Array.from({ length: 520 }, (_, i) => 100 + Math.sin((2 * Math.PI * i) / 32) + 0.25 * Math.sin(i / 5));
    const result = calibrateCombinedModel(prices, { maxSamples: 18, minimumSamples: 10, horizon: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.splits.train.count, result.samples * 0.8);
    assert.equal(result.splits.test.count, result.samples * 0.1);
    assert.equal(result.splits.validation.count, result.samples * 0.1);
    assert.equal(result.splits.train.count + result.splits.test.count + result.splits.validation.count, result.samples);
    for (const name of ['fourierWeight', 'waveletWeight', 'alignmentWeight', 'signalThreshold']) {
        assert.ok(Math.abs(result.params[name] * 100 - Math.round(result.params[name] * 100)) < 1e-9);
    }
});

test('trend-break estimator returns a bounded exploratory forecast', () => {
    const prices = Array.from({ length: 128 }, (_, i) => 100 + i * 0.03 + Math.sin((2 * Math.PI * i) / 24));
    const result = estimateTrendBreak(prices, 0.8, { horizon: 24, harmonics: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.forecast.length, 25);
    if (result.candidate) assert.ok(result.candidate.bars >= 2 && result.candidate.bars <= 23);
});
