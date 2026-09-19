(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EToroAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
    const EPSILON = 1e-12;

    function finiteNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    /**
     * Calculates the price at which gross P/L covers the configured round-trip
     * trading costs. Percentages are expressed as percentages (0.15 = 0.15%).
     * Spread is treated as a round-trip percentage of the opening notional.
     */
    function calculateBreakEvenTP(options) {
        const side = options?.side === 'short' ? 'short' : 'long';
        const entryPrice = finiteNumber(options?.entryPrice, NaN);
        const investment = finiteNumber(options?.investment, NaN);
        const leverage = finiteNumber(options?.leverage, NaN);
        const spreadRate = Math.max(0, finiteNumber(options?.spreadPercent)) / 100;
        const openRate = Math.max(0, finiteNumber(options?.openFeePercent)) / 100;
        const closeRate = Math.max(0, finiteNumber(options?.closeFeePercent)) / 100;
        const fixedCosts = Math.max(0, finiteNumber(options?.fixedOpenFee))
            + Math.max(0, finiteNumber(options?.fixedCloseFee))
            + Math.max(0, finiteNumber(options?.financingCost))
            + Math.max(0, finiteNumber(options?.safetyBuffer));

        if (!(entryPrice > 0) || !(investment > 0) || !(leverage > 0)) {
            return { ok: false, error: 'Price, investment and leverage must be greater than zero.' };
        }

        const exposure = investment * leverage;
        const units = exposure / entryPrice;
        const openingVariableCost = exposure * (spreadRate + openRate);
        let targetPrice;

        if (side === 'long') {
            const denominator = units * (1 - closeRate);
            if (denominator <= EPSILON) return { ok: false, error: 'The closing fee must be below 100%.' };
            targetPrice = (units * entryPrice + openingVariableCost + fixedCosts) / denominator;
        } else {
            const denominator = units * (1 + closeRate);
            targetPrice = (units * entryPrice - openingVariableCost - fixedCosts) / denominator;
            if (targetPrice <= 0) return { ok: false, error: 'Costs exceed the possible value of the short position.' };
        }

        const distance = Math.abs(targetPrice - entryPrice);
        return {
            ok: true,
            side,
            entryPrice,
            targetPrice,
            distance,
            distancePercent: (distance / entryPrice) * 100,
            exposure,
            units,
            estimatedCostAtTarget: openingVariableCost + fixedCosts + units * targetPrice * closeRate
        };
    }

    const CFD_FEE_BY_SYMBOL = Object.freeze({
        OIL: 0.04, EUROOIL: 0.04, GOLD: 0.01, SILVER: 0.03,
        COPPER: 0.1, NATGAS: 0.1, PLATINUM: 0.1, PALLADIUM: 0.1,
        SPX500: 0.007, NSDQ100: 0.007, DJ30: 0.007, GER40: 0.007,
        JPN225: 0.005, USDOLLAR: 0.01, UK100: 0.01, FRA40: 0.01,
        AUS200: 0.01, ESP35: 0.01, HKG50: 0.01, EUSTX50: 0.01,
        CHINA50: 0.01, RTY: 0.01, CRYPTO10: 0.5
    });

    const CRYPTO_SYMBOLS = new Set([
        'BTC', 'ETH', 'BCH', 'XRP', 'DASH', 'LTC', 'ETC', 'ADA', 'SOL',
        'DOGE', 'DOT', 'LINK', 'AVAX', 'MATIC', 'SHIB', 'UNI', 'ATOM'
    ]);

    /** Official eToro CFD spreads, expressed as percentage per side/trade. */
    function getEtoroFeeProfile(symbol, leverage = 1) {
        const normalized = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (CFD_FEE_BY_SYMBOL[normalized] !== undefined) {
            const rate = CFD_FEE_BY_SYMBOL[normalized];
            return { known: true, openFeePercent: rate, closeFeePercent: rate, label: `CFD ${rate}% per side` };
        }
        if (CRYPTO_SYMBOLS.has(normalized)) {
            return { known: true, openFeePercent: 1, closeFeePercent: 1, label: 'Crypto/CFD base rate: 1% per side (before Club discount)' };
        }
        if (/^[A-Z]{6}$/.test(normalized)) {
            return { known: true, openFeePercent: 0.005, closeFeePercent: 0.005, label: 'Currency CFD: 0.005% per side' };
        }
        if (finiteNumber(leverage, 1) > 1) {
            return { known: true, openFeePercent: 0.15, closeFeePercent: 0.15, label: 'Estimated stock/ETF CFD: 0.15% per side' };
        }
        return {
            known: false, openFeePercent: 0, closeFeePercent: 0,
            label: 'Unknown fee profile: verify the estimated cost in eToro'
        };
    }

    function calculateTradePlan(options) {
        const side = options?.side === 'short' ? 'short' : 'long';
        const entryPrice = finiteNumber(options?.entryPrice, NaN);
        const investment = finiteNumber(options?.investment, NaN);
        const leverage = finiteNumber(options?.leverage, NaN);
        const atr = finiteNumber(options?.atr, NaN);
        const support = options?.support;
        const resistance = options?.resistance;
        const openFeeRate = Math.max(0, finiteNumber(options?.openFeePercent)) / 100;
        const stopBufferAtr = Math.max(0, finiteNumber(options?.stopBufferAtr, 0.10));
        const recommendedAtrMultiple = Math.max(1.01, finiteNumber(options?.recommendedAtrMultiple, 1.50));
        const openingCostMultiple = Math.max(1.01, finiteNumber(options?.openingCostMultiple, 2));
        if (!(entryPrice > 0) || !(investment > 0) || !(leverage > 0) || !(atr > 0)) {
            return { ok: false, error: 'Price, investment, leverage or ATR is missing.' };
        }
        if (!support || !resistance) return { ok: false, error: 'There are not enough Wavelet support and resistance zones.' };
        const exposure = investment * leverage;
        const units = exposure / entryPrice;
        const openingCost = exposure * openFeeRate;
        const minimumProfit = openingCost * openingCostMultiple;
        const technicalTarget = side === 'long' ? resistance.low : support.high;
        const structuralStop = side === 'long'
            ? support.low - atr * stopBufferAtr
            : resistance.high + atr * stopBufferAtr;
        const structuralStopDistance = side === 'long' ? entryPrice - structuralStop : structuralStop - entryPrice;
        const recommendedAtrDistance = atr * recommendedAtrMultiple;
        const stopDistance = Math.max(structuralStopDistance, recommendedAtrDistance * 1.01);
        const technicalStop = side === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance;
        const roundTripCost = exposure * openFeeRate * 2;
        const costDistance = Math.max(minimumProfit, roundTripCost) / units;
        const targetDistance = Math.max(stopDistance * 1.01, costDistance * 1.01);
        const minimumTarget = side === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance;
        const technicalTargetDistance = side === 'long' ? technicalTarget - entryPrice : entryPrice - technicalTarget;
        if (!(technicalTargetDistance > 0) || !(structuralStopDistance > 0)) {
            return { ok: false, error: 'The price is outside the usable technical zones.' };
        }
        const costTarget = side === 'long'
            ? entryPrice + costDistance
            : entryPrice - costDistance;
        const potentialProfit = units * targetDistance;
        const potentialLoss = units * stopDistance;
        const rewardRisk = targetDistance / stopDistance;
        return {
            ok: true, side, entryPrice, technicalTarget, technicalStop, structuralStop,
            minimumTarget, costTarget, recommendedAtrDistance, recommendedAtrMultiple,
            targetDistance, stopDistance,
            technicalTargetDistance,
            targetPercent: targetDistance / entryPrice * 100,
            stopPercent: stopDistance / entryPrice * 100,
            potentialProfit, potentialLoss, rewardRisk, openingCost, minimumProfit,
            targetFartherThanStop: targetDistance > stopDistance,
            stopExceedsAtr: stopDistance > recommendedAtrDistance,
            targetCoversTwiceOpening: potentialProfit > minimumProfit,
            technicalRoomIsEnough: technicalTargetDistance >= targetDistance
        };
    }

    function calculateTicketRiskLevels(options) {
        const side = options?.side === 'short' ? 'short' : 'long';
        const entryPrice = finiteNumber(options?.entryPrice, NaN);
        const investment = finiteNumber(options?.investment, NaN);
        const leverage = finiteNumber(options?.leverage, NaN);
        const atr = finiteNumber(options?.atr, NaN);
        const atrMultiple = Math.max(1, finiteNumber(options?.atrMultiple, 1.50));
        const targetPrice = finiteNumber(options?.targetPrice, NaN);
        const stopPrice = finiteNumber(options?.stopPrice, NaN);
        if (!(entryPrice > 0) || !(investment > 0) || !(leverage > 0) || !(atr > 0)) {
            return { ok: false, error: 'Price, investment, leverage or ATR is missing.' };
        }
        const units = investment * leverage / entryPrice;
        const priceForDistance = (distance, direction) => direction === 'up'
            ? entryPrice + distance
            : entryPrice - distance;
        const atrMoney = units * atr;
        const recommendedDistance = atr * atrMultiple;
        const recommendedMoney = units * recommendedDistance;
        const stopDistance = Number.isFinite(stopPrice) ? Math.abs(stopPrice - entryPrice) : NaN;
        const targetDistance = Number.isFinite(targetPrice) ? Math.abs(targetPrice - entryPrice) : NaN;
        return {
            ok: true, side, units, atrMoney, atrMultiple,
            recommendedDistance, recommendedMoney,
            atrBoundaryPrice: priceForDistance(recommendedDistance, side === 'long' ? 'down' : 'up'),
            targetAmount: Number.isFinite(targetDistance) ? units * targetDistance : NaN,
            stopAmount: Number.isFinite(stopDistance) ? units * stopDistance : NaN,
            targetDistance, stopDistance,
            stopOutsideAtr: Number.isFinite(stopDistance) && stopDistance > recommendedDistance
        };
    }

    function analyzeCostAdjustedExcursion(prices, options = {}) {
        const values = (Array.isArray(prices) ? prices : []).map(Number)
            .filter(value => Number.isFinite(value) && value > 0);
        const side = options.side === 'short' ? 'short' : 'long';
        const horizonBars = Math.max(1, Math.floor(finiteNumber(options.horizonBars, 10)));
        const lookback = Math.max(30, Math.floor(finiteNumber(options.lookback, 200)));
        const investment = finiteNumber(options.investment, NaN);
        const leverage = finiteNumber(options.leverage, NaN);
        const openingCost = Math.max(0, finiteNumber(options.openingCost));
        const roundTripCost = Math.max(openingCost, finiteNumber(options.roundTripCost, openingCost));
        const requiredNetMultiple = Math.max(1, finiteNumber(options.requiredNetMultiple, 2));
        if (values.length < horizonBars + 30 || !(investment > 0) || !(leverage > 0)) {
            return { ok: false, error: 'Insufficient history or invalid position inputs for cost-adjusted excursion.' };
        }
        const exposure = investment * leverage;
        const requiredNetProfit = openingCost * requiredNetMultiple;
        const requiredGrossProfit = roundTripCost + requiredNetProfit;
        const requiredReturn = requiredGrossProfit / exposure;
        const samples = [];
        const start = Math.max(0, values.length - horizonBars - lookback);
        for (let index = start; index < values.length - horizonBars; index++) {
            const entry = values[index];
            let bestReturn = 0;
            let hitBar = null;
            for (let step = 1; step <= horizonBars; step++) {
                const rawReturn = side === 'long'
                    ? values[index + step] / entry - 1
                    : 1 - values[index + step] / entry;
                bestReturn = Math.max(bestReturn, rawReturn);
                if (hitBar === null && rawReturn >= requiredReturn) hitBar = step;
            }
            samples.push({ favorableReturn: bestReturn, grossProfit: exposure * bestReturn, hitBar });
        }
        const grossProfits = samples.map(sample => sample.grossProfit).sort((a, b) => a - b);
        const hitBars = samples.filter(sample => sample.hitBar !== null).map(sample => sample.hitBar);
        const hitRate = hitBars.length / samples.length;
        const medianGrossProfit = median(grossProfits);
        const medianHitBars = hitBars.length ? median(hitBars) : null;
        const minimumHitRate = Math.max(0, Math.min(1, finiteNumber(options.minimumHitRate, 0.55)));
        return {
            ok: true, side, horizonBars, samples: samples.length, exposure,
            openingCost, roundTripCost, requiredNetMultiple,
            requiredNetProfit, requiredGrossProfit, requiredReturn,
            medianGrossProfit, medianNetProfit: medianGrossProfit - roundTripCost,
            hitRate, medianHitBars, minimumHitRate,
            viable: hitRate >= minimumHitRate && medianGrossProfit >= requiredGrossProfit
        };
    }

    function calculateOpportunityRisk(options = {}) {
        const investment = Math.max(EPSILON, finiteNumber(options.investment, 0));
        const potentialLoss = Math.max(0, finiteNumber(options.potentialLoss, 0));
        const potentialProfit = Math.max(0, finiteNumber(options.potentialProfit, 0));
        const feeKnown = options.feeKnown === true;
        const roundTripCost = feeKnown ? Math.max(0, finiteNumber(options.roundTripCost, 0)) : null;
        const confirmations = Math.max(0, Math.min(6, finiteNumber(options.confirmations, 0)));
        const atrPercentile = Math.max(0, Math.min(100, finiteNumber(options.atrPercentile, 100))) / 100;
        const excursionHitRate = Math.max(0, Math.min(1, finiteNumber(options.excursionHitRate, 0)));
        if (!(potentialLoss > 0)) {
            return { riskScore: 1, riskLevel: 'high', netProfit: null, opportunityScore: -5 };
        }
        const lossRatio = potentialLoss / investment;
        const riskScore = Math.min(1,
            lossRatio * 15
            + atrPercentile * 0.30
            + (options.fallback ? 0.12 : 0)
            + ((6 - confirmations) / 6) * 0.18
            + (1 - excursionHitRate) * 0.15
            + (feeKnown ? 0 : 0.10)
        );
        const riskLevel = riskScore <= 0.35 ? 'low' : riskScore <= 0.60 ? 'medium' : 'high';
        const netProfit = roundTripCost === null ? null : potentialProfit - roundTripCost;
        const rankingProfit = netProfit === null ? potentialProfit * 0.75 : netProfit;
        const opportunityScore = Math.max(-5, rankingProfit / Math.max(0.01, potentialLoss + (roundTripCost || 0)))
            * (0.5 + confirmations / 12) * (1 - riskScore * 0.65);
        return { riskScore, riskLevel, netProfit, opportunityScore };
    }

    function analyzeMarketFilters(candles, options = {}) {
        const period = Math.max(5, Math.floor(finiteNumber(options.period, 14)));
        const historyWindow = Math.max(20, Math.floor(finiteNumber(options.historyWindow, 200)));
        const rows = (Array.isArray(candles) ? candles : []).map(row => ({
            h: finiteNumber(row?.h, NaN), l: finiteNumber(row?.l, NaN), c: finiteNumber(row?.c, NaN),
            v: finiteNumber(row?.v, NaN)
        })).filter(row => Number.isFinite(row.h) && Number.isFinite(row.l) && Number.isFinite(row.c));
        if (rows.length < period * 2 + 1) return { ok: false, error: `At least ${period * 2 + 1} OHLC candles are required.` };
        const tr = [], plusDm = [], minusDm = [];
        for (let i = 1; i < rows.length; i++) {
            const up = rows[i].h - rows[i - 1].h;
            const down = rows[i - 1].l - rows[i].l;
            tr.push(Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - rows[i - 1].c), Math.abs(rows[i].l - rows[i - 1].c)));
            plusDm.push(up > down && up > 0 ? up : 0);
            minusDm.push(down > up && down > 0 ? down : 0);
        }
        const meanLast = (values, end, length) => values.slice(Math.max(0, end - length), end).reduce((a, b) => a + b, 0) / length;
        const dx = [];
        for (let end = period; end <= tr.length; end++) {
            const atr = meanLast(tr, end, period);
            const plus = atr > 0 ? 100 * meanLast(plusDm, end, period) / atr : 0;
            const minus = atr > 0 ? 100 * meanLast(minusDm, end, period) / atr : 0;
            dx.push(plus + minus > 0 ? 100 * Math.abs(plus - minus) / (plus + minus) : 0);
        }
        const adx = dx.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, dx.length);
        const recent = rows.slice(-(period + 1)).map(row => row.c);
        const path = recent.slice(1).reduce((sum, value, index) => sum + Math.abs(value - recent[index]), 0);
        const efficiency = path > 0 ? Math.abs(recent.at(-1) - recent[0]) / path : 0;
        const direction = Math.sign(recent.at(-1) - recent[0]);
        const regime = adx >= 20 && efficiency >= 0.25 ? 'trend'
            : adx < 18 && efficiency < 0.25 ? 'range' : 'transition';
        const atrSeries = [];
        for (let end = period; end <= tr.length; end++) atrSeries.push(meanLast(tr, end, period));
        const atrHistory = atrSeries.slice(-historyWindow);
        const currentAtr = atrHistory.at(-1);
        const atrPercentile = atrHistory.filter(value => value <= currentAtr).length / atrHistory.length * 100;
        const volumeRows = rows.slice(-21).filter(row => Number.isFinite(row.v) && row.v > 0);
        const volumeAvailable = volumeRows.length >= 10;
        let relativeVolume = NaN, vwap = NaN;
        if (volumeAvailable) {
            const currentVolume = volumeRows.at(-1).v;
            const prior = volumeRows.slice(0, -1);
            relativeVolume = currentVolume / (prior.reduce((sum, row) => sum + row.v, 0) / prior.length);
            const volumeTotal = volumeRows.reduce((sum, row) => sum + row.v, 0);
            vwap = volumeRows.reduce((sum, row) => sum + ((row.h + row.l + row.c) / 3) * row.v, 0) / volumeTotal;
        }
        return {
            ok: true, adx, efficiency, direction, regime, currentAtr, atrPercentile,
            volatility: atrPercentile >= 80 ? 'high' : atrPercentile <= 30 ? 'low' : 'normal',
            volumeAvailable, relativeVolume, vwap, currentPrice: rows.at(-1).c,
            volumeConfirmsLong: volumeAvailable && relativeVolume >= 1.10 && rows.at(-1).c >= vwap,
            volumeConfirmsShort: volumeAvailable && relativeVolume >= 1.10 && rows.at(-1).c <= vwap
        };
    }

    function evaluateEntryDecision(options = {}) {
        const side = options.side === 'short' ? 'short' : 'long';
        const projection = options.projection || {};
        const plan = options.plan || {};
        const best = plan.best || {};
        const expectedDirection = side === 'long' ? 'up' : 'down';
        const atr = Math.max(0, finiteNumber(options.atr));
        const atrMultiple = Math.max(1, finiteNumber(options.atrMultiple, 1.5));
        const minimumStopDistance = atr * atrMultiple;
        const roundTripCost = Math.max(0, finiteNumber(options.roundTripCost));
        const openingCost = Math.max(0, finiteNumber(options.openingCost));
        const feeKnown = options.feeKnown !== false;
        const excursion = options.costExcursion || {};
        const hasWaveletTarget = Number.isFinite(best.targetIndex) && best.targetIndex > 0;
        const hasWaveletStop = Number.isFinite(best.stopIndex) && best.stopIndex > 0;
        const projectedToTarget = projection.ok === true
            && projection.winner?.direction === expectedDirection
            && Number.isFinite(projection.winner?.targetBar);
        const requiredNetMultiple = Math.max(1, finiteNumber(options.requiredNetMultiple, 2));
        const costThreshold = roundTripCost + openingCost * requiredNetMultiple;
        const checks = [
            { key: 'wavelet', label: hasWaveletTarget && hasWaveletStop
                ? 'TP and SL come from Wavelet zones'
                : 'Valid ATR/RR fallback replaces an incomplete Wavelet pair', pass: plan.ok === true },
            { key: 'fourier', label: 'Fourier exceeds 1 ATR and reaches this TP within 10 candles', pass: projectedToTarget },
            { key: 'atr', label: `SL outside noise: distance ≥ ${atrMultiple.toFixed(2)} ATR`, pass: plan.ok === true && atr > 0 && finiteNumber(best.stopDistance) >= minimumStopDistance },
            { key: 'riskReward', label: 'TP ≥ 1.5 × SL', pass: plan.ok === true && finiteNumber(best.rewardRisk) >= 1.5 },
            { key: 'cost', label: feeKnown
                ? `Net profit ≥ ${requiredNetMultiple.toFixed(1)}× opening cost after round-trip costs`
                : 'Verifiable round-trip cost', pass: feeKnown && plan.ok === true && finiteNumber(best.potentialProfit) >= costThreshold },
            { key: 'excursion', label: excursion.ok
                ? `Historical favorable excursion reaches the cost target ${(excursion.hitRate * 100).toFixed(0)}% of the time; median ${Number.isFinite(excursion.medianHitBars) ? `${excursion.medianHitBars.toFixed(1)} candles` : '--'}`
                : 'Cost-adjusted historical excursion is available', pass: excursion.ok === true && excursion.viable === true }
        ];
        const allowed = checks.every(check => check.pass);
        return {
            side, allowed,
            decision: allowed ? (side === 'long' ? 'LONG IS VIABLE' : 'SHORT IS VIABLE') : 'NOT VIABLE',
            checks, projectedToTarget, hasWaveletTarget, hasWaveletStop,
            minimumStopDistance, openingCost, roundTripCost, costThreshold, costExcursion: excursion,
            grossProfit: finiteNumber(best.potentialProfit),
            netProfit: feeKnown ? finiteNumber(best.potentialProfit) - roundTripCost : null
        };
    }

    function calculateMultiLevelTradePlan(options) {
        const side = options?.side === 'short' ? 'short' : 'long';
        const entryPrice = finiteNumber(options?.entryPrice, NaN);
        const investment = finiteNumber(options?.investment, NaN);
        const leverage = finiteNumber(options?.leverage, NaN);
        const atr = finiteNumber(options?.atr, NaN);
        const openFeeRate = Math.max(0, finiteNumber(options?.openFeePercent)) / 100;
        const stopBufferAtr = Math.max(0, finiteNumber(options?.stopBufferAtr, 0.10));
        const maxLevels = Math.max(1, Math.min(8, Math.floor(finiteNumber(options?.maxLevels, 4))));
        if (!(entryPrice > 0) || !(investment > 0) || !(leverage > 0) || !(atr > 0)) {
            return { ok: false, error: 'Price, investment, leverage or ATR is missing.' };
        }
        const supports = Array.isArray(options?.supports) ? options.supports : [];
        const resistances = Array.isArray(options?.resistances) ? options.resistances : [];
        const uniqueByPrice = zones => {
            const unique = [];
            for (const zone of zones) {
                if (!unique.some(item => Math.abs(item.center - zone.center) < atr * 0.05)) unique.push(zone);
            }
            return unique;
        };
        const targetZones = uniqueByPrice(side === 'long'
            ? resistances.filter(zone => zone.low > entryPrice).sort((a, b) => a.low - b.low)
            : supports.filter(zone => zone.high < entryPrice).sort((a, b) => b.high - a.high)).slice(0, maxLevels);
        const stopZones = uniqueByPrice(side === 'long'
            ? supports.filter(zone => zone.low < entryPrice).sort((a, b) => b.low - a.low)
            : resistances.filter(zone => zone.high > entryPrice).sort((a, b) => a.high - b.high)).slice(0, maxLevels);
        if (!targetZones.length || !stopZones.length) {
            return { ok: false, error: 'There are not enough Wavelet zones on both sides of the price.' };
        }
        const exposure = investment * leverage;
        const units = exposure / entryPrice;
        const openingCost = exposure * openFeeRate;
        const minimumProfit = openingCost * 2;
        const costTarget = side === 'long'
            ? entryPrice + minimumProfit / units
            : entryPrice - minimumProfit / units;
        const stops = stopZones.map((zone, index) => {
            const price = side === 'long' ? zone.low - atr * stopBufferAtr : zone.high + atr * stopBufferAtr;
            const distance = Math.abs(entryPrice - price);
            return {
                index: index + 1, price, distance,
                percent: distance / entryPrice * 100,
                potentialLoss: units * distance,
                zoneStrength: zone.strength
            };
        });
        const nearestStop = stops[0];
        const targets = targetZones.map((zone, index) => {
            const price = side === 'long' ? zone.low : zone.high;
            const distance = Math.abs(price - entryPrice);
            const potentialProfit = units * distance;
            return {
                index: index + 1, price, distance,
                percent: distance / entryPrice * 100,
                potentialProfit,
                zoneStrength: zone.strength,
                rewardRisk: distance / nearestStop.distance,
                fartherThanNearestStop: distance > nearestStop.distance,
                coversTwiceOpening: potentialProfit >= minimumProfit
            };
        });
        return { ok: true, side, entryPrice, targets, stops, costTarget, openingCost, minimumProfit };
    }

    function calculateBestZoneTradePlan(options) {
        const side = options?.side === 'short' ? 'short' : 'long';
        const entryPrice = finiteNumber(options?.entryPrice, NaN);
        const investment = finiteNumber(options?.investment, NaN);
        const leverage = finiteNumber(options?.leverage, NaN);
        const atr = finiteNumber(options?.atr, NaN);
        const recommendedAtrMultiple = Math.max(1.01, finiteNumber(options?.recommendedAtrMultiple, 1.50));
        const minimumZoneDistance = atr * recommendedAtrMultiple;
        const supports = Array.isArray(options?.supports) ? options.supports
            .filter(zone => entryPrice - finiteNumber(zone?.high, entryPrice) > minimumZoneDistance)
            .sort((a, b) => b.high - a.high)
            .slice(0, 4) : [];
        const resistances = Array.isArray(options?.resistances) ? options.resistances
            .filter(zone => finiteNumber(zone?.low, entryPrice) - entryPrice > minimumZoneDistance)
            .sort((a, b) => a.low - b.low)
            .slice(0, 4) : [];
        const units = investment * leverage / entryPrice;
        const openFeeRate = Math.max(0, finiteNumber(options?.openFeePercent)) / 100;
        const hasRoundTripCost = Number.isFinite(Number(options?.closeFeePercent));
        const closeFeeRate = hasRoundTripCost ? Math.max(0, finiteNumber(options?.closeFeePercent)) / 100 : 0;
        const feeRate = hasRoundTripCost ? openFeeRate + closeFeeRate : openFeeRate;
        const costMultiple = hasRoundTripCost
            ? Math.max(1.01, finiteNumber(options?.roundTripCostMultiple, 2))
            : Math.max(1.01, finiteNumber(options?.openingCostMultiple, 2));
        const minimumProfit = investment * leverage * feeRate * costMultiple;
        const makeFallback = reason => {
            const stopZone = side === 'long' ? supports[0] : resistances[0];
            const structuralStop = stopZone
                ? (side === 'long'
                    ? stopZone.low - atr * finiteNumber(options?.stopBufferAtr, 0.10)
                    : stopZone.high + atr * finiteNumber(options?.stopBufferAtr, 0.10))
                : (side === 'long' ? entryPrice - minimumZoneDistance * 1.01 : entryPrice + minimumZoneDistance * 1.01);
            const stopDistance = Math.max(Math.abs(entryPrice - structuralStop), minimumZoneDistance * 1.01);
            const targetDistance = Math.max(stopDistance * 1.50, minimumProfit / units * 1.01);
            return {
                ok: true, fallback: true, reason, supports, resistances,
                minimumZoneDistance, recommendedAtrMultiple, validCount: 0, totalCount: 0,
                best: {
                    side, entryPrice, technicalStop: side === 'long' ? entryPrice - stopDistance : entryPrice + stopDistance,
                    technicalTarget: side === 'long' ? entryPrice + targetDistance : entryPrice - targetDistance,
                    stopDistance, targetDistance,
                    stopPercent: stopDistance / entryPrice * 100,
                    targetPercent: targetDistance / entryPrice * 100,
                    potentialLoss: units * stopDistance,
                    potentialProfit: units * targetDistance,
                    minimumProfit, recommendedAtrMultiple,
                    rewardRisk: targetDistance / stopDistance,
                    targetIndex: null, stopIndex: stopZone ? 1 : null,
                    targetStrength: 0, stopStrength: finiteNumber(stopZone?.strength),
                    fallback: true
                }
            };
        };
        if (!supports.length || !resistances.length) {
            return makeFallback(`Missing ${!supports.length && !resistances.length ? 'support and resistance' : !supports.length ? 'support' : 'resistance'} beyond ${recommendedAtrMultiple.toFixed(2)} ATR.`);
        }
        const combinations = [];
        supports.forEach((support, supportIndex) => resistances.forEach((resistance, resistanceIndex) => {
            const plan = calculateTradePlan({ ...options, side, support, resistance });
            if (!plan.ok) return;
            const targetDistance = plan.technicalTargetDistance;
            const potentialProfit = units * targetDistance;
            const rewardRisk = targetDistance / plan.stopDistance;
            const valid = targetDistance > plan.stopDistance
                && potentialProfit > minimumProfit
                && plan.stopDistance > minimumZoneDistance;
            const targetStrength = side === 'long' ? resistance.strength : support.strength;
            const stopStrength = side === 'long' ? support.strength : resistance.strength;
            const score = Math.min(rewardRisk, 4) / 4 * 0.70
                + (finiteNumber(targetStrength) + finiteNumber(stopStrength)) / 2 * 0.30;
            combinations.push({
                ...plan, valid, score, rewardRisk, targetDistance, potentialProfit,
                targetPercent: targetDistance / entryPrice * 100,
                targetFartherThanStop: targetDistance > plan.stopDistance,
                minimumProfit,
                targetCoversTwiceOpening: potentialProfit > minimumProfit,
                technicalRoomIsEnough: targetDistance >= plan.targetDistance,
                targetIndex: side === 'long' ? resistanceIndex + 1 : supportIndex + 1,
                stopIndex: side === 'long' ? supportIndex + 1 : resistanceIndex + 1,
                targetStrength, stopStrength
            });
        }));
        const valid = combinations.filter(item => item.valid).sort((a, b) => b.score - a.score);
        if (!valid.length) {
            const fallback = makeFallback(`None of the ${combinations.length} combinations satisfies all three rules.`);
            fallback.totalCount = combinations.length;
            fallback.combinations = combinations;
            return fallback;
        }
        return {
            ok: true, best: valid[0], validCount: valid.length,
            totalCount: combinations.length, combinations, supports, resistances,
            minimumZoneDistance, recommendedAtrMultiple
        };
    }

    function regression(values) {
        const n = values.length;
        if (n < 2) return { slope: 0, intercept: values[0] || 0 };
        const sumX = (n * (n - 1)) / 2;
        const sumX2 = ((n - 1) * n * (2 * n - 1)) / 6;
        const sumY = values.reduce((sum, value) => sum + value, 0);
        const sumXY = values.reduce((sum, value, index) => sum + index * value, 0);
        const denominator = n * sumX2 - sumX * sumX;
        const slope = Math.abs(denominator) < EPSILON ? 0 : (n * sumXY - sumX * sumY) / denominator;
        return { slope, intercept: (sumY - slope * sumX) / n };
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    // Causal Haar detail: compares the two adjacent halves ending at each point.
    function haarTransitionScore(prices, scales = [2, 4, 8]) {
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            if (prices[i] > 0 && prices[i - 1] > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
        }
        const scaleScores = scales.map(half => {
            const details = [];
            for (let end = half * 2; end <= returns.length; end++) {
                const left = returns.slice(end - half * 2, end - half);
                const right = returns.slice(end - half, end);
                const leftMean = left.reduce((a, b) => a + b, 0) / half;
                const rightMean = right.reduce((a, b) => a + b, 0) / half;
                details.push(Math.abs(rightMean - leftMean));
            }
            if (details.length < 5) return 0;
            const baseline = median(details.slice(0, -1)) || EPSILON;
            return details[details.length - 1] / baseline;
        });
        return {
            score: scaleScores.reduce((a, b) => a + b, 0) / Math.max(1, scaleScores.length),
            scales: scaleScores
        };
    }

    function haarScalogram(prices, scales = [2, 4, 8, 16]) {
        const values = prices.map(Number).filter(Number.isFinite);
        const rows = scales.map(half => {
            const coefficients = new Array(values.length).fill(null);
            for (let end = half * 2; end <= values.length; end++) {
                const leftStart = end - half * 2;
                const rightStart = end - half;
                let leftSum = 0;
                let rightSum = 0;
                for (let i = leftStart; i < rightStart; i++) leftSum += values[i];
                for (let i = rightStart; i < end; i++) rightSum += values[i];
                coefficients[end - 1] = (rightSum - leftSum) / half;
            }
            return coefficients;
        });
        const absolute = rows.flat().filter(Number.isFinite).map(Math.abs);
        const cap = absolute.length ? Math.max(median(absolute) * 6, EPSILON) : 1;
        return { scales: [...scales], rows, cap };
    }

    function haarDecompose(values) {
        const input = values.map(Number);
        if (!input.length || input.some(value => !Number.isFinite(value))) {
            return { ok: false, error: 'The Wavelet series contains invalid values.' };
        }
        if ((input.length & (input.length - 1)) !== 0) {
            return { ok: false, error: 'The Haar transform requires a power-of-two sample size.' };
        }
        const details = [];
        let approximation = [...input];
        while (approximation.length > 1) {
            const next = [];
            const detail = [];
            for (let i = 0; i < approximation.length; i += 2) {
                next.push((approximation[i] + approximation[i + 1]) / Math.SQRT2);
                detail.push((approximation[i] - approximation[i + 1]) / Math.SQRT2);
            }
            details.push(detail);
            approximation = next;
        }
        return { ok: true, approximation, details };
    }

    function haarReconstruct(decomposition, selectedLevels = null, includeApproximation = true) {
        if (!decomposition?.ok) return [];
        const selected = selectedLevels ? new Set(selectedLevels) : null;
        let approximation = includeApproximation ? [...decomposition.approximation] : [0];
        for (let level = decomposition.details.length; level >= 1; level--) {
            const storedDetail = decomposition.details[level - 1];
            const useDetail = !selected || selected.has(level);
            const next = new Array(approximation.length * 2);
            for (let i = 0; i < approximation.length; i++) {
                const detail = useDetail ? storedDetail[i] : 0;
                next[i * 2] = (approximation[i] + detail) / Math.SQRT2;
                next[i * 2 + 1] = (approximation[i] - detail) / Math.SQRT2;
            }
            approximation = next;
        }
        return approximation;
    }

    function haarWaveletAnalysis(values, componentCount = 2) {
        const decomposition = haarDecompose(values);
        if (!decomposition.ok) return decomposition;
        const components = decomposition.details.map((detail, index) => ({
            level: index + 1,
            scale: 2 ** (index + 1),
            energy: detail.reduce((sum, value) => sum + value * value, 0)
        })).sort((a, b) => b.energy - a.energy);
        const count = Math.max(1, Math.min(components.length, Math.floor(finiteNumber(componentCount, 2))));
        const selected = components.slice(0, count);
        const selectedLevels = selected.map(component => component.level);
        return {
            ok: true,
            components,
            selected,
            reconstruction: haarReconstruct(decomposition, selectedLevels, true),
            detailSignal: haarReconstruct(decomposition, selectedLevels, false),
            decomposition
        };
    }

    function spectrumOf(residuals, useHann = true) {
        const n = residuals.length;
        const weights = useHann && n > 2
            ? residuals.map((_, index) => 0.5 * (1 - Math.cos(2 * Math.PI * index / (n - 1))))
            : new Array(n).fill(1);
        const coherentGain = weights.reduce((sum, value) => sum + value, 0) / n || 1;
        const spectrum = [];
        for (let k = 1; k < n / 2; k++) {
            let real = 0;
            let imag = 0;
            for (let t = 0; t < n; t++) {
                const angle = (-2 * Math.PI * k * t) / n;
                real += residuals[t] * weights[t] * Math.cos(angle);
                imag += residuals[t] * weights[t] * Math.sin(angle);
            }
            real /= coherentGain;
            imag /= coherentGain;
            spectrum.push({ k, real, imag, magnitude: Math.hypot(real, imag) });
        }
        return spectrum.sort((a, b) => b.magnitude - a.magnitude);
    }

    function fourierComponentDirection(component, sampleSize, index = sampleSize - 1) {
        const n = Math.max(2, Math.floor(finiteNumber(sampleSize, 0)));
        const k = Math.max(0.5, finiteNumber(component?.k, 1));
        const real = finiteNumber(component?.real);
        const imag = finiteNumber(component?.imag);
        const valueAt = position => {
            const angle = (2 * Math.PI * k * position) / n;
            return (2 / n) * (real * Math.cos(angle) - imag * Math.sin(angle));
        };
        const current = valueAt(index);
        const next = valueAt(index + 1);
        const delta = next - current;
        const amplitude = (2 / n) * Math.hypot(real, imag);
        const threshold = Math.max(amplitude * 0.02, EPSILON);
        const direction = Math.abs(delta) <= threshold ? 'turning' : delta > 0 ? 'up' : 'down';
        return { direction, current, next, delta, amplitude };
    }

    function compareTrendMethods(prices, options = {}) {
        const values = prices.map(Number).filter(value => Number.isFinite(value) && value > 0);
        const lookback = Math.max(32, Math.floor(finiteNumber(options.lookback, 128)));
        const trendWindow = Math.max(4, Math.floor(finiteNumber(options.trendWindow, 16)));
        const harmonics = Math.max(1, Math.min(8, Math.floor(finiteNumber(options.harmonics, 5))));
        const feeRate = Math.max(0, finiteNumber(options.feePercent, 0.03)) / 100;
        const barsPerYear = Math.max(1, finiteNumber(options.barsPerYear, 24 * 252));
        if (values.length < lookback + 2) return { ok: false, error: `At least ${lookback + 2} closes are required.` };

        const logSignal = window => {
            const slope = regression(window.slice(-trendWindow).map(Math.log)).slope;
            return window.at(-1) * (Math.exp(slope) - 1);
        };
        const fourierSignal = window => {
            const logs = window.map(Math.log);
            const line = regression(logs);
            const residuals = logs.map((value, index) => value - line.intercept - line.slope * index);
            return spectrumOf(residuals).slice(0, harmonics)
                .reduce((sum, component) => sum + fourierComponentDirection(component, window.length).delta, 0)
                * window.at(-1);
        };
        const run = signalFunction => {
            let position = 0;
            let equity = 1;
            let peak = 1;
            let maxDrawdown = 0;
            let hits = 0;
            let active = 0;
            let changes = 0;
            const returns = [];
            for (let index = lookback - 1; index < values.length - 1; index++) {
                const window = values.slice(index - lookback + 1, index + 1);
                const recent = window.slice(-15);
                const atrProxy = recent.slice(1).reduce((sum, value, i) => sum + Math.abs(value - recent[i]), 0) / Math.max(1, recent.length - 1);
                const rawSignal = signalFunction(window);
                const nextPosition = Math.abs(rawSignal) < atrProxy * 0.01 ? 0 : Math.sign(rawSignal);
                let cost = 0;
                if (nextPosition !== position) {
                    if (position) cost += feeRate;
                    if (nextPosition) cost += feeRate;
                    changes++;
                }
                const marketReturn = values[index + 1] / values[index] - 1;
                const strategyReturn = nextPosition * marketReturn - cost;
                if (nextPosition) {
                    active++;
                    if (Math.sign(marketReturn) === nextPosition) hits++;
                }
                equity *= 1 + strategyReturn;
                peak = Math.max(peak, equity);
                maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
                returns.push(strategyReturn);
                position = nextPosition;
            }
            if (position) equity *= 1 - feeRate;
            const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
            const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
            const deviation = Math.sqrt(variance);
            return {
                observations: returns.length, active, changes,
                accuracy: active ? hits / active : 0,
                return: equity - 1,
                maxDrawdown,
                sharpe: deviation ? mean / deviation * Math.sqrt(barsPerYear) : 0
            };
        };
        return { ok: true, logPrice: run(logSignal), fourier5: run(fourierSignal), lookback, trendWindow, harmonics, feePercent: feeRate * 100 };
    }

    function fitFourierWindow(values, requestedHarmonics, minPeriodBars) {
        const solveLinearSystem = (matrix, vector) => {
            const n = vector.length;
            const augmented = matrix.map((row, index) => [...row, vector[index]]);
            for (let column = 0; column < n; column++) {
                let pivot = column;
                for (let row = column + 1; row < n; row++) {
                    if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
                }
                if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
                [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
                const divisor = augmented[column][column];
                for (let j = column; j <= n; j++) augmented[column][j] /= divisor;
                for (let row = 0; row < n; row++) {
                    if (row === column) continue;
                    const factor = augmented[row][column];
                    for (let j = column; j <= n; j++) augmented[row][j] -= factor * augmented[column][j];
                }
            }
            return augmented.map(row => row[n]);
        };
        const refitComponents = (residuals, selected, selectionMinPeriod) => {
            const n = residuals.length;
            const maximumFrequency = n / Math.max(2, selectionMinPeriod);
            // FFT bins are only coarse candidates. Refine each peak on a
            // fractional-frequency grid so cycles are not forced to integer
            // multiples of the window's fundamental frequency.
            const refined = selected.map(component => {
                let bestK = component.k;
                let bestPower = -Infinity;
                for (let offset = -0.45; offset <= 0.4501; offset += 0.05) {
                    const k = component.k + offset;
                    if (k < 0.5 || k > maximumFrequency || k >= n / 2) continue;
                    let cosine = 0, sine = 0, cosineNorm = 0, sineNorm = 0;
                    for (let index = 0; index < n; index++) {
                        const angle = 2 * Math.PI * k * index / n;
                        const c = Math.cos(angle), s = Math.sin(angle);
                        cosine += residuals[index] * c; sine += residuals[index] * s;
                        cosineNorm += c * c; sineNorm += s * s;
                    }
                    const power = cosine * cosine / Math.max(cosineNorm, 1e-9)
                        + sine * sine / Math.max(sineNorm, 1e-9);
                    if (power > bestPower) { bestPower = power; bestK = k; }
                }
                return { ...component, fftBin: component.k, k: bestK };
            });
            const columns = refined.flatMap(component => [
                Array.from({ length: n }, (_, index) => Math.cos(2 * Math.PI * component.k * index / n)),
                Array.from({ length: n }, (_, index) => Math.sin(2 * Math.PI * component.k * index / n))
            ]);
            const size = columns.length;
            const normal = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) =>
                columns[row].reduce((sum, value, index) => sum + value * columns[column][index], 0)
                + (row === column ? 1e-10 : 0)));
            const target = columns.map(column => column.reduce((sum, value, index) => sum + value * residuals[index], 0));
            const coefficients = solveLinearSystem(normal, target);
            if (!coefficients) return refined;
            return refined.map((component, index) => {
                const cosine = coefficients[index * 2];
                const sine = coefficients[index * 2 + 1];
                const real = cosine * n / 2;
                const imag = -sine * n / 2;
                return { ...component, real, imag, magnitude: Math.hypot(real, imag) };
            });
        };
        const fit = (series, harmonicCount, selectionMinPeriod = minPeriodBars) => {
            const n = series.length;
            const logs = series.map(Math.log);
            const line = regression(logs);
            const residuals = logs.map((value, index) => value - line.intercept - line.slope * index);
            const rankedSpectrum = spectrumOf(residuals, true)
                .filter(component => n / component.k >= selectionMinPeriod);
            // Adjacent FFT bins often describe one broadened spectral peak,
            // especially after windowing. Keep separated peaks so the model
            // does not count leakage around one cycle as several components.
            const frequencyCandidates = [];
            for (const component of rankedSpectrum) {
                if (frequencyCandidates.every(existing => Math.abs(existing.k - component.k) >= 1.5)) {
                    frequencyCandidates.push(component);
                    if (frequencyCandidates.length >= harmonicCount) break;
                }
            }
            const selected = refitComponents(residuals, frequencyCandidates, selectionMinPeriod);
            const residualAt = index => selected.reduce((sum, component) => {
                const angle = 2 * Math.PI * component.k * index / n;
                return sum + 2 / n * (component.real * Math.cos(angle) - component.imag * Math.sin(angle));
            }, 0);
            const logAt = index => line.intercept + line.slope * index + residualAt(index);
            return { n, logs, line, selected, residualAt, logAt };
        };
        const validationCount = Math.max(8, Math.floor(values.length * 0.20));
        const training = values.slice(0, -validationCount);
        let best = null;
        for (let count = 1; count <= requestedHarmonics; count++) {
            const model = fit(training, count);
            if (!model.selected.length) continue;
            const errors = [];
            let directionHits = 0;
            for (let step = 0; step < validationCount; step++) {
                const predictedLog = model.logAt(training.length + step);
                const actualLog = Math.log(values[training.length + step]);
                errors.push(actualLog - predictedLog);
                const previous = values[training.length + step - 1];
                if (Math.sign(Math.exp(predictedLog) - previous) === Math.sign(values[training.length + step] - previous)) directionHits++;
            }
            const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
            const directionAccuracy = directionHits / errors.length;
            const score = mae * (1.25 - directionAccuracy * 0.25);
            if (!best || score < best.score) best = { count: model.selected.length, score, mae, directionAccuracy, errors };
        }
        if (!best) return null;
        const model = fit(values, best.count);
        // Display all requested components, including fast cycles excluded from
        // the predictive model by its minimum-period rule.
        const requestedModel = fit(values, requestedHarmonics, 2);
        const meanLog = model.logs.reduce((sum, value) => sum + value, 0) / model.logs.length;
        return {
            ...model, chosenHarmonics: best.count, validationMae: best.mae,
            validationDirectionAccuracy: best.directionAccuracy, validationErrors: best.errors,
            fittedHistory: values.map((_, index) => Math.exp(model.logAt(index))),
            cycleHistory: values.map((_, index) => Math.exp(meanLog + model.residualAt(index))),
            requestedModel
        };
    }

    function projectFourierToTargets(prices, atr, options = {}) {
        const allValues = prices.map(Number).filter(value => Number.isFinite(value) && value > 0);
        if (allValues.length < 64 || !(finiteNumber(atr, 0) > 0)) {
            return { ok: false, error: 'At least 64 closes and a valid ATR are required.' };
        }
        const horizonBars = Math.max(1, Math.min(100, Math.floor(finiteNumber(options.horizonBars, 24))));
        const requestedHarmonics = Math.max(1, Math.min(12, Math.floor(finiteNumber(options.harmonics, 5))));
        const minPeriodBars = Math.max(6, Math.floor(finiteNumber(options.minPeriodBars, Math.max(10, horizonBars / 2))));
        const windows = [64, 96, 128].filter(size => size <= allValues.length);
        const models = windows.map(size => {
            const values = allValues.slice(-size);
            const model = fitFourierWindow(values, requestedHarmonics, minPeriodBars);
            if (!model) return null;
            const dominant = model.selected[0];
            const phase = dominant ? fourierComponentDirection(dominant, size) : null;
            const residualMean = model.logs.reduce((sum, value, index) => sum + value - model.line.intercept - model.line.slope * index, 0) / size;
            const residualDeviation = Math.sqrt(model.logs.reduce((sum, value, index) => {
                const residual = value - model.line.intercept - model.line.slope * index - residualMean;
                return sum + residual * residual;
            }, 0) / Math.max(1, size - 1));
            const omega = dominant ? 2 * Math.PI * dominant.k / size : 0;
            return { size, values, model, period: dominant ? size / dominant.k : null,
                normalizedAmplitude: dominant ? phase.amplitude / Math.max(residualDeviation, 1e-9) : 0,
                phaseState: dominant ? Math.atan2(phase.delta / Math.max(omega, 1e-9), phase.current) : 0,
                direction: phase?.direction || 'turning' };
        }).filter(Boolean);
        if (!models.length) return { ok: false, error: 'No valid Fourier model could be fitted.' };
        const chosen = [...models].sort((a, b) => a.model.validationMae - b.model.validationMae)[0];
        const periods = models.map(item => item.period).filter(Number.isFinite);
        const periodSpread = periods.length > 1 ? (Math.max(...periods) - Math.min(...periods)) / median(periods) : 1;
        const directional = models.map(item => item.direction).filter(direction => direction !== 'turning');
        const dominantDirection = directional.length
            ? [...directional].sort((a, b) => directional.filter(x => x === b).length - directional.filter(x => x === a).length)[0] : 'turning';
        const directionAgreement = models.length
            ? models.filter(item => item.direction === dominantDirection).length / models.length : 0;
        const amplitudes = models.map(item => item.normalizedAmplitude);
        const meanAmplitude = amplitudes.reduce((sum, value) => sum + value, 0) / amplitudes.length;
        const amplitudeCv = meanAmplitude > 0
            ? Math.sqrt(amplitudes.reduce((sum, value) => sum + (value - meanAmplitude) ** 2, 0) / amplitudes.length) / meanAmplitude : 1;
        const phaseVector = models.reduce((sum, item) => ({
            x: sum.x + Math.cos(item.phaseState), y: sum.y + Math.sin(item.phaseState)
        }), { x: 0, y: 0 });
        const phaseCoherence = Math.hypot(phaseVector.x, phaseVector.y) / models.length;
        const stabilityScore = Math.max(0, Math.min(1,
            (1 - Math.min(1, periodSpread)) * 0.35 + directionAgreement * 0.25
            + (1 - Math.min(1, amplitudeCv)) * 0.20 + phaseCoherence * 0.20));
        const stable = models.length >= 2 && periodSpread <= 0.35 && directionAgreement >= 2 / 3
            && amplitudeCv <= 0.75 && phaseCoherence >= 0.50;
        const model = chosen.model;
        const n = chosen.size;
        const forecast = Array.from({ length: horizonBars + 1 }, (_, step) => Math.exp(model.logAt(n - 1 + step)));
        const cumulativeLogAt = (index, count) => model.line.intercept + model.line.slope * index
            + model.selected.slice(0, count).reduce((sum, component) => {
                const angle = 2 * Math.PI * component.k * index / n;
                return sum + 2 / n * (component.real * Math.cos(angle) - component.imag * Math.sin(angle));
            }, 0);
        const cumulativeHistories = model.selected.map((_, componentIndex) => chosen.values.map((value, index) =>
            Math.exp(cumulativeLogAt(index, componentIndex + 1))));
        const cumulativeForecasts = model.selected.map((_, componentIndex) => Array.from({ length: horizonBars + 1 }, (_, step) =>
            Math.exp(cumulativeLogAt(n - 1 + step, componentIndex + 1))));
        const displayModel = model.requestedModel || model;
        const displayLogAt = (index, count) => displayModel.line.intercept + displayModel.line.slope * index
            + displayModel.selected.slice(0, count).reduce((sum, component) => {
                const angle = 2 * Math.PI * component.k * index / n;
                return sum + 2 / n * (component.real * Math.cos(angle) - component.imag * Math.sin(angle));
            }, 0);
        const displayCumulativeHistories = displayModel.selected.map((_, componentIndex) => chosen.values.map((value, index) =>
            Math.exp(displayLogAt(index, componentIndex + 1))));
        const displayCumulativeForecasts = displayModel.selected.map((_, componentIndex) => Array.from({ length: horizonBars + 1 }, (_, step) =>
            Math.exp(displayLogAt(n - 1 + step, componentIndex + 1))));
        const sortedAbsErrors = model.validationErrors.map(Math.abs).sort((a, b) => a - b);
        const errorQuantile = sortedAbsErrors[Math.min(sortedAbsErrors.length - 1, Math.floor(sortedAbsErrors.length * 0.90))] || 0;
        const lowerBand = forecast.map((value, step) => value * Math.exp(-errorQuantile * Math.sqrt(Math.max(1, step))));
        const upperBand = forecast.map((value, step) => value * Math.exp(errorQuantile * Math.sqrt(Math.max(1, step))));
        const empiricalCoverage = model.validationErrors.length
            ? model.validationErrors.filter(error => Math.abs(error) <= errorQuantile).length / model.validationErrors.length : 0;
        const current = allValues.at(-1);
        const endpointError = forecast[0] - current;
        const endpointErrorAtr = Math.abs(endpointError) / atr;
        const fittedErrors = model.fittedHistory.map((value, index) => value - chosen.values[index]);
        const fitMae = fittedErrors.reduce((sum, value) => sum + Math.abs(value), 0) / fittedErrors.length;
        const fitBias = fittedErrors.reduce((sum, value) => sum + value, 0) / fittedErrors.length;
        const fitRmse = Math.sqrt(fittedErrors.reduce((sum, value) => sum + value * value, 0) / fittedErrors.length);
        const fitMaxError = Math.max(...fittedErrors.map(Math.abs));
        const enabled = stable && endpointErrorAtr <= 0.75 && model.validationDirectionAccuracy >= 0.45;
        const rejectionReasons = [];
        if (!stable) rejectionReasons.push('cycle period/direction/amplitude/phase is unstable across 64/96/128-candle windows');
        if (endpointErrorAtr > 0.75) rejectionReasons.push(`endpoint error is ${endpointErrorAtr.toFixed(2)} ATR (maximum 0.75)`);
        if (model.validationDirectionAccuracy < 0.45) rejectionReasons.push(`validation direction accuracy is ${(model.validationDirectionAccuracy * 100).toFixed(0)}% (minimum 45%)`);
        const longTarget = finiteNumber(options.longTarget, Infinity);
        const shortTarget = finiteNumber(options.shortTarget, -Infinity);
        let upAtrBar = null, downAtrBar = null, longTargetBar = null, shortTargetBar = null;
        if (enabled) for (let step = 1; step < forecast.length; step++) {
            if (upAtrBar === null && forecast[step] - current >= atr) upAtrBar = step;
            if (downAtrBar === null && current - forecast[step] >= atr) downAtrBar = step;
            if (longTargetBar === null && forecast[step] >= longTarget) longTargetBar = step;
            if (shortTargetBar === null && forecast[step] <= shortTarget) shortTargetBar = step;
        }
        const candidates = [];
        if (upAtrBar !== null && longTargetBar !== null) candidates.push({ direction: 'up', atrBar: upAtrBar, targetBar: longTargetBar, target: longTarget });
        if (downAtrBar !== null && shortTargetBar !== null) candidates.push({ direction: 'down', atrBar: downAtrBar, targetBar: shortTargetBar, target: shortTarget });
        candidates.sort((a, b) => a.targetBar - b.targetBar);
        const winner = candidates[0] || null;
        const cycleDirections = model.selected.map(component => ({ k: component.k, period: n / component.k, ...fourierComponentDirection(component, n) }));
        const retainedFrequencies = new Set(model.selected.map(component => component.k));
        const displayCycleDirections = displayModel.selected.map(component => ({
            k: component.k, period: n / component.k, retained: retainedFrequencies.has(component.k),
            ...fourierComponentDirection(component, n)
        }));
        const directionSign = winner?.direction === 'up' ? 1 : winner?.direction === 'down' ? -1 : 0;
        return {
            ok: true, enabled, disabledReason: enabled ? null : rejectionReasons.join('; '), rejectionReasons,
            forecast, lowerBand, upperBand, horizonBars, harmonics: model.selected.length, requestedHarmonics,
            minPeriodBars, current, adaptiveWindow: n, fittedHistory: model.fittedHistory, cycleHistory: model.cycleHistory,
            cumulativeHistories, cumulativeForecasts,
            displayCumulativeHistories, displayCumulativeForecasts, displayCycleDirections,
            endpointError, endpointErrorAtr, empiricalCoverage, empiricalBandQuantile: 0.90,
            validationMae: model.validationMae, validationDirectionAccuracy: model.validationDirectionAccuracy,
            fitDiagnostics: { mae: fitMae, rmse: fitRmse, bias: fitBias, maxError: fitMaxError,
                maeAtr: fitMae / atr, rmseAtr: fitRmse / atr, validationMaePercent: Math.expm1(model.validationMae) * 100 },
            stability: { stable, score: stabilityScore, periodSpread, directionAgreement, amplitudeCv, phaseCoherence,
                windows: models.map(item => ({ size: item.size, period: item.period, direction: item.direction,
                    normalizedAmplitude: item.normalizedAmplitude, phaseState: item.phaseState,
                    validationMae: item.model.validationMae, directionAccuracy: item.model.validationDirectionAccuracy })) },
            min: Math.min(...forecast), max: Math.max(...forecast), upAtrBar, downAtrBar, longTargetBar, shortTargetBar,
            winner, ambiguous: candidates.length > 1, candidates, cycleDirections,
            alignment: directionSign ? cycleDirections.filter(component => Math.sign(component.delta) === directionSign).length / cycleDirections.length : 0
        };
    }

    function simulateFourierHoldout(prices, options = {}) {
        const values = prices.map(Number).filter(value => Number.isFinite(value) && value > 0);
        if (values.length < 80) return { ok: false, error: 'At least 80 closed candles are required.' };
        const trainEnd = Math.floor(values.length * 0.80);
        const testEnd = Math.floor(values.length * 0.90);
        const lookback = Math.max(32, Math.min(128, Math.floor(finiteNumber(options.lookback, 96))));
        const predict = (targetIndex, params) => {
            const history = values.slice(Math.max(0, targetIndex - lookback), targetIndex);
            if (history.length < 32) return null;
            const atr = estimateAtrFromPrices(history, 14);
            const result = projectFourierToTargets(history, atr, {
                harmonics: params.harmonics, horizonBars: 1, minPeriodBars: params.minPeriodBars
            });
            return result.ok ? result.forecast[1] : null;
        };
        const evaluate = (start, end, params) => {
            let hits = 0, total = 0, absolutePercentError = 0;
            for (let index = Math.max(32, start); index < end; index++) {
                const forecast = predict(index, params);
                if (!Number.isFinite(forecast)) continue;
                const previous = values[index - 1];
                const predictedDirection = Math.sign(forecast - previous);
                const actualDirection = Math.sign(values[index] - previous);
                if (!predictedDirection || !actualDirection) continue;
                hits += predictedDirection === actualDirection ? 1 : 0;
                absolutePercentError += Math.abs(forecast - values[index]) / values[index] * 100;
                total++;
            }
            return { hits, misses: total - hits, total, accuracy: total ? hits / total : 0, mape: total ? absolutePercentError / total : null };
        };
        const harmonicCandidates = options.harmonicCandidates || [1, 2, 3, 4, 5, 6, 8];
        const periodCandidates = options.periodCandidates || [8, 10, 12, 16, 20];
        let best = null;
        for (const harmonics of harmonicCandidates) {
            for (const minPeriodBars of periodCandidates) {
                const params = { harmonics, minPeriodBars };
                const score = evaluate(0, trainEnd, params);
                if (!best || score.accuracy > best.train.accuracy
                    || (score.accuracy === best.train.accuracy && score.mape < best.train.mape)) {
                    best = { params, train: score };
                }
            }
        }
        return {
            ok: true, candles: values.length, lookback, params: best.params,
            splits: {
                train: { ...best.train, percent: 80, start: 0, end: trainEnd },
                test: { ...evaluate(trainEnd, testEnd, best.params), percent: 10, start: trainEnd, end: testEnd },
                real: { ...evaluate(testEnd, values.length, best.params), percent: 10, start: testEnd, end: values.length }
            }
        };
    }

    function simulateFourierAtrStrategy(candles, options = {}) {
        const data = candles.filter(candle => Number.isFinite(candle.c) && candle.c > 0)
            .map(candle => ({ o: finiteNumber(candle.o, candle.c), h: finiteNumber(candle.h, candle.c), l: finiteNumber(candle.l, candle.c), c: candle.c }));
        if (data.length < 80) return { ok: false, error: 'At least 80 closed candles are required.' };
        const horizonBars = Math.max(1, Math.min(100, Math.floor(finiteNumber(options.horizonBars, 10))));
        const atrMultiple = Math.max(0.1, Math.min(10, finiteNumber(options.atrMultiple, 1)));
        const lookback = Math.max(32, Math.min(128, Math.floor(finiteNumber(options.lookback, 96))));
        const trainEnd = Math.floor(data.length * 0.80);
        const testEnd = Math.floor(data.length * 0.90);
        const atrAt = index => {
            const start = Math.max(1, index - 14);
            const ranges = [];
            for (let i = start; i < index; i++) ranges.push(Math.max(
                data[i].h - data[i].l,
                Math.abs(data[i].h - data[i - 1].c),
                Math.abs(data[i].l - data[i - 1].c)
            ));
            return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : 0;
        };
        const evaluate = (start, end, params, keepRecords = false) => {
            let signals = 0, wins = 0, losses = 0, unresolved = 0, score = 0;
            let projectedBarsTotal = 0, actualBarsTotal = 0;
            const records = [];
            for (let index = Math.max(32, start); index + horizonBars <= end; index++) {
                const history = data.slice(Math.max(0, index - lookback), index).map(candle => candle.c);
                const atr = atrAt(index);
                if (history.length < 32 || !(atr > 0)) continue;
                const projection = projectFourierToTargets(history, atr, {
                    harmonics: params.harmonics, horizonBars, minPeriodBars: params.minPeriodBars
                });
                if (!projection.ok || !projection.enabled) continue;
                const entry = history.at(-1);
                const distance = atr * atrMultiple;
                let direction = 0, projectedHitBar = null;
                for (let step = 1; step < projection.forecast.length; step++) {
                    const up = projection.forecast[step] >= entry + distance;
                    const down = projection.forecast[step] <= entry - distance;
                    if (up || down) { direction = up ? 1 : -1; projectedHitBar = step; break; }
                }
                if (!direction) continue;
                signals++; projectedBarsTotal += projectedHitBar;
                const target = entry + direction * distance;
                const stop = entry - direction * distance;
                let targetBar = null, stopBar = null;
                for (let step = 1; step <= horizonBars; step++) {
                    const candle = data[index + step - 1];
                    if (targetBar === null && (direction > 0 ? candle.h >= target : candle.l <= target)) targetBar = step;
                    if (stopBar === null && (direction > 0 ? candle.l <= stop : candle.h >= stop)) stopBar = step;
                }
                let outcome = 'unresolved', points = 0;
                if (targetBar !== null && (stopBar === null || targetBar < stopBar)) {
                    outcome = 'win'; points = 1; wins++; actualBarsTotal += targetBar;
                } else if (stopBar !== null || direction * (data[index + horizonBars - 1].c - entry) < 0) {
                    outcome = 'loss'; points = -2; losses++;
                } else unresolved++;
                score += points;
                if (keepRecords) records.push({ index, direction: direction > 0 ? 'long' : 'short', entry, atr, target, stop, projectedHitBar, actualHitBar: targetBar, outcome, points });
            }
            return {
                signals, wins, losses, unresolved, score,
                averageScore: signals ? score / signals : -Infinity,
                winRate: signals ? wins / signals : 0,
                projectedAverageBars: signals ? projectedBarsTotal / signals : null,
                actualAverageBars: wins ? actualBarsTotal / wins : null,
                records: keepRecords ? records.slice(-25) : undefined
            };
        };
        const harmonicCandidates = options.harmonicCandidates || [1, 2, 3, 4, 5, 6, 8];
        const periodCandidates = options.periodCandidates || [8, 10, 12, 16, 20];
        let best = null;
        for (const harmonics of harmonicCandidates) for (const minPeriodBars of periodCandidates) {
            const params = { harmonics, minPeriodBars };
            const train = evaluate(0, trainEnd, params);
            if (!best || train.averageScore > best.train.averageScore
                || (train.averageScore === best.train.averageScore && train.signals > best.train.signals)) best = { params, train };
        }
        return {
            ok: true, candles: data.length, horizonBars, atrMultiple, lookback, params: best.params,
            scoring: { win: 1, loss: -2, unresolved: 0 },
            splits: {
                train: { ...best.train, percent: 80, start: 0, end: trainEnd },
                test: { ...evaluate(trainEnd, testEnd, best.params, true), percent: 10, start: trainEnd, end: testEnd },
                real: { ...evaluate(testEnd, data.length, best.params, true), percent: 10, start: testEnd, end: data.length }
            }
        };
    }

    /**
     * Exploratory trend-change candidate. It extrapolates phased Fourier terms
     * and requires a minimum displacement from the linear trend. Haar only
     * describes whether a multiscale transition is already active; it does not
     * turn this into a calibrated probability.
     */
    function estimateTrendBreak(prices, atr, options = {}) {
        const values = prices.map(Number).filter(Number.isFinite);
        if (values.length < 64) return { ok: false, error: 'At least 64 prices are required.' };
        const n = values.length;
        const horizon = Math.max(4, Math.min(64, Math.floor(finiteNumber(options.horizon, 24))));
        const harmonics = Math.max(1, Math.min(12, Math.floor(finiteNumber(options.harmonics, 3))));
        const minMoveAtr = Math.max(0.01, finiteNumber(options.minMoveAtr, 0.5));
        const minMovePercent = Math.max(0.0001, finiteNumber(options.minMovePercent, 0.0005));
        const minMove = Math.max(finiteNumber(atr, 0) * minMoveAtr, Math.abs(values[n - 1]) * minMovePercent);
        const projection = projectFourierToTargets(values, atr, { harmonics, horizonBars: horizon, minPeriodBars: Math.max(10, horizon / 2) });
        if (!projection.ok) return projection;
        const recentSlope = regression(values.slice(-Math.min(16, n)).map(Math.log)).slope;
        const direction = Math.sign(recentSlope);
        let candidate = null;
        if (projection.enabled && direction !== 0) {
            for (let step = 2; step < projection.forecast.length - 1; step++) {
                const localSlope = (projection.forecast[step + 1] - projection.forecast[step - 1]) / 2;
                if (Math.sign(localSlope) === -direction && Math.abs(projection.forecast[step] - values.at(-1)) >= minMove) {
                    candidate = { bars: step, price: projection.forecast[step], direction: direction > 0 ? 'bearish' : 'bullish' };
                    break;
                }
            }
        }

        const wavelet = haarTransitionScore(values);
        const projectedMove = candidate ? Math.abs(candidate.price - values[n - 1]) : 0;
        return {
            ok: true,
            candidate,
            waveletScore: wavelet.score,
            waveletActive: wavelet.score >= 2,
            trendSlope: values[n - 1] * (Math.exp(recentSlope) - 1),
            logTrendSlope: recentSlope,
            strength: candidate ? Math.min(1, projectedMove / Math.max(minMove * 2, EPSILON)) : 0,
            selectedFrequencies: projection.cycleDirections.map(item => item.k),
            forecast: projection.forecast,
            enabled: projection.enabled,
            endpointError: projection.endpointError,
            endpointErrorAtr: projection.endpointErrorAtr,
            disabledReason: projection.disabledReason,
            stability: projection.stability,
            validationDirectionAccuracy: projection.validationDirectionAccuracy
        };
    }

    const DEFAULT_MODEL_PARAMS = Object.freeze({
        fourierWeight: 0.40,
        waveletWeight: 0.35,
        alignmentWeight: 0.25,
        signalThreshold: 0.60,
        zoneWidthAtr: 0.30,
        minMoveAtr: 0.50
    });

    function estimateAtrFromPrices(prices, period = 14) {
        const changes = [];
        for (let i = 1; i < prices.length; i++) changes.push(Math.abs(prices[i] - prices[i - 1]));
        const sample = changes.slice(-period);
        return sample.length ? sample.reduce((a, b) => a + b, 0) / sample.length : 0;
    }

    function aggregateCandlesToTimeframe(candles, sourceMinutes, targetMinutes, nowSeconds = Date.now() / 1000) {
        const sourceSeconds = Math.round(finiteNumber(sourceMinutes, 0) * 60);
        const targetSeconds = Math.round(finiteNumber(targetMinutes, 0) * 60);
        if (!(sourceSeconds > 0) || !(targetSeconds >= sourceSeconds)) return [];
        const valid = candles.filter(candle => Number.isFinite(candle.t)
            && Number.isFinite(candle.o) && Number.isFinite(candle.h)
            && Number.isFinite(candle.l) && Number.isFinite(candle.c)).sort((a, b) => a.t - b.t);
        const remainderCounts = new Map();
        if (sourceMinutes < 1440) valid.forEach(candle => {
            const remainder = candle.t % sourceSeconds;
            remainderCounts.set(remainder, (remainderCounts.get(remainder) || 0) + 1);
        });
        const sourceAnchor = remainderCounts.size
            ? [...remainderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
        const aligned = sourceMinutes < 1440
            ? valid.filter(candle => candle.t % sourceSeconds === sourceAnchor) : valid;
        if (targetSeconds === sourceSeconds) {
            return aligned.filter(candle => candle.t + sourceSeconds <= nowSeconds).map(candle => ({ ...candle }));
        }
        if (targetSeconds % sourceSeconds !== 0) return [];
        const factor = targetSeconds / sourceSeconds;
        const groups = new Map();
        for (const candle of aligned) {
            const bucket = Math.floor((candle.t - sourceAnchor) / targetSeconds) * targetSeconds + sourceAnchor;
            if (!groups.has(bucket)) groups.set(bucket, []);
            groups.get(bucket).push(candle);
        }
        return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([bucket, group]) => {
            group.sort((a, b) => a.t - b.t);
            if (group.length !== factor || bucket + targetSeconds > nowSeconds
                || !group.every((candle, index) => candle.t === bucket + index * sourceSeconds)) return [];
            return [{
                t: bucket, o: group[0].o,
                h: Math.max(...group.map(candle => candle.h)),
                l: Math.min(...group.map(candle => candle.l)), c: group.at(-1).c,
                v: group.every(candle => Number.isFinite(candle.v)) ? group.reduce((sum, candle) => sum + candle.v, 0) : null,
                sourceIntervalMinutes: sourceMinutes, aggregatedCandles: factor
            }];
        });
    }

    function findWaveletZones(prices, atr, options = {}) {
        const values = prices.map(Number).filter(Number.isFinite);
        const analysis = haarWaveletAnalysis(values, Math.min(4, Math.log2(values.length)));
        if (!analysis.ok) return { supports: [], resistances: [], pivots: [] };
        const smooth = analysis.reconstruction;
        const candles = Array.isArray(options.candles) && options.candles.length === values.length
            ? options.candles.map((candle, index) => ({
                o: finiteNumber(candle.o, values[index]), h: finiteNumber(candle.h, values[index]),
                l: finiteNumber(candle.l, values[index]), c: finiteNumber(candle.c, values[index])
            }))
            : values.map(value => ({ o: value, h: value, l: value, c: value }));
        const pivotRadius = Math.max(2, Math.floor(finiteNumber(options.pivotRadius, 2)));
        const minContactSeparation = Math.max(2, Math.floor(finiteNumber(options.minContactSeparation, 4)));
        const confirmationBars = Math.max(2, Math.floor(finiteNumber(options.confirmationBars, 4)));
        const decayHalfLife = Math.max(8, finiteNumber(options.decayHalfLife, 48));
        const bounceAtr = Math.max(0.1, finiteNumber(options.bounceAtr, 0.5));
        const width = Math.max(atr * finiteNumber(options.zoneWidthAtr, DEFAULT_MODEL_PARAMS.zoneWidthAtr), Math.abs(values.at(-1)) * 0.0002);
        const plateauTolerance = Math.max(atr * 0.02, Math.abs(values.at(-1)) * 1e-8);
        const pivots = [];
        for (let start = pivotRadius; start < smooth.length - pivotRadius;) {
            let end = start;
            while (end + 1 < smooth.length - pivotRadius && Math.abs(smooth[end + 1] - smooth[start]) <= plateauTolerance) end++;
            const left = smooth.slice(Math.max(0, start - pivotRadius), start);
            const right = smooth.slice(end + 1, Math.min(smooth.length, end + 1 + pivotRadius));
            const plateauValue = smooth[start];
            const supportShape = left.length && right.length && left.every(value => plateauValue <= value + plateauTolerance)
                && right.every(value => plateauValue <= value + plateauTolerance)
                && [...left, ...right].some(value => plateauValue < value - plateauTolerance);
            const resistanceShape = left.length && right.length && left.every(value => plateauValue >= value - plateauTolerance)
                && right.every(value => plateauValue >= value - plateauTolerance)
                && [...left, ...right].some(value => plateauValue > value + plateauTolerance);
            const segmentStart = Math.max(pivotRadius, start - pivotRadius);
            const segmentEnd = Math.min(values.length - pivotRadius - 1, end + pivotRadius);
            if (supportShape) {
                let index = segmentStart;
                for (let i = segmentStart + 1; i <= segmentEnd; i++) if (candles[i].l < candles[index].l) index = i;
                const localLows = candles.slice(index - pivotRadius, index + pivotRadius + 1).map(candle => candle.l);
                if (candles[index].l <= Math.min(...localLows) && Math.abs(candles[index].l - plateauValue) <= width * 2) {
                    pivots.push({ index, price: candles[index].l, type: 'support', plateauStart: start, plateauEnd: end });
                }
            }
            if (resistanceShape) {
                let index = segmentStart;
                for (let i = segmentStart + 1; i <= segmentEnd; i++) if (candles[i].h > candles[index].h) index = i;
                const localHighs = candles.slice(index - pivotRadius, index + pivotRadius + 1).map(candle => candle.h);
                if (candles[index].h >= Math.max(...localHighs) && Math.abs(candles[index].h - plateauValue) <= width * 2) {
                    pivots.push({ index, price: candles[index].h, type: 'resistance', plateauStart: start, plateauEnd: end });
                }
            }
            start = Math.max(end + 1, start + 1);
        }
        const cluster = type => {
            const zones = [];
            for (const pivot of pivots.filter(item => item.type === type)) {
                let zone = zones.find(item => Math.abs(item.center - pivot.price) <= width);
                if (!zone) {
                    zone = { type, center: pivot.price, touches: 0, lastIndex: pivot.index, prices: [] };
                    zones.push(zone);
                }
                if (zone.lastPivotIndex !== undefined && pivot.index - zone.lastPivotIndex < minContactSeparation) continue;
                zone.prices.push(pivot.price);
                zone.touches++;
                zone.lastPivotIndex = pivot.index;
                zone.lastIndex = Math.max(zone.lastIndex, pivot.index);
                zone.center = zone.prices.reduce((a, b) => a + b, 0) / zone.prices.length;
            }
            return zones.map(zone => {
                const low = zone.center - width;
                const high = zone.center + width;
                const events = [];
                let lastContact = -Infinity;
                for (let index = 0; index < candles.length - 1; index++) {
                    if (index - lastContact < minContactSeparation) continue;
                    const touchesZone = candles[index].l <= high && candles[index].h >= low;
                    if (!touchesZone) continue;
                    lastContact = index;
                    let outcome = 'unconfirmed', outcomeIndex = index;
                    for (let step = 1; step <= confirmationBars && index + step < candles.length; step++) {
                        const future = candles[index + step];
                        const broke = type === 'support' ? future.c < low : future.c > high;
                        const bounced = type === 'support'
                            ? future.h >= zone.center + atr * bounceAtr
                            : future.l <= zone.center - atr * bounceAtr;
                        if (broke || bounced) {
                            outcome = broke ? 'break' : 'bounce'; outcomeIndex = index + step; break;
                        }
                    }
                    events.push({ index, outcomeIndex, outcome });
                }
                const weighted = events.reduce((acc, event) => {
                    const age = values.length - 1 - event.outcomeIndex;
                    const weight = Math.exp(-Math.LN2 * age / decayHalfLife);
                    acc[event.outcome] += weight; return acc;
                }, { bounce: 0, break: 0, unconfirmed: 0 });
                const bounces = events.filter(event => event.outcome === 'bounce').length;
                const breaks = events.filter(event => event.outcome === 'break').length;
                const denominator = weighted.bounce + weighted.break + weighted.unconfirmed * 0.5 + 1;
                const strength = Math.min(1, (weighted.bounce + 0.15) / denominator)
                    * Math.min(1, events.length / 3);
                return { ...zone, low, high, events, touches: events.length, bounces, breaks,
                    unconfirmed: events.length - bounces - breaks, strength,
                    lastEvent: events.at(-1) || null, decayHalfLife, minContactSeparation };
            }).filter(zone => zone.touches > 0).sort((a, b) => b.strength - a.strength);
        };
        const current = values.at(-1);
        const supports = cluster('support').filter(zone => zone.center <= current + width);
        const resistances = cluster('resistance').filter(zone => zone.center >= current - width);
        const recentBreak = [...supports, ...resistances].flatMap(zone => zone.events
            .filter(event => event.outcome === 'break' && values.length - event.outcomeIndex <= confirmationBars + 2)
            .map(event => ({ ...event, type: zone.type }))).sort((a, b) => b.outcomeIndex - a.outcomeIndex)[0];
        const recentLength = Math.min(16, smooth.length);
        const smoothSlope = regression(smooth.slice(-recentLength)).slope;
        const regime = recentBreak
            ? (recentBreak.type === 'resistance' ? 'bullish_breakout' : 'bearish_breakout')
            : Math.abs(smoothSlope) < atr * 0.03 ? 'range'
                : smoothSlope > 0 ? 'trending_up' : 'trending_down';
        return {
            supports, resistances, pivots, regime, smoothSlope,
            settings: { pivotRadius, minContactSeparation, confirmationBars, decayHalfLife, bounceAtr, width }
        };
    }

    function analyzeCombined(prices, atr, parameters = {}) {
        const params = { ...DEFAULT_MODEL_PARAMS, ...parameters };
        const fourier = estimateTrendBreak(prices, atr, {
            horizon: finiteNumber(parameters.horizon, 32),
            harmonics: finiteNumber(parameters.harmonics, 3),
            minMoveAtr: params.minMoveAtr
        });
        const zones = findWaveletZones(prices, atr, { ...params, candles: parameters.candles });
        const candidate = fourier.candidate;
        const relevant = candidate
            ? (candidate.direction === 'bullish' ? zones.supports : zones.resistances)
            : [];
        const nearestZone = candidate && relevant.length
            ? [...relevant].sort((a, b) => Math.abs(a.center - candidate.price) - Math.abs(b.center - candidate.price))[0]
            : null;
        const distance = nearestZone && candidate ? Math.abs(nearestZone.center - candidate.price) : Infinity;
        const alignment = nearestZone ? Math.max(0, 1 - distance / Math.max(atr * 2, EPSILON)) : 0;
        const waveletStrength = nearestZone ? nearestZone.strength : 0;
        const weightTotal = params.fourierWeight + params.waveletWeight + params.alignmentWeight || 1;
        const score = (
            params.fourierWeight * finiteNumber(fourier.strength) +
            params.waveletWeight * waveletStrength +
            params.alignmentWeight * alignment
        ) / weightTotal;
        return {
            params, fourier, zones, nearestZone, alignment, waveletStrength, score,
            active: Boolean(candidate) && score >= params.signalThreshold
        };
    }

    function calibrationSamples(prices, options = {}) {
        const values = prices.map(Number).filter(Number.isFinite);
        const window = 128;
        const horizon = Math.max(4, Math.min(32, Math.floor(finiteNumber(options.horizon, 16))));
        const maxSamples = Math.max(12, Math.floor(finiteNumber(options.maxSamples, 60)));
        const available = Math.max(0, values.length - window - horizon);
        const stride = Math.max(1, Math.ceil(available / maxSamples));
        const samples = [];
        for (let end = window; end + horizon <= values.length; end += stride) {
            const past = values.slice(end - window, end);
            const future = values.slice(end, end + horizon);
            const atr = estimateAtrFromPrices(past);
            if (!(atr > 0)) continue;
            const base = analyzeCombined(past, atr, DEFAULT_MODEL_PARAMS);
            const trendDirection = Math.sign(regression(past.slice(-16)).slope);
            const futureDirection = Math.sign(regression([past.at(-1), ...future]).slope);
            const futureExcursion = Math.max(...future.map(value => Math.abs(value - past.at(-1)))) / atr;
            const outcome = trendDirection !== 0 && futureDirection === -trendDirection && futureExcursion >= 0.5 ? 1 : 0;
            samples.push({
                fourier: finiteNumber(base.fourier.strength),
                wavelet: base.waveletStrength,
                alignment: base.alignment,
                outcome
            });
        }
        return samples;
    }

    function calibrateCombinedModel(prices, options = {}) {
        const generatedSamples = calibrationSamples(prices, options);
        const minimum = Math.max(10, Math.floor(finiteNumber(options.minimumSamples, 12)));
        if (generatedSamples.length < minimum) {
            return { ok: false, error: `Insufficient history: ${generatedSamples.length}/${minimum} cases.`, params: { ...DEFAULT_MODEL_PARAMS }, samples: generatedSamples.length };
        }
        // Use a multiple of ten so the chronological partition is exactly 80/10/10.
        const usableCount = Math.floor(generatedSamples.length / 10) * 10;
        const samples = generatedSamples.slice(-usableCount);
        const trainCount = Math.max(1, Math.floor(samples.length * 0.8));
        const testCount = samples.length / 10;
        const validationCount = samples.length - trainCount - testCount;
        if (validationCount < 1) {
            return { ok: false, error: 'Enough history is required to separate training, test and validation.', params: { ...DEFAULT_MODEL_PARAMS }, samples: samples.length };
        }
        const trainSamples = samples.slice(0, trainCount);
        const testSamples = samples.slice(trainCount, trainCount + testCount);
        const validationSamples = samples.slice(trainCount + testCount);
        const params = { ...DEFAULT_MODEL_PARAMS };
        const ranges = {
            fourierWeight: [0.05, 0.90],
            waveletWeight: [0.05, 0.90],
            alignmentWeight: [0.05, 0.90],
            signalThreshold: [0.20, 0.90]
        };
        const probability = (sample, candidate) => {
            const total = candidate.fourierWeight + candidate.waveletWeight + candidate.alignmentWeight || 1;
            return (candidate.fourierWeight * sample.fourier + candidate.waveletWeight * sample.wavelet
                + candidate.alignmentWeight * sample.alignment) / total;
        };
        const loss = (candidate, dataset = trainSamples) => dataset.reduce((sum, sample) => {
            const score = probability(sample, candidate);
            const classification = score >= candidate.signalThreshold ? 1 : 0;
            const brier = (score - sample.outcome) ** 2;
            const error = classification === sample.outcome ? 0 : 1;
            return sum + brier + error * 0.25;
        }, 0) / dataset.length;

        let bestLoss = loss(params);
        for (let pass = 0; pass < 3; pass++) {
            let improved = false;
            for (const [name, [min, max]] of Object.entries(ranges)) {
                let bestValue = params[name];
                for (let integer = Math.round(min * 100); integer <= Math.round(max * 100); integer++) {
                    const value = integer / 100;
                    const candidate = { ...params, [name]: value };
                    const candidateLoss = loss(candidate);
                    if (candidateLoss + 1e-12 < bestLoss) {
                        bestLoss = candidateLoss;
                        bestValue = value;
                        improved = true;
                    }
                }
                params[name] = bestValue;
            }
            if (!improved) break;
        }
        const evaluate = dataset => {
            const predictions = dataset.map(sample => probability(sample, params) >= params.signalThreshold ? 1 : 0);
            const correct = predictions.filter((prediction, index) => prediction === dataset[index].outcome).length;
            const positives = dataset.filter(sample => sample.outcome === 1).length;
            return { count: dataset.length, accuracy: correct / dataset.length, positives, loss: loss(params, dataset) };
        };
        const splits = {
            train: evaluate(trainSamples),
            test: evaluate(testSamples),
            validation: evaluate(validationSamples)
        };
        return {
            ok: true, params, samples: samples.length, splits,
            accuracy: splits.validation.accuracy,
            loss: bestLoss,
            splitPercentages: { train: 80, test: 10, validation: 10 }
        };
    }

    return {
        calculateBreakEvenTP, getEtoroFeeProfile, calculateTradePlan, calculateTicketRiskLevels, analyzeCostAdjustedExcursion, calculateOpportunityRisk, analyzeMarketFilters, evaluateEntryDecision, calculateMultiLevelTradePlan, calculateBestZoneTradePlan,
        fourierComponentDirection, compareTrendMethods, projectFourierToTargets, simulateFourierHoldout, simulateFourierAtrStrategy, estimateTrendBreak,
        haarTransitionScore, haarScalogram, haarDecompose, haarReconstruct,
        haarWaveletAnalysis, findWaveletZones, analyzeCombined, aggregateCandlesToTimeframe,
        calibrateCombinedModel, DEFAULT_MODEL_PARAMS, regression
    };
});
