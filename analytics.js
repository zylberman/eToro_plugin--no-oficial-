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
            return { ok: false, error: 'Precio, inversión y apalancamiento deben ser mayores que cero.' };
        }

        const exposure = investment * leverage;
        const units = exposure / entryPrice;
        const openingVariableCost = exposure * (spreadRate + openRate);
        let targetPrice;

        if (side === 'long') {
            const denominator = units * (1 - closeRate);
            if (denominator <= EPSILON) return { ok: false, error: 'La comisión de cierre debe ser menor al 100%.' };
            targetPrice = (units * entryPrice + openingVariableCost + fixedCosts) / denominator;
        } else {
            const denominator = units * (1 + closeRate);
            targetPrice = (units * entryPrice - openingVariableCost - fixedCosts) / denominator;
            if (targetPrice <= 0) return { ok: false, error: 'Los costes superan el valor posible de la posición corta.' };
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
            return { known: true, openFeePercent: rate, closeFeePercent: rate, label: `CFD ${rate}% por lado` };
        }
        if (CRYPTO_SYMBOLS.has(normalized)) {
            return { known: true, openFeePercent: 1, closeFeePercent: 1, label: 'Cripto/CFD base: 1% por lado (sin descuento Club)' };
        }
        if (/^[A-Z]{6}$/.test(normalized)) {
            return { known: true, openFeePercent: 0.005, closeFeePercent: 0.005, label: 'Divisa CFD: 0,005% por lado' };
        }
        if (finiteNumber(leverage, 1) > 1) {
            return { known: true, openFeePercent: 0.15, closeFeePercent: 0.15, label: 'Acción/ETF CFD estimado: 0,15% por lado' };
        }
        return {
            known: false, openFeePercent: 0, closeFeePercent: 0,
            label: 'Tarifa no identificada: comprueba el coste estimado de eToro'
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
            return { ok: false, error: 'Faltan precio, importe, apalancamiento o ATR.' };
        }
        if (!support || !resistance) return { ok: false, error: 'No hay soporte y resistencia Wavelet suficientes.' };
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
            return { ok: false, error: 'El precio está fuera de las zonas técnicas utilizables.' };
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
            return { ok: false, error: 'Faltan precio, importe, apalancamiento o ATR.' };
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
            return { ok: false, error: 'No hay suficientes zonas Wavelet a ambos lados del precio.' };
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
        const minimumProfit = investment * leverage * openFeeRate
            * Math.max(1.01, finiteNumber(options?.openingCostMultiple, 2));
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
            return makeFallback(`Falta ${!supports.length && !resistances.length ? 'soporte y resistencia' : !supports.length ? 'soporte' : 'resistencia'} fuera de ${recommendedAtrMultiple.toFixed(2)} ATR.`);
        }
        const combinations = [];
        supports.forEach((support, supportIndex) => resistances.forEach((resistance, resistanceIndex) => {
            const plan = calculateTradePlan({ ...options, side, support, resistance });
            if (!plan.ok) return;
            const targetDistance = plan.technicalTargetDistance;
            const potentialProfit = units * targetDistance;
            const rewardRisk = targetDistance / plan.stopDistance;
            const valid = targetDistance > plan.stopDistance
                && potentialProfit > plan.minimumProfit
                && plan.stopDistance > minimumZoneDistance;
            const targetStrength = side === 'long' ? resistance.strength : support.strength;
            const stopStrength = side === 'long' ? support.strength : resistance.strength;
            const score = Math.min(rewardRisk, 4) / 4 * 0.70
                + (finiteNumber(targetStrength) + finiteNumber(stopStrength)) / 2 * 0.30;
            combinations.push({
                ...plan, valid, score, rewardRisk, targetDistance, potentialProfit,
                targetPercent: targetDistance / entryPrice * 100,
                targetIndex: side === 'long' ? resistanceIndex + 1 : supportIndex + 1,
                stopIndex: side === 'long' ? supportIndex + 1 : resistanceIndex + 1,
                targetStrength, stopStrength
            });
        }));
        const valid = combinations.filter(item => item.valid).sort((a, b) => b.score - a.score);
        if (!valid.length) {
            const fallback = makeFallback(`Ninguna de las ${combinations.length} combinaciones cumple las tres reglas.`);
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
            return { ok: false, error: 'La serie Wavelet contiene valores no válidos.' };
        }
        if ((input.length & (input.length - 1)) !== 0) {
            return { ok: false, error: 'La transformada Haar requiere una muestra potencia de dos.' };
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

    function spectrumOf(residuals) {
        const n = residuals.length;
        const spectrum = [];
        for (let k = 1; k < n / 2; k++) {
            let real = 0;
            let imag = 0;
            for (let t = 0; t < n; t++) {
                const angle = (-2 * Math.PI * k * t) / n;
                real += residuals[t] * Math.cos(angle);
                imag += residuals[t] * Math.sin(angle);
            }
            spectrum.push({ k, real, imag, magnitude: Math.hypot(real, imag) });
        }
        return spectrum.sort((a, b) => b.magnitude - a.magnitude);
    }

    function fourierComponentDirection(component, sampleSize, index = sampleSize - 1) {
        const n = Math.max(2, Math.floor(finiteNumber(sampleSize, 0)));
        const k = Math.max(1, Math.floor(finiteNumber(component?.k, 1)));
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
        if (values.length < lookback + 2) return { ok: false, error: `Se requieren al menos ${lookback + 2} cierres.` };

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

    function projectFourierToTargets(prices, atr, options = {}) {
        const values = prices.map(Number).filter(value => Number.isFinite(value) && value > 0);
        if (values.length < 32 || !(finiteNumber(atr, 0) > 0)) {
            return { ok: false, error: 'Se requieren al menos 32 cierres y un ATR válido.' };
        }
        const n = values.length;
        const horizonBars = Math.max(1, Math.min(720, Math.floor(finiteNumber(options.horizonBars, 24))));
        const harmonics = Math.max(1, Math.min(15, Math.floor(finiteNumber(options.harmonics, 5))));
        const logs = values.map(Math.log);
        const line = regression(logs);
        const residuals = logs.map((value, index) => value - line.intercept - line.slope * index);
        const selected = spectrumOf(residuals).slice(0, harmonics);
        const rawAt = index => {
            let value = line.intercept + line.slope * index;
            for (const component of selected) {
                const angle = 2 * Math.PI * component.k * index / n;
                value += 2 / n * (component.real * Math.cos(angle) - component.imag * Math.sin(angle));
            }
            return value;
        };
        const anchorOffset = logs.at(-1) - rawAt(n - 1);
        const forecast = Array.from({ length: horizonBars + 1 }, (_, step) => Math.exp(rawAt(n - 1 + step) + anchorOffset));
        const current = values.at(-1);
        const longTarget = finiteNumber(options.longTarget, Infinity);
        const shortTarget = finiteNumber(options.shortTarget, -Infinity);
        let upAtrBar = null;
        let downAtrBar = null;
        let longTargetBar = null;
        let shortTargetBar = null;
        for (let step = 1; step < forecast.length; step++) {
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
        const ambiguous = candidates.length > 1;
        const cycleDirections = selected.map(component => ({
            k: component.k,
            period: n / component.k,
            ...fourierComponentDirection(component, n)
        }));
        const directionSign = winner?.direction === 'up' ? 1 : winner?.direction === 'down' ? -1 : 0;
        const agreeing = directionSign
            ? cycleDirections.filter(component => Math.sign(component.delta) === directionSign).length
            : 0;
        return {
            ok: true, forecast, horizonBars, harmonics,
            current, min: Math.min(...forecast), max: Math.max(...forecast),
            upAtrBar, downAtrBar, longTargetBar, shortTargetBar,
            winner, ambiguous, candidates, cycleDirections,
            alignment: directionSign ? agreeing / cycleDirections.length : 0
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
        if (values.length < 32) return { ok: false, error: 'Se requieren al menos 32 precios.' };
        const n = values.length;
        const logValues = values.every(value => value > 0) ? values.map(Math.log) : values;
        const horizon = Math.max(4, Math.min(64, Math.floor(finiteNumber(options.horizon, 24))));
        const harmonics = Math.max(1, Math.min(8, Math.floor(finiteNumber(options.harmonics, 3))));
        const minMoveAtr = Math.max(0.01, finiteNumber(options.minMoveAtr, 0.5));
        const minMovePercent = Math.max(0.0001, finiteNumber(options.minMovePercent, 0.0005));
        const minMove = Math.max(finiteNumber(atr, 0) * minMoveAtr, Math.abs(values[n - 1]) * minMovePercent);
        const line = regression(logValues);
        const residuals = logValues.map((value, index) => value - (line.intercept + line.slope * index));
        const selected = spectrumOf(residuals).slice(0, harmonics);
        const projectAt = index => {
            let projected = line.intercept + line.slope * index;
            for (const component of selected) {
                const angle = (2 * Math.PI * component.k * index) / n;
                projected += (2 / n) * (component.real * Math.cos(angle) - component.imag * Math.sin(angle));
            }
            return logValues === values ? projected : Math.exp(projected);
        };
        const forecast = [];
        for (let step = 0; step <= horizon; step++) forecast.push(projectAt(n - 1 + step));

        const recentSlope = regression(logValues.slice(-Math.min(16, n))).slope;
        const direction = Math.sign(recentSlope || line.slope);
        let candidate = null;
        if (direction !== 0) {
            for (let step = 2; step < forecast.length - 1; step++) {
                const localSlope = (forecast[step + 1] - forecast[step - 1]) / 2;
                const projectedTrend = line.intercept + line.slope * (n - 1 + step);
                const trendOnly = logValues === values ? projectedTrend : Math.exp(projectedTrend);
                if (Math.sign(localSlope) === -direction && Math.abs(forecast[step] - trendOnly) >= minMove) {
                    candidate = { bars: step, price: forecast[step], direction: direction > 0 ? 'bajista' : 'alcista' };
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
            selectedFrequencies: selected.map(item => item.k),
            forecast
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

    function findWaveletZones(prices, atr, options = {}) {
        const values = prices.map(Number).filter(Number.isFinite);
        const analysis = haarWaveletAnalysis(values, Math.min(4, Math.log2(values.length)));
        if (!analysis.ok) return { supports: [], resistances: [], pivots: [] };
        const smooth = analysis.reconstruction;
        const pivotRadius = 2;
        const pivots = [];
        for (let i = pivotRadius; i < smooth.length - pivotRadius; i++) {
            const neighborhood = smooth.slice(i - pivotRadius, i + pivotRadius + 1);
            if (smooth[i] === Math.min(...neighborhood)) pivots.push({ index: i, price: smooth[i], type: 'support' });
            if (smooth[i] === Math.max(...neighborhood)) pivots.push({ index: i, price: smooth[i], type: 'resistance' });
        }
        const width = Math.max(atr * finiteNumber(options.zoneWidthAtr, DEFAULT_MODEL_PARAMS.zoneWidthAtr), Math.abs(values.at(-1)) * 0.0002);
        const cluster = type => {
            const zones = [];
            for (const pivot of pivots.filter(item => item.type === type)) {
                let zone = zones.find(item => Math.abs(item.center - pivot.price) <= width);
                if (!zone) {
                    zone = { type, center: pivot.price, touches: 0, lastIndex: pivot.index, prices: [] };
                    zones.push(zone);
                }
                zone.prices.push(pivot.price);
                zone.touches++;
                zone.lastIndex = Math.max(zone.lastIndex, pivot.index);
                zone.center = zone.prices.reduce((a, b) => a + b, 0) / zone.prices.length;
            }
            return zones.map(zone => ({
                ...zone,
                low: zone.center - width,
                high: zone.center + width,
                strength: Math.min(1, zone.touches / 4) * (0.6 + 0.4 * zone.lastIndex / values.length)
            })).sort((a, b) => b.strength - a.strength);
        };
        const current = values.at(-1);
        return {
            supports: cluster('support').filter(zone => zone.center <= current + width),
            resistances: cluster('resistance').filter(zone => zone.center >= current - width),
            pivots
        };
    }

    function analyzeCombined(prices, atr, parameters = {}) {
        const params = { ...DEFAULT_MODEL_PARAMS, ...parameters };
        const fourier = estimateTrendBreak(prices, atr, {
            horizon: finiteNumber(parameters.horizon, 32),
            harmonics: finiteNumber(parameters.harmonics, 3),
            minMoveAtr: params.minMoveAtr
        });
        const zones = findWaveletZones(prices, atr, params);
        const candidate = fourier.candidate;
        const relevant = candidate
            ? (candidate.direction === 'alcista' ? zones.supports : zones.resistances)
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
            return { ok: false, error: `Historial insuficiente: ${generatedSamples.length}/${minimum} casos.`, params: { ...DEFAULT_MODEL_PARAMS }, samples: generatedSamples.length };
        }
        // Use a multiple of ten so the chronological partition is exactly 80/10/10.
        const usableCount = Math.floor(generatedSamples.length / 10) * 10;
        const samples = generatedSamples.slice(-usableCount);
        const trainCount = Math.max(1, Math.floor(samples.length * 0.8));
        const testCount = samples.length / 10;
        const validationCount = samples.length - trainCount - testCount;
        if (validationCount < 1) {
            return { ok: false, error: 'Se necesita historial suficiente para separar entrenamiento, test y validación.', params: { ...DEFAULT_MODEL_PARAMS }, samples: samples.length };
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
        calculateBreakEvenTP, getEtoroFeeProfile, calculateTradePlan, calculateMultiLevelTradePlan, calculateBestZoneTradePlan,
        fourierComponentDirection, compareTrendMethods, projectFourierToTargets, estimateTrendBreak,
        haarTransitionScore, haarScalogram, haarDecompose, haarReconstruct,
        haarWaveletAnalysis, findWaveletZones, analyzeCombined,
        calibrateCombinedModel, DEFAULT_MODEL_PARAMS, regression
    };
});
