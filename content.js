(async () => {
    /**
     * ========================================================================
     * 1. CONFIGURATION AND GLOBAL STATE
     * ========================================================================
     * Data persistence and buffer synchronization.
     */
    const N = 128;                       // Sample size (analysis window)
    let candlesHistory  = [];            // OHLC candle buffer
    let rawYahooCandles = [];            // Unmodified source data for diagnostics
    let lastClose       = null;          // Latest detected close
    let lastTimeframe   = null;          // Current chart timeframe
    let lastSymbol      = null;          // Current asset symbol
    let lastBarTime     = 0;             // Timestamp of the latest processed bar
    let lastCalcTime    = 0;             // Calculation interval control
    let isSyncing       = false;         // Prevent duplicate downloads
    let visibleCyclesCount = 1;          // Number of harmonics to display
    let visibleWaveletLevels = 2;         // Highest-energy Haar components
    let visibleHistoryCount = Number(localStorage.getItem('atr-plugin-history-count') || 128);
    let projectionBars = Number(localStorage.getItem('atr-plugin-projection-bars') || 20);
    let chartPriceMode = localStorage.getItem('atr-plugin-chart-mode') || 'candles';
    let chartTradeSide = localStorage.getItem('atr-plugin-chart-side') || 'auto';
    let lastMarketPrice = null;           // Base price for break-even TP
    let lastPriceSource = 'Yahoo Finance';
    let lastBidPrice = null;
    let lastAskPrice = null;
    let modelParams = { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
    let calibrationToken = 0;
    let lastCombinedAnalysis = null;
    let lastAtrValue = null;
    let historyAlignedToEtoro = false;
    let historyScaleFactor = 1;
    let historyPriceOffset = 0;
    let scannerTimer = null;
    let scannerRunning = false;
    let lastFutureProjection = null;
    let lastMarketFilters = null;
    let lastTradePlans = null;
    let lastEntryDecision = null;
    let lastScannerResults = [];
    let liveCandle = null;
    const SCANNER_ASSETS = [
        { symbol: 'VOO', yahoo: 'VOO', name: 'S&P 500 ETF' },
        { symbol: 'VT', yahoo: 'VT', name: 'World ETF' },
        { symbol: 'BND', yahoo: 'BND', name: 'Bond ETF' },
        { symbol: 'QQQ', yahoo: 'QQQ', name: 'Nasdaq 100 ETF' },
        { symbol: 'BTC', yahoo: 'BTC-USD', name: 'Bitcoin' },
        { symbol: 'ETH', yahoo: 'ETH-USD', name: 'Ethereum' }
    ];
    const SCANNER_TIMEFRAMES = [
        { label: '15m', interval: '15m', range: '1mo', minutes: 15 },
        { label: '30m', interval: '30m', range: '1mo', minutes: 30 },
        { label: '1h', interval: '1h', range: '1mo', minutes: 60 },
        { label: '4h', interval: '1h', range: '6mo', minutes: 240, aggregate: 4 }
    ];
    const SCANNER_HARMONICS = 5;

    const injectCSS = () => {
        const style = document.createElement('style');
        style.id = 'atr-plugin-styles'; // Stable ID prevents duplicate style elements.
        style.innerHTML = `
            #etoro-atr-plugin {
                position: fixed; top: 65px; right: 20px; width: 790px;
                background: rgba(30, 34, 45, 0.98); border: 1px solid #363a45; 
                border-radius: 8px; color: #d1d4dc; padding: 12px; z-index: 100000;
                box-shadow: 0 8px 20px rgba(0,0,0,0.5); backdrop-filter: blur(4px);
            }
            .atr-header-row { 
                display: flex; justify-content: space-between; align-items: center; 
                border-bottom: 1px solid #363a45; padding-bottom: 5px; cursor: move; 
            }
            .atr-btn { 
                background: #2a2e39; border: 1px solid #444; color: #fff; 
                cursor: pointer; border-radius: 3px; padding: 2px 6px; font-size: 10px;
            }
            .atr-btn:hover { background: #3d414d; }
            #etoro-atr-plugin canvas { width: 100%; border-radius: 4px; background: #000; border: 1px solid #2a2e39; }
            #fourier-top-list { font-size: 0.72em; color: #4fc3f7; max-height: 190px; overflow-y: auto; }

            @keyframes spin { 100% { transform: rotate(360deg); } }
            .spinning { animation: spin 1s linear infinite; display: inline-block; }
        `;
        document.head.appendChild(style);
    };

    injectCSS();

    /**
     * ========================================================================
     * 2. EXTRACTION AND MAPPING UTILITIES
     * ========================================================================
     * Functions that synchronize the eToro DOM with API requirements.
     */
    
    // Read the symbol and timeframe while filtering system pages.
    const getMetadata = () => {
        const pathParts = window.location.pathname.split('/');
        let symbol = pathParts[2]?.toUpperCase();
        
        // Blocklist of reserved eToro terms that are not asset symbols.
        const ignored = ['PORTFOLIO', 'WATCHLIST', 'DISCOVER', 'MARKETS', 'BREAKDOWN', 'SETTINGS', 'COPY', 'PEOPLE'];
        
        // Ignore system URLs such as /portfolio/breakdown.
        if (!symbol || ignored.includes(symbol)) {
            // Secondary attempt: the symbol may be in segment 3 (/markets/gold).
            if (pathParts[1] === 'markets' && pathParts[2]) {
                symbol = pathParts[2].toUpperCase();
            } else {
                return { symbol: null, timeframe: null };
            }
        }

        const timeframeEl = document.querySelector('et-select-header.ets-chip-period');
        let timeframe = timeframeEl 
            ? timeframeEl.innerText.replace(/\s+/g, '').toLowerCase() 
            : '1d';
        
        if (timeframe.includes('min')) timeframe = timeframe.replace('min', 'm');
        
        // Abort silently when a blocked system term is detected.
        if (ignored.includes(symbol)) return { symbol: null, timeframe: null };

        console.log(`[DEBUG] Metadata detectada - Symbol: ${symbol}, TF: "${timeframe}"`);
        return { symbol, timeframe };
    };

    const parseLocalizedPrice = text => {
        const raw = String(text || '').trim();
        if (!raw) return null;
        const normalized = raw.includes(',') && raw.includes('.')
            ? raw.replace(/,/g, '')
            : raw.replace(',', '.');
        const value = Number(normalized);
        return Number.isFinite(value) && value > 0 ? value : null;
    };

    const getEtoroQuotes = () => {
        let bid = null;
        let ask = null;
        for (const button of document.querySelectorAll('button')) {
            const text = button.innerText?.replace(/\s+/g, ' ').trim();
            if (!text || text.length > 40) continue;
            const bidMatch = text.match(/^(?:V|VENTA|SELL)\s*([\d.,]+)/i);
            const askMatch = text.match(/^(?:C|COMPRA|BUY)\s*([\d.,]+)/i);
            if (bidMatch) bid = parseLocalizedPrice(bidMatch[1]);
            if (askMatch) ask = parseLocalizedPrice(askMatch[1]);
        }
        return { bid, ask };
    };

    const timeframeToMinutes = value => {
        const normalized = String(value || '').toLowerCase();
        const amount = parseFloat(normalized) || 1;
        if (normalized.includes('wk') || normalized.includes('w')) return amount * 10080;
        if (normalized.includes('d')) return amount * 1440;
        if (normalized.includes('h')) return amount * 60;
        return amount;
    };

    // Map eToro terms to Yahoo Finance-compatible symbols.
    const mapToYahoo = (symbol, timeframe) => {
        const symbolMap = { 
            'GOLD': 'GC=F', 'SILVER': 'SI=F', 'PLATINUM': 'PL=F',
            'COPPER': 'HG=F', 'BTC': 'BTC-USD', 'ETH': 'ETH-USD' 
        };
        
        const intervalMap = {
            '1m': '1m',   '2m': '2m',   '5m': '5m', 
            '10m': '5m',
            '15m': '15m', '30m': '30m', '60m': '60m', 
            '1h': '1h',   '4h': '1h',   '1d': '1d',  '1w': '1wk' 
        };
        
        const ySymbol   = symbolMap[symbol] || symbol;
        let yInterval   = intervalMap[timeframe] || (timeframe.includes('m') ? '5m' : '1d');

        const sourceMinutes = timeframeToMinutes(yInterval);
        const targetMinutes = timeframeToMinutes(timeframe);
        const aggregateFactor = targetMinutes > sourceMinutes && targetMinutes % sourceMinutes === 0
            ? targetMinutes / sourceMinutes : 1;
        console.log(`[DEBUG] Mapeo Yahoo - ySymbol: ${ySymbol}, yInterval: ${yInterval}, aggregate: ${aggregateFactor}`);
        return { ySymbol, yInterval, sourceMinutes, targetMinutes, aggregateFactor };
    };

    const normalizeYahooCandles = (candles, sourceMinutes, targetMinutes) => {
        return window.EToroAnalytics.aggregateCandlesToTimeframe(
            candles, sourceMinutes, targetMinutes, Math.floor(Date.now() / 1000)
        ).map(candle => ({ ...candle, source: 'yahoo-proxy' }));
    };

    const observedEtoroKey = (symbol, timeframe) => `atr-etoro-observed-${symbol}-${timeframe}`;
    const loadObservedEtoroCandles = (symbol, timeframe) => {
        try {
            const stored = JSON.parse(localStorage.getItem(observedEtoroKey(symbol, timeframe)) || '[]');
            return stored.filter(candle => Number.isFinite(candle.t) && Number.isFinite(candle.c))
                .map(candle => ({ ...candle, source: 'etoro-observed', partial: false }));
        } catch { return []; }
    };
    const saveObservedEtoroCandle = (symbol, timeframe, candle) => {
        if (!symbol || !timeframe || !candle || !Number.isFinite(candle.t) || !Number.isFinite(candle.c)) return;
        const merged = new Map(loadObservedEtoroCandles(symbol, timeframe).map(item => [item.t, item]));
        merged.set(candle.t, { ...candle, source: 'etoro-observed', partial: false });
        const compact = [...merged.values()].sort((a, b) => a.t - b.t).slice(-2000);
        localStorage.setItem(observedEtoroKey(symbol, timeframe), JSON.stringify(compact));
    };
    const mergeObservedEtoroCandles = (proxyCandles, symbol, timeframe) => {
        const merged = new Map(proxyCandles.map(candle => [candle.t, candle]));
        loadObservedEtoroCandles(symbol, timeframe).forEach(candle => merged.set(candle.t, candle));
        return [...merged.values()].sort((a, b) => a.t - b.t);
    };


    /**
     * ========================================================================
     * 3. COMMUNICATION LAYER (YAHOO FINANCE API)
     * ========================================================================
     */
    
    const fetchHistory = async (ySymbol, yInterval, range = '5d') => {
        if (!ySymbol) return [];
        
        const indicator = document.getElementById('conn-indicator');
        const queryHost = Math.random() > 0.5 ? 'query1' : 'query2';
        const targetUrl = `https://${queryHost}.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=${range}`;

        const parseChartResult = (data) => {
            if (!data?.chart?.result?.[0]) return null;
            const resData = data.chart.result[0];
            const quotes = resData.indicators.quote[0];
            const ts = resData.timestamp || [];
            return ts.map((t, i) => ({
                t, o: quotes.open?.[i], h: quotes.high[i], l: quotes.low[i], c: quotes.close[i], v: quotes.volume?.[i]
            })).filter(v => Number.isFinite(v.o) && Number.isFinite(v.h) && Number.isFinite(v.l) && Number.isFinite(v.c));
        };

        console.log(`%c[ATR] 🌐 Attempting download from ${queryHost}...`, "color: #4fc3f7");

        // Prefer the background script because it avoids CORS restrictions.
        try {
            const response = await chrome.runtime.sendMessage({ action: 'fetchYahooChart', url: targetUrl });
            if (response?.ok && response?.data) {
                const candles = parseChartResult(response.data);
                if (candles?.length) {
                    if (indicator) indicator.style.background = '#00e676';
                    console.log(`%c[ATR] ✅ Connection successful (background)`, "color: #00e676");
                    return candles;
                }
            }
        } catch (e) {
            console.warn('[ATR] Background fetch failed:', e?.message || e);
        }

        // 2) Fallback: proxies CORS (cors-anywhere.com ~20 req/min)
        const proxyConfigs = [
            { url: `https://cors-anywhere.com/${targetUrl}`, type: 'direct' },
            { url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, type: 'allorigins' }
        ];
        for (const config of proxyConfigs) {
            try {
                const res = await fetch(config.url);
                if (!res.ok) continue;
                let data;
                if (config.type === 'allorigins') {
                    const outerJson = await res.json();
                    data = outerJson.contents ? JSON.parse(outerJson.contents) : null;
                } else {
                    data = await res.json();
                }
                const candles = parseChartResult(data);
                if (candles?.length) {
                    if (indicator) indicator.style.background = '#00e676';
                    console.log(`%c[ATR] ✅ Connection successful (${config.url.split('/')[2]})`, "color: #00e676");
                    return candles;
                }
            } catch (e) {
                console.warn(`[ATR] Proxy failed: ${config.url.split('/')[2]}`);
            }
        }

        if (indicator) indicator.style.background = '#ff5252';
        return [];
    };

    /* ========================================================================
       4. MATHEMATICAL LOGIC (FOURIER & FFT)
       ======================================================================== */
    /**
     * Applies linear-regression detrending to the time series.
     * Removes the trend so the FFT focuses on seasonality and cycles.
     * Equations: $m = \frac{n\sum xy - \sum x \sum y}{n\sum x^2 - (\sum x)^2}$ and $b = \frac{\sum y - m\sum x}{n}$
     */
    function fourierDetrend(data) {
        const n = data.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

        for (let i = 0; i < n; i++) {
            sumX  += i;
            sumY  += data[i];
            sumXY += i * data[i];
            sumX2 += i * i;
        }

        const slope     = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        // Return the residual: actual value minus trend value.
        return data.map((y, x) => y - (slope * x + intercept));
    }

    /**
     * Recursive Fast Fourier Transform (FFT) implementation.
     * @param {Array} input Detrended residual data.
     * @returns {Array} Frequency spectrum with real and imaginary components.
     */

    /**
     * Calculates the 14-period Average True Range (ATR).
     */
    function calculateATR(candles, period = 14) {
        if (candles.length <= period) return 0;
        
        let trValues = [];
        for (let i = 1; i < candles.length; i++) {
            const h = candles[i].h;
            const l = candles[i].l;
            const cp = candles[i-1].c;
            
            const tr = Math.max(h - l, Math.abs(h - cp), Math.abs(l - cp));
            trValues.push(tr);
        }
        
        // Simple average of the latest `period` TR values.
        const slice = trValues.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    function fourierTransform(input) {
        const n = input.length;
        if (n <= 1) return input.map(v => ({ real: v, imag: 0 }));

        // Split by index instead of filtering to avoid extra iterations.
        const evenIn = [], oddIn = [];
        for (let i = 0; i < n; i++) {
            if (i % 2 === 0) evenIn.push(input[i]);
            else oddIn.push(input[i]);
        }

        const even = fourierTransform(evenIn);
        const odd  = fourierTransform(oddIn);
        const output = new Array(n);

        for (let k = 0; k < n / 2; k++) {
            const angle = -2 * Math.PI * k / n;
            const t = {
                real: Math.cos(angle) * odd[k].real - Math.sin(angle) * odd[k].imag,
                imag: Math.cos(angle) * odd[k].imag + Math.sin(angle) * odd[k].real
            };
            output[k]         = { real: even[k].real + t.real, imag: even[k].imag + t.imag };
            output[k + n / 2] = { real: even[k].real - t.real, imag: even[k].imag - t.imag };
        }
        return output;
    }

    /* ========================================================================
       5. USER INTERFACE CONSTRUCTION
       ======================================================================== */
    // Container initialization.
    const ui = document.createElement('div');
    ui.id    = 'etoro-atr-plugin';

    // Persistence and state.
    const savedInv    = localStorage.getItem('atr-plugin-inv') || "1000";
    const savedLev    = localStorage.getItem('atr-plugin-lev') || "1";
    const savedTradeSide = localStorage.getItem('atr-plugin-trade-side') || 'long';
    const isMinimized = localStorage.getItem('atr-plugin-minimized') === 'true';
    
    // HTML structure.
    /* ========================================================================
   SECTION 5: SIMPLIFIED UI
   ======================================================================== */
    ui.innerHTML = `
        <div class="atr-header-row">
            <div class="atr-brand"><img src="${chrome.runtime.getURL('icons/icon32.png')}" alt=""><div class="atr-header">Price, Risk and Trend Assistant</div></div>
            <div id="conn-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff5252; margin-left: 5px;" title="Connection status"></div>
            <div style="display: flex; gap: 5px; align-items: center;">
                <button id="download-diagnostic" class="atr-btn" title="Download plugin and eToro comparison data">↓ JSON</button>
                <button id="atr-refresh-btn" class="atr-btn" title="Refresh all data">⟳</button>
                <button id="atr-min-btn">${isMinimized ? '▢' : '_'}</button>
            </div>
        </div>

        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : 'display: block;'}">
            <div class="single-analysis-view"><div class="analysis-workspace">
                <section class="unified-panel">
                    <div class="summary-line">
                        <b id="atr-status">Synchronizing...</b>
                        <span title="Average true range of the latest 14 candles, in price units per candle.">ATR(14) per candle <b id="val-atr">0.00</b></span>
                    </div>
                    <div class="market-price-card">
                        <span id="market-price-label">Reference price</span>
                        <b id="current-price">--</b>
                        <small id="price-source">Waiting for source…</small>
                    </div>
                    <div class="input-row">
                        <label title="Money from your balance allocated to this position.">Investment ($)
                            <input type="number" id="inv-amount" value="${savedInv}" min="1" step="10">
                        </label>
                        <label title="Multiplies exposure, gains and losses. X1 applies no multiplier.">Leverage
                            <select id="lev-amount">
                                ${[1, 2, 5, 10, 20, 30].map(value => `<option value="${value}" ${String(value) === savedLev ? 'selected' : ''}>X${value}</option>`).join('')}
                            </select>
                        </label>
                    </div>
                    <div class="ohlc-title">Latest detected candle</div>
                    <div class="atr-ohlc">
                        O <span id="val-o">-</span> · H <span id="val-h">-</span> · L <span id="val-l">-</span> · C <span id="val-c">-</span>
                    </div>
                    <div class="market-core-metrics">
                        <span>ATR(14) <b id="current-atr-distance">--</b></span>
                        <span>Recommended SL distance <b id="recommended-atr">--</b></span>
                        <span>Rolling VWAP(21) <b id="metric-vwap">--</b></span>
                        <span>16-candle log trend <b id="metric-log-trend">--</b></span>
                    </div>
                    <div class="signal-breakdown">
                        <span>Price trend <b id="signal-price-trend">--</b></span>
                        <span>Fourier direction <b id="signal-fourier-direction">--</b></span>
                        <span>Wavelet regime <b id="signal-wavelet-regime">--</b></span>
                        <span>Final consensus <b id="signal-consensus">--</b></span>
                        <span>Method conflict <b id="signal-conflict">--</b></span>
                        <span>Empirical confidence <b id="signal-confidence">--</b></span>
                    </div>
                    <details class="discrepancy-panel" open>
                        <summary>Data and model discrepancies</summary>
                        <div id="discrepancy-output">Waiting for comparable prices and model fit…</div>
                    </details>
                    <div class="unified-controls">
                        <span><span id="f-samples">--</span> candles · <span id="f-tf">--</span></span>
                        <label>Visible candles <select id="history-count"><option>32</option><option>64</option><option selected>128</option></select></label>
                        <label>Projected candles <select id="projection-count"><option>5</option><option>10</option><option selected>20</option><option>30</option><option>40</option></select></label>
                        <label>Price display <select id="chart-price-mode"><option value="candles">OHLC candles</option><option value="close">Close price</option></select></label>
                        <label>Trade side <select id="chart-trade-side"><option value="auto">Auto</option><option value="long">Buy / LONG</option><option value="short">Sell / SHORT</option></select></label>
                        <span>Fourier harmonics <button id="k-minus" class="atr-btn">−</button><b id="k-count-label">1</b><button id="k-plus" class="atr-btn">+</button></span>
                        <span>Wavelet levels <button id="w-minus" class="atr-btn">−</button><b id="w-count-label">2</b><button id="w-plus" class="atr-btn">+</button></span>
                    </div>
                    <div class="layer-controls">
                        <label><input type="checkbox" id="show-fourier" checked> Fourier</label>
                        <label><input type="checkbox" id="show-atr" checked> ATR</label>
                        <label><input type="checkbox" id="show-tp" checked> TP</label>
                        <label><input type="checkbox" id="show-sl" checked> SL</label>
                    </div>
                    <div class="chart-title">Unified price analysis · <b id="fourier-cycle">Loading…</b></div>
                    <div class="unified-legend">
                        <span class="legend-real">● Historical OHLC (eToro when observed; otherwise adjusted Yahoo proxy)</span>
                        <span class="legend-fourier-cycles">● Fourier cycles</span>
                        <span class="legend-fourier-steps">● C1…Cn cumulative spectral fits</span>
                        <span class="legend-fourier">● Fourier trend + cycles</span>
                        <span class="legend-wavelet">● Wavelet</span>
                        <span class="legend-projection">● <b id="projection-legend-count">20</b>-candle projection</span>
                        <span class="legend-band">■ Dispersion</span>
                        <span class="legend-atr">━ Directional ATR</span>
                        <span class="legend-tp">┄ TP</span>
                        <span class="legend-sl">┄ SL</span>
                        <span class="legend-market">┄ eToro executable entry</span>
                    </div>
                    <canvas id="unified-analysis-canvas" width="900" height="360"></canvas>
                    <div id="fourier-forecast-output" class="forecast-output">Waiting for projection…</div>
                    <div id="fourier-price-list" class="future-price-list"></div>
                    <div id="fourier-top-list"></div>
                    <div id="wavelet-components">Waiting for Wavelet data…</div>
                    <div class="trade-plan-panel">
                        <div class="trade-plan-head">
                            <b>LONG and SHORT TP/SL combinations</b>
                        </div>
                        <div id="trade-plan-output">Waiting for Wavelet zones…</div>
                        <div class="trade-plan-note">Dollar values convert the distance from the current executable price. Margin equals TP gross profit minus estimated opening and closing costs.</div>
                    </div>
                </section>
                <aside class="fourier-simulator">
                    <h3>Fourier historical simulator</h3>
                    <p>Define when a projected trend counts as fulfilled. Parameters are selected only with the first 80%; they remain fixed for Test and Real.</p>
                    <div class="simulation-controls">
                        <label>Maximum candles after prediction
                            <input type="number" id="simulation-horizon" min="1" max="100" step="1" value="10">
                        </label>
                        <label>Target distance in ATR
                            <input type="number" id="simulation-atr-multiple" min="0.1" max="10" step="0.1" value="1">
                        </label>
                    </div>
                    <div class="simulation-scoring">Win = +1 · Loss = −2 · Unresolved = 0</div>
                    <button id="run-fourier-simulation" class="atr-btn">Run simulation</button>
                    <div id="fourier-simulation-output">Waiting to run…</div>
                </aside>
            </div></div>
        </div>
        <div id="plugin-resize-handle" title="Drag to resize"></div>
    `;

    // Inject into the DOM.
    Object.assign(ui.style, { position: 'fixed', top: '100px', right: '20px', zIndex: '10000' });
    ui.classList.toggle('atr-minimized', isMinimized);

    document.body.appendChild(ui);
    ui.classList.add('mode-analysis');
    document.getElementById('history-count').value = String([32, 64, 128].includes(visibleHistoryCount) ? visibleHistoryCount : 128);
    document.getElementById('projection-count').value = String([5, 10, 20, 30, 40].includes(projectionBars) ? projectionBars : 20);
    visibleHistoryCount = Number(document.getElementById('history-count').value);
    projectionBars = Number(document.getElementById('projection-count').value);
    document.getElementById('chart-price-mode').value = ['candles', 'close'].includes(chartPriceMode) ? chartPriceMode : 'candles';
    document.getElementById('chart-trade-side').value = ['auto', 'long', 'short'].includes(chartTradeSide) ? chartTradeSide : 'auto';
    chartPriceMode = document.getElementById('chart-price-mode').value;
    chartTradeSide = document.getElementById('chart-trade-side').value;
    document.getElementById('projection-legend-count').textContent = projectionBars;
    ui.style.setProperty('--panel-width', '960px');
    ui.style.setProperty('--panel-height', '760px');
    const savedPluginSize = JSON.parse(localStorage.getItem('atr-plugin-size') || 'null');
    if (savedPluginSize && Number.isFinite(savedPluginSize.width) && Number.isFinite(savedPluginSize.height)) {
        ui.style.width = `${Math.min(window.innerWidth - 12, Math.max(440, savedPluginSize.width))}px`;
        ui.style.height = `${Math.min(window.innerHeight - 45, Math.max(360, savedPluginSize.height))}px`;
    }
    const savedPluginPosition = JSON.parse(localStorage.getItem('atr-plugin-position') || 'null');
    if (savedPluginPosition && Number.isFinite(savedPluginPosition.left) && Number.isFinite(savedPluginPosition.top)) {
        ui.style.left = `${Math.max(0, Math.min(savedPluginPosition.left, window.innerWidth - 60))}px`;
        ui.style.top = `${Math.max(0, Math.min(savedPluginPosition.top, window.innerHeight - 35))}px`;
        ui.style.right = 'auto';
    }

    const readNumber = id => Number(document.getElementById(id)?.value || 0);
    const priceDecimals = price => price < 10 ? 5 : price < 100 ? 4 : 2;

    const updateBreakEven = () => {
        const output = document.getElementById('breakeven-output');
        if (!lastMarketPrice || !window.EToroAnalytics) return;
        const leverage = readNumber('lev-amount');
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
        const longEntry = lastAskPrice || lastMarketPrice;
        const shortEntry = lastBidPrice || lastMarketPrice;
        const common = {
            investment: readNumber('inv-amount'), leverage,
            openFeePercent: fee.openFeePercent,
            closeFeePercent: fee.closeFeePercent
        };
        const longResult = window.EToroAnalytics.calculateBreakEvenTP({ ...common, side: 'long', entryPrice: longEntry });
        const shortResult = window.EToroAnalytics.calculateBreakEvenTP({ ...common, side: 'short', entryPrice: shortEntry });
        const priceEl = document.getElementById('current-price');
        const sourceEl = document.getElementById('price-source');
        const priceLabel = document.getElementById('market-price-label');
        if (lastBidPrice && lastAskPrice) {
            priceEl.textContent = `${lastBidPrice.toFixed(priceDecimals(lastBidPrice))} / ${lastAskPrice.toFixed(priceDecimals(lastAskPrice))}`;
            sourceEl.textContent = 'Sell / Buy · source: eToro';
            priceLabel.textContent = 'Executable prices';
        } else {
            priceEl.textContent = lastMarketPrice.toFixed(priceDecimals(lastMarketPrice));
            sourceEl.textContent = `Source: ${lastPriceSource}`;
            priceLabel.textContent = 'Reference price';
        }
        const feeEl = document.getElementById('fee-profile');
        if (feeEl) {
            feeEl.textContent = fee.label;
            feeEl.classList.toggle('fee-warning', !fee.known);
        }

        if (!output) return;

        if (!longResult.ok || !shortResult.ok) {
            output.textContent = longResult.error || shortResult.error;
            output.classList.add('cost-error');
            return;
        }

        output.classList.remove('cost-error');
        const decimals = priceDecimals(lastMarketPrice);
        output.innerHTML = `<div><span>If long</span><b>Sell ≥ ${longResult.targetPrice.toFixed(decimals)}</b><small>rise ${longResult.distancePercent.toFixed(3)}%</small></div>`
            + `<div><span>If short</span><b>Buy ≤ ${shortResult.targetPrice.toFixed(decimals)}</b><small>drop ${shortResult.distancePercent.toFixed(3)}%</small></div>`
            + `<p><b>Estimated total cost: $${longResult.estimatedCostAtTarget.toFixed(2)}</b> · includes opening and closing</p>`;
    };

    const updateTradePlan = () => {
        const output = document.getElementById('trade-plan-output');
        if (!output || !lastCombinedAnalysis || !(lastAtrValue > 0) || !lastMarketPrice) return;
        const leverage = readNumber('lev-amount');
        const investment = readNumber('inv-amount');
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
        const exposure = investment * leverage;
        const roundTripCost = fee.known ? exposure * (fee.openFeePercent + fee.closeFeePercent) / 100 : null;
        const renderSide = side => {
            const entryPrice = side === 'long' ? (lastAskPrice || lastMarketPrice) : (lastBidPrice || lastMarketPrice);
            const result = window.EToroAnalytics.calculateBestZoneTradePlan({
                side, entryPrice, investment, leverage, atr: lastAtrValue,
                supports: lastCombinedAnalysis.zones.supports,
                resistances: lastCombinedAnalysis.zones.resistances,
                openFeePercent: fee.openFeePercent, closeFeePercent: fee.closeFeePercent,
                stopBufferAtr: 0.10, recommendedAtrMultiple: 1.50,
                openingCostMultiple: 2, roundTripCostMultiple: 2
            });
            if (!result.ok) return `<section class="trade-side"><h4>${side.toUpperCase()}</h4><div class="plan-warning">${result.error}</div></section>`;
            const plans = result.fallback ? [result.best] : result.combinations.filter(plan => plan.valid).slice(0, 4);
            const decimals = priceDecimals(entryPrice);
            const rows = plans.map((plan, index) => {
                const margin = roundTripCost === null ? null : plan.potentialProfit - roundTripCost;
                return `<div class="trade-combination">
                    <b>#${index + 1}${plan.fallback ? ' · ATR fallback' : ''}</b>
                    <span>Entry <strong>${entryPrice.toFixed(decimals)}</strong></span>
                    <span>TP <strong>${plan.technicalTarget.toFixed(decimals)}</strong> · +$${plan.potentialProfit.toFixed(2)}</span>
                    <span>SL <strong>${plan.technicalStop.toFixed(decimals)}</strong> · −$${plan.potentialLoss.toFixed(2)}</span>
                    <span>R/R <strong>${plan.rewardRisk.toFixed(2)}</strong> · open + close ${roundTripCost === null ? 'verify' : `$${roundTripCost.toFixed(2)}`}</span>
                    <span class="${margin !== null && margin > 0 ? 'margin-positive' : 'margin-negative'}">Profit margin <strong>${margin === null ? 'verify' : `${margin >= 0 ? '+' : '−'}$${Math.abs(margin).toFixed(2)}`}</strong></span>
                </div>`;
            }).join('');
            return `<section class="trade-side"><h4>${side.toUpperCase()} · ${plans.length} usable combination${plans.length === 1 ? '' : 's'}</h4>${rows}</section>`;
        };
        output.innerHTML = renderSide('long') + renderSide('short');
    };

    const aggregateScannerCandles = (candles, groupSize = 1) => {
        if (groupSize <= 1) return candles;
        const completeLength = Math.floor(candles.length / groupSize) * groupSize;
        const source = candles.slice(candles.length - completeLength);
        const grouped = [];
        for (let index = 0; index < source.length; index += groupSize) {
            const group = source.slice(index, index + groupSize);
            grouped.push({
                t: group[0].t,
                o: group[0].o ?? group[0].c,
                h: Math.max(...group.map(candle => candle.h)),
                l: Math.min(...group.map(candle => candle.l)),
                c: group.at(-1).c,
                v: group.every(candle => Number.isFinite(candle.v))
                    ? group.reduce((sum, candle) => sum + candle.v, 0) : NaN
            });
        }
        return grouped;
    };

    const analyzeScannerSeries = (asset, timeframe, rawCandles) => {
        const candles = aggregateScannerCandles(rawCandles, timeframe.aggregate || 1);
        if (candles.length < N) return { asset, timeframe, error: `Only ${candles.length}/${N} candles` };
        const sample = candles.slice(-N);
        const prices = sample.map(candle => candle.c);
        const atr = calculateATR(candles, 14);
        if (!(atr > 0)) return { asset, timeframe, error: 'ATR unavailable' };
        const combined = window.EToroAnalytics.analyzeCombined(prices, atr, {
            ...modelParams, harmonics: SCANNER_HARMONICS, horizon: 10, candles: sample
        });
        const current = prices.at(-1);
        const investment = Math.max(10, readNumber('inv-amount'));
        const fee = window.EToroAnalytics.getEtoroFeeProfile(asset.symbol, 1);
        const planFor = side => window.EToroAnalytics.calculateBestZoneTradePlan({
            side, entryPrice: current, investment, leverage: 1, atr,
            supports: combined.zones.supports, resistances: combined.zones.resistances,
            openFeePercent: fee.openFeePercent, closeFeePercent: fee.closeFeePercent,
            stopBufferAtr: 0.10, recommendedAtrMultiple: 1.50,
            openingCostMultiple: 2, roundTripCostMultiple: 2
        });
        const longPlan = planFor('long');
        const shortPlan = planFor('short');
        const projection = window.EToroAnalytics.projectFourierToTargets(prices, atr, {
            harmonics: SCANNER_HARMONICS,
            horizonBars: 10,
            longTarget: longPlan.ok ? longPlan.best.technicalTarget : Infinity,
            shortTarget: shortPlan.ok ? shortPlan.best.technicalTarget : -Infinity
        });
        const filters = window.EToroAnalytics.analyzeMarketFilters(candles.slice(-200));
        const roundTripCost = fee.known
            ? investment * (fee.openFeePercent + fee.closeFeePercent) / 100
            : null;
        const openingCost = fee.known ? investment * fee.openFeePercent / 100 : 0;
        const alternatives = [
            { side: 'long', plan: longPlan }, { side: 'short', plan: shortPlan }
        ].map(item => {
            const costExcursion = window.EToroAnalytics.analyzeCostAdjustedExcursion(prices, {
                side: item.side, horizonBars: 10, lookback: 200,
                investment, leverage: 1, openingCost,
                roundTripCost: roundTripCost || 0,
                requiredNetMultiple: 2, minimumHitRate: 0.55
            });
            const decision = window.EToroAnalytics.evaluateEntryDecision({
                side: item.side, projection, plan: item.plan, feeKnown: fee.known,
                atr, atrMultiple: 1.50, openingCost, roundTripCost,
                requiredNetMultiple: 2, costExcursion
            });
            const passed = decision.checks.filter(check => check.pass).length;
            const plan = item.plan.ok ? item.plan.best : null;
            const ranking = window.EToroAnalytics.calculateOpportunityRisk({
                investment,
                potentialLoss: plan?.potentialLoss,
                potentialProfit: plan?.potentialProfit,
                roundTripCost,
                feeKnown: fee.known,
                atrPercentile: filters.ok ? filters.atrPercentile : 100,
                confirmations: passed,
                excursionHitRate: costExcursion.ok ? costExcursion.hitRate : 0,
                fallback: Boolean(item.plan.fallback || plan?.fallback)
            });
            return { ...item, decision, passed, ranking, costExcursion };
        }).sort((a, b) => a.ranking.riskScore - b.ranking.riskScore
            || b.ranking.opportunityScore - a.ranking.opportunityScore
            || b.passed - a.passed);
        const best = alternatives[0];
        const fourierPass = best.decision.checks.find(check => check.key === 'fourier')?.pass === true;
        const category = best.decision.allowed ? 'operate' : best.passed >= 4 && fourierPass ? 'near' : 'avoid';
        const plan = best.plan.ok ? best.plan.best : null;
        const projectedMove = projection.winner?.direction === (best.side === 'long' ? 'up' : 'down')
            ? projection.winner : null;
        const units = investment / current;
        const atrUsd = units * atr;
        const lossUsd = plan?.potentialLoss || 0;
        const profitUsd = plan?.potentialProfit || 0;
        const { netProfit, riskScore, riskLevel, opportunityScore } = best.ranking;
        return {
            asset, timeframe, current, atr, filters, category,
            side: best.side, passed: best.passed, checks: best.decision.checks,
            rewardRisk: plan?.rewardRisk || 0,
            targetPrice: plan?.technicalTarget, stopPrice: plan?.technicalStop,
            targetPercent: plan?.targetPercent, stopPercent: plan?.stopPercent,
            atrPercent: atr / current * 100,
            profit: profitUsd, loss: lossUsd, atrUsd,
            openingCost,
            roundTripCost, netProfit, feeKnown: fee.known,
            costExcursion: best.costExcursion,
            riskScore, riskLevel, opportunityScore,
            targetFallback: Boolean(best.plan.fallback || plan?.fallback || !plan?.targetIndex),
            investment, source: 'Yahoo Finance', harmonics: projection.harmonics,
            atrHours: projectedMove ? projectedMove.atrBar * timeframe.minutes / 60 : null,
            targetHours: projectedMove ? projectedMove.targetBar * timeframe.minutes / 60 : null
        };
    };

    const renderScannerResults = results => {
        const container = document.getElementById('scanner-results');
        const riskRank = { low: 0, medium: 1, high: 2 };
        results.sort((a, b) => (riskRank[a.riskLevel] ?? 3) - (riskRank[b.riskLevel] ?? 3)
            || (b.opportunityScore ?? -Infinity) - (a.opportunityScore ?? -Infinity)
            || (b.netProfit ?? b.profit ?? -Infinity) - (a.netProfit ?? a.profit ?? -Infinity));
        container.innerHTML = results.map(result => {
            if (result.error) return `<article class="scanner-card avoid"><div class="scanner-card-head"><b>${result.asset.symbol} · ${result.timeframe.label}</b><span>NOT VIABLE</span></div><small>${result.error}</small></article>`;
            const decimals = priceDecimals(result.current);
            const direction = result.side === 'long' ? 'LONG' : 'SHORT';
            const riskLabel = result.riskLevel === 'low' ? 'LOW RISK' : result.riskLevel === 'medium' ? 'MEDIUM RISK' : 'HIGH RISK';
            const signalLabel = result.category === 'operate' ? direction : result.category === 'near' ? `NEAR · ${direction}` : `WATCH · ${direction}`;
            const failed = result.checks.filter(check => !check.pass).map(check => check.label).join(' · ');
            const formatHours = hours => hours === null ? '--' : hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(hours % 1 ? 1 : 0)} h`;
            return `<article class="scanner-card ${result.category} risk-${result.riskLevel}">
                <div class="scanner-card-head"><b>${result.asset.symbol} · ${result.timeframe.label}</b><span>${riskLabel}</span></div>
                <div class="scanner-asset-name">${result.asset.name} · ${signalLabel} · ${result.passed}/6 checks</div>
                <div class="scanner-prices"><span>Current <b>${result.current.toFixed(decimals)}</b></span><span>TP <b>${Number.isFinite(result.targetPrice) ? `${result.targetPrice.toFixed(decimals)} · ${result.targetPercent.toFixed(2)}%` : '--'}</b></span><span>SL <b>${Number.isFinite(result.stopPrice) ? `${result.stopPrice.toFixed(decimals)} · ${result.stopPercent.toFixed(2)}%` : '--'}</b></span></div>
                <div class="scanner-money"><span>Gross TP <b>+$${Number.isFinite(result.profit) ? result.profit.toFixed(2) : '--'}</b></span><span>SL risk <b>−$${Number.isFinite(result.loss) ? result.loss.toFixed(2) : '--'}</b></span><span>R/R <b>${result.rewardRisk.toFixed(2)}</b></span></div>
                <div class="scanner-money"><span>ATR <b>${result.atr.toFixed(decimals)} · ${result.atrPercent.toFixed(2)}%</b></span><span>ATR in $ <b>$${result.atrUsd.toFixed(2)}</b></span><span>Net TP <b>${result.netProfit === null ? 'verify' : `${result.netProfit >= 0 ? '+' : '−'}$${Math.abs(result.netProfit).toFixed(2)}`}</b></span></div>
                <div class="scanner-money"><span>Net goal <b>$${result.costExcursion?.requiredNetProfit?.toFixed(2) || '--'}</b></span><span>Gross required <b>$${result.costExcursion?.requiredGrossProfit?.toFixed(2) || '--'}</b></span><span>Historical hit <b>${result.costExcursion?.ok ? `${(result.costExcursion.hitRate * 100).toFixed(0)}% · ${result.costExcursion.medianHitBars?.toFixed(1) || '--'} bars` : '--'}</b></span></div>
                <div class="scanner-forecast"><span>Fourier <b>${result.harmonics} cycles</b></span><span>1 ATR <b>${formatHours(result.atrHours)}</b></span><span>TP <b>${formatHours(result.targetHours)}</b></span></div>
                <small>${result.targetFallback ? 'Fallback TP ≥ 1.5 × SL (raised when costs require it)' : 'TP based on a Wavelet zone'} · median favorable excursion ${result.costExcursion?.ok ? `$${result.costExcursion.medianGrossProfit.toFixed(2)}` : '--'} · position $${result.investment.toFixed(2)} X1 · round-trip cost ${result.roundTripCost === null ? 'not verified' : `$${result.roundTripCost.toFixed(2)}`} · risk ${(result.riskScore * 100).toFixed(0)}/100${failed ? ` · Missing: ${failed}` : ' · All checks present'}</small>
            </article>`;
        }).join('');
    };

    const runOpportunityScanner = async () => {
        if (scannerRunning) return;
        scannerRunning = true;
        const button = document.getElementById('scanner-refresh');
        const progress = document.getElementById('scanner-progress');
        button.disabled = true;
        button.textContent = '…';
        const jobs = SCANNER_ASSETS.flatMap(asset => SCANNER_TIMEFRAMES.map(timeframe => ({ asset, timeframe })));
        const results = [];
        try {
            for (let index = 0; index < jobs.length; index++) {
                const { asset, timeframe } = jobs[index];
                progress.textContent = `Scanning ${index + 1}/${jobs.length}: ${asset.symbol} ${timeframe.label}`;
                try {
                    const candles = await fetchHistory(asset.yahoo, timeframe.interval, timeframe.range);
                    results.push(analyzeScannerSeries(asset, timeframe, candles));
                } catch (error) {
                    results.push({ asset, timeframe, error: error.message || 'Download error' });
                }
                if ((index + 1) % 4 === 0) renderScannerResults(results);
            }
            renderScannerResults(results);
            lastScannerResults = results;
            document.getElementById('scanner-updated').textContent = `Latest: ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
            progress.textContent = `${results.length} combinations analyzed · indicative prices`;
        } finally {
            scannerRunning = false;
            button.disabled = false;
            button.textContent = 'Scan';
        }
    };

    const scheduleOpportunityScanner = () => {
        if (scannerTimer) clearInterval(scannerTimer);
        const minutes = Number(document.getElementById('scanner-interval')?.value || 10);
        localStorage.setItem('atr-scanner-interval', String(minutes));
        scannerTimer = setInterval(runOpportunityScanner, minutes * 60 * 1000);
    };

    const downloadDiagnosticBundle = () => {
        const now = new Date();
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, readNumber('lev-amount'));
        const payload = {
            schema: 'etoro-chart-comparison-v2',
            generatedAt: now.toISOString(),
            extension: {
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                note: 'Technical file without name, email, total balance or account identifiers.'
            },
            instrument: {
                symbol: lastSymbol,
                timeframe: lastTimeframe,
                pageUrl: window.location.href,
                marketPrice: lastMarketPrice,
                bid: lastBidPrice,
                ask: lastAskPrice,
                priceSource: lastPriceSource,
                historyAlignedToEtoro,
                historyScaleFactor,
                historyPriceOffset,
                observedEtoroCandles: candlesHistory.filter(candle => candle.source === 'etoro-observed').length,
                historicalProxy: lastSymbol === 'GOLD' ? 'Yahoo GC=F adjusted by additive live basis' : 'Yahoo proxy adjusted by additive live basis'
            },
            chartConfiguration: {
                visibleHistoricalCandles: visibleHistoryCount,
                projectedCandles: projectionBars,
                priceDisplay: chartPriceMode,
                tradeSide: chartTradeSide,
                fourierHarmonics: visibleCyclesCount,
                waveletLevels: visibleWaveletLevels,
                layers: {
                    fourier: document.getElementById('show-fourier')?.checked,
                    atr: document.getElementById('show-atr')?.checked,
                    takeProfit: document.getElementById('show-tp')?.checked,
                    stopLoss: document.getElementById('show-sl')?.checked
                }
            },
            positionInputs: {
                investmentUsd: readNumber('inv-amount'),
                leverage: readNumber('lev-amount'),
                selectedSide: chartTradeSide,
                feeProfile: fee
            },
            latestIndicators: {
                atr14: lastAtrValue,
                combinedAnalysis: lastCombinedAnalysis,
                marketFilters: lastMarketFilters,
                fourierProjection: lastFutureProjection,
                entryDecision: lastEntryDecision,
                tradePlans: lastTradePlans,
                calibratedModelParameters: modelParams
            },
            pluginCandlesAlignedToEtoro: candlesHistory.map(candle => ({
                timestamp: candle.t,
                isoTime: Number.isFinite(candle.t) ? new Date(candle.t * 1000).toISOString() : null,
                open: candle.o ?? null,
                high: candle.h,
                low: candle.l,
                close: candle.c,
                volume: Number.isFinite(candle.v) ? candle.v : null,
                source: candle.source || 'unknown'
            })),
            yahooCandlesOriginal: rawYahooCandles.map(candle => ({
                timestamp: candle.t,
                isoTime: Number.isFinite(candle.t) ? new Date(candle.t * 1000).toISOString() : null,
                open: candle.o ?? null,
                high: candle.h,
                low: candle.l,
                close: candle.c,
                volume: Number.isFinite(candle.v) ? candle.v : null
            })),
            etoroObservedCandle: liveCandle ? {
                timestamp: liveCandle.t,
                isoTime: new Date(liveCandle.t * 1000).toISOString(),
                open: liveCandle.o,
                high: liveCandle.h,
                low: liveCandle.l,
                close: liveCandle.c,
                volume: Number.isFinite(liveCandle.v) ? liveCandle.v : null,
                partial: true,
                excludedFromIndicators: true
            } : null,
            sourceComparison: (() => {
                const yahooClose = rawYahooCandles.at(-1)?.c;
                const alignedClose = candlesHistory.at(-1)?.c;
                const latestAlignedProxy = [...candlesHistory].reverse().find(candle => candle.source !== 'etoro-observed');
                const aggregatedYahooClose = Number.isFinite(latestAlignedProxy?.c)
                    ? latestAlignedProxy.c - historyPriceOffset : null;
                const etoroReference = lastBidPrice && lastAskPrice
                    ? (lastBidPrice + lastAskPrice) / 2 : (lastMarketPrice || liveCandle?.c);
                const compare = source => Number.isFinite(source) && Number.isFinite(etoroReference)
                    ? { absolute: etoroReference - source, percent: (etoroReference / source - 1) * 100 } : null;
                return {
                    etoroReference,
                    yahooLastRawQuote: yahooClose,
                    yahooLastAggregatedCloseBeforeAlignment: aggregatedYahooClose,
                    pluginAlignedLastClose: alignedClose,
                    etoroMinusYahoo: compare(yahooClose),
                    etoroMinusAggregatedYahoo: compare(aggregatedYahooClose),
                    etoroMinusPluginAligned: compare(alignedClose),
                    warning: 'eToro does not expose its complete chart series in the page DOM. Only the observed eToro candle and executable quotes can be exported; historical candles come from Yahoo Finance.'
                };
            })(),
            interpretationWarnings: [
                'Yahoo quotes may differ from executable eToro prices.',
                'The Fourier band uses the historical 90th-percentile validation error; it is empirical but is not a formal confidence interval.',
                'Costs may exclude overnight financing, slippage, currency conversion and taxes.'
            ]
        };
        const safeSymbol = String(lastSymbol || 'asset').replace(/[^A-Z0-9_-]/gi, '_');
        const filename = `etoro-diagnostic-${safeSymbol}-${lastTimeframe || 'tf'}-${now.toISOString().replace(/[:.]/g, '-')}.json`;
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const refreshEtoroQuotes = () => {
        const metadata = getMetadata();
        if (metadata.symbol && (metadata.symbol !== lastSymbol || metadata.timeframe !== lastTimeframe)) {
            monitor();
            return false;
        }
        const quotes = getEtoroQuotes();
        if (!quotes.bid && !quotes.ask) return false;
        const nextBid = quotes.bid || lastBidPrice;
        const nextAsk = quotes.ask || lastAskPrice;
        const quotesChanged = nextBid !== lastBidPrice || nextAsk !== lastAskPrice;
        lastBidPrice = nextBid;
        lastAskPrice = nextAsk;
        lastMarketPrice = lastBidPrice && lastAskPrice
            ? (lastBidPrice + lastAskPrice) / 2
            : (lastBidPrice || lastAskPrice);
        lastPriceSource = 'executable eToro prices';
        let historyJustAligned = false;
        if (!historyAlignedToEtoro && candlesHistory.length) {
            const latestProxy = [...candlesHistory].reverse().find(candle => candle.source !== 'etoro-observed');
            const historicalLast = latestProxy?.c;
            const offset = lastMarketPrice - historicalLast;
            if (Number.isFinite(offset) && Math.abs(offset) < lastMarketPrice * 0.20) {
                candlesHistory = candlesHistory.map(candle => ({
                    ...candle,
                    o: candle.source === 'etoro-observed' || !Number.isFinite(candle.o) ? candle.o : candle.o + offset,
                    h: candle.source === 'etoro-observed' || !Number.isFinite(candle.h) ? candle.h : candle.h + offset,
                    l: candle.source === 'etoro-observed' || !Number.isFinite(candle.l) ? candle.l : candle.l + offset,
                    c: candle.source === 'etoro-observed' ? candle.c : candle.c + offset
                }));
                historyScaleFactor = 1;
                historyPriceOffset = offset;
                historyAlignedToEtoro = true;
                historyJustAligned = true;
                performCalculations(lastTimeframe, lastSymbol);
            }
        }
        if (!quotesChanged && !historyJustAligned) return false;
        updateBreakEven();
        updateTradePlan();
        return true;
    };

    const calibrateHistoricalModel = (symbol, timeframe, prices, reason = 'automatic') => {
        const token = ++calibrationToken;
        const status = document.getElementById('calibration-status');
        if (status) status.textContent = `Updating (${reason}) · 0.01 steps…`;
        return new Promise(resolve => setTimeout(() => {
            const result = window.EToroAnalytics.calibrateCombinedModel(prices, {
                horizon: 16, maxSamples: 60, minimumSamples: 12
            });
            if (token !== calibrationToken || symbol !== lastSymbol || timeframe !== lastTimeframe) {
                resolve({ ok: false, cancelled: true });
                return;
            }
            if (!result.ok) {
                modelParams = { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
                if (status) status.textContent = result.error;
                resolve(result);
                return;
            }
            modelParams = result.params;
            localStorage.setItem(`atr-model-${symbol}-${timeframe}`, JSON.stringify(result));
            const updatedAt = new Date().toLocaleString('en-GB', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            });
            document.getElementById('model-parameters').textContent =
                `wF ${result.params.fourierWeight.toFixed(2)} · wW ${result.params.waveletWeight.toFixed(2)} · `
                + `wA ${result.params.alignmentWeight.toFixed(2)} · U ${result.params.signalThreshold.toFixed(2)} · `
                + `zone ${result.params.zoneWidthAtr.toFixed(2)} ATR · min. move ${result.params.minMoveAtr.toFixed(2)} ATR`;
            document.getElementById('split-train').textContent =
                `${result.splits.train.count} cases · ${(result.splits.train.accuracy * 100).toFixed(1)}%`;
            document.getElementById('split-test').textContent =
                `${result.splits.test.count} cases · ${(result.splits.test.accuracy * 100).toFixed(1)}%`;
            document.getElementById('split-validation').textContent =
                `${result.splits.validation.count} cases · ${(result.splits.validation.accuracy * 100).toFixed(1)}%`;
            if (status) status.textContent = `Calculated (${reason}) · ${result.samples} chronological cases`;
            document.getElementById('calibration-updated').textContent = `Last update: ${updatedAt}`;
            performCalculations(timeframe, symbol);
            resolve(result);
        }, 0));
    };

    const recalibrateIfAlignmentIsLow = (symbol, timeframe, closedCandles) => {
        const prices = closedCandles.map(candle => candle.c).filter(Number.isFinite);
        if (prices.length < N) {
            calibrateHistoricalModel(symbol, timeframe, prices);
            return;
        }
        const atr = calculateATR(closedCandles, 14);
        const combined = window.EToroAnalytics.analyzeCombined(prices.slice(-N), atr, {
            ...modelParams,
            harmonics: visibleCyclesCount
        });
        if (!combined.active) {
            calibrateHistoricalModel(symbol, timeframe, prices);
            return;
        }
        const status = document.getElementById('calibration-status');
        if (status) {
            const checkedAt = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
            status.textContent = `Checked ${checkedAt} · high alignment ${(combined.score * 100).toFixed(0)}/100; constants retained`;
        }
    };

    const costFields = [
        ['inv-amount', 'atr-plugin-inv'],
        ['lev-amount', 'atr-plugin-lev']
    ];
    costFields.forEach(([id, storageKey]) => {
        document.getElementById(id)?.addEventListener('input', event => {
            localStorage.setItem(storageKey, event.target.value);
            updateBreakEven();
            updateTradePlan();
            if (candlesHistory.length >= N) performCalculations(lastTimeframe, lastSymbol);
        });
    });
    /* ========================================================================
       6. RENDERING AND DRAWING
       ======================================================================== */
    /**
     * Draws the Fourier magnitude spectrum.
     * Shows which frequencies (k) carry the greatest price weight.
     */
    function fourierDraw(mags, peakIdx) {
        const canvas = document.getElementById('fourier-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const max = Math.max(...mags, 1e-12);
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const w = canvas.width / mags.length;

        mags.forEach((m, i) => {
            const h = (m / max) * canvas.height;
            ctx.fillStyle = (i === peakIdx) ? '#00e676' : '#444';
            ctx.fillRect(i * w, canvas.height - h, w - 1, h);
        });
    }

    function originalPriceDraw(prices) {
        const canvas = document.getElementById('original-price-canvas');
        if (!canvas || !prices?.length) return;
        const ctx = canvas.getContext('2d');
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const range = max - min || 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#11151d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        prices.forEach((price, index) => {
            const x = index / Math.max(1, prices.length - 1) * canvas.width;
            const y = canvas.height - (price - min) / range * canvas.height;
            index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.stroke();
    }

    const fourierTurnBars = (component, sampleSize) => {
        const valueAt = index => {
            const angle = 2 * Math.PI * component.k * index / sampleSize;
            return component.real * Math.cos(angle) - component.imag * Math.sin(angle);
        };
        const currentIndex = sampleSize - 1;
        const initialDelta = valueAt(currentIndex + 1) - valueAt(currentIndex);
        const initialSign = Math.sign(initialDelta);
        const maximum = Math.max(2, Math.ceil(sampleSize / component.k));
        for (let step = 2; step <= maximum; step++) {
            const delta = valueAt(currentIndex + step) - valueAt(currentIndex + step - 1);
            if (Math.sign(delta) && Math.sign(delta) !== initialSign) return step - 1;
        }
        return null;
    };

    /**
     * Reconstructs the signal in the time domain.
     * Applies the calculated trend (m, b) and overlays harmonic cycles.
     */
    function reconstructionDraw(spectrum, selectedK, N_val, sample) {
        const canvas    = document.getElementById('reconstruction-canvas');
        const showPrice = document.getElementById('chk-show-price')?.checked;
        if (!canvas || !sample || sample.length < N_val) return;

        const ctx    = canvas.getContext('2d');
        const prices = sample.map(v => v.c);
        const logPrices = prices.map(Math.log);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Linear regression: calculate slope (m) and intercept (b).
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < N_val; i++) {
            sumX += i; sumY += logPrices[i];
            sumXY += i * logPrices[i]; sumX2 += i * i;
        }
        const slope     = (N_val * sumXY - sumX * sumY) / (N_val * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / N_val;

        // 2. Update time labels (market time to Ecuador time).
        const optEcu = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' };
        document.getElementById('leg-time').innerText     = new Date(sample[0].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-mkt-last').innerText = new Date(sample[sample.length - 1].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-slope').innerText    = `${((Math.exp(slope) - 1) * 100).toFixed(3)}%`;

        // 3. Synthesize the signal from the selected K components.
        let signalBase = new Array(N_val).fill(0);
        selectedK.forEach(item => {
            const comp = spectrum[item.k];
            const ampFactor = 2 / N_val; // Critical factor that keeps the blue wave properly scaled.
            for (let i = 0; i < N_val; i++) {
                const angle = (2 * Math.PI * item.k * i) / N_val;
                signalBase[i] += (comp.real * Math.cos(angle) - comp.imag * Math.sin(angle)) * ampFactor;
            }
        });

        // 4. Map back to the real price scale.
        const meanLog = logPrices.reduce((sum, value) => sum + value, 0) / N_val;
        let signalTrended    = signalBase.map((val, i) => Math.exp(val + (slope * i) + intercept));
        let signalOnlyCycles = signalBase.map(val => Math.exp(val + meanLog));

        // 5. Global normalization and drawing.
        const dataToScale = [...prices, ...signalTrended];
        const gMin = Math.min(...dataToScale), gMax = Math.max(...dataToScale), gRange = gMax - gMin || 1;

        const drawLine = (data, color, width = 1.5) => {
            ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
            for (let i = 0; i < N_val; i++) {
                const x = (i / (N_val - 1)) * canvas.width;
                const y = canvas.height - ((data[i] - gMin) / gRange) * canvas.height;
                (i === 0) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        if (showPrice) drawLine(prices, '#00e676', 1);        // Green: actual market.
        drawLine(signalOnlyCycles, '#4fc3f7', 1);            // Blue: cycles only.
        drawLine(signalTrended, '#ff5252', 1.5);             // Red: full reconstruction.
    }

    function drawFourierForecast(result, atr, longTarget, shortTarget, minutesPerBar) {
        const output = document.getElementById('fourier-forecast-output');
        if (!output || !result?.ok) return;
        const list = document.getElementById('fourier-price-list');
        if (!result.enabled) {
            output.innerHTML = `<b class="cycle-turning">FOURIER DISABLED</b><small>${result.disabledReason} · stability ${(result.stability?.score * 100 || 0).toFixed(0)}/100 · endpoint error ${(result.endpointErrorAtr || 0).toFixed(2)} ATR</small>`;
            if (list) list.innerHTML = '';
            return;
        }
        const duration = bars => {
            const totalMinutes = bars * minutesPerBar;
            return totalMinutes < 60 ? `${totalMinutes} min` : `${(totalMinutes / 60).toFixed(totalMinutes % 60 ? 1 : 0)} h`;
        };
        let status;
        if (result.winner) {
            const label = result.winner.direction === 'up' ? 'BULLISH' : 'BEARISH';
            status = `<b class="${result.winner.direction === 'up' ? 'cycle-up' : 'cycle-down'}">${label}</b> · ATR in ${duration(result.winner.atrBar)} · TP in ${duration(result.winner.targetBar)}`;
        } else if (result.upAtrBar !== null || result.downAtrBar !== null) {
            const direction = result.upAtrBar !== null && (result.downAtrBar === null || result.upAtrBar < result.downAtrBar) ? 'BULLISH' : 'BEARISH';
            const bar = direction === 'BULLISH' ? result.upAtrBar : result.downAtrBar;
            status = `<b class="cycle-turning">${direction}: ATR in ${duration(bar)}, TP not reached</b>`;
        } else {
            status = '<b class="cycle-turning">UNCONFIRMED: does not exceed 1 ATR</b>';
        }
        const cycles = result.cycleDirections.map(item => `K${item.k}`).join(', ');
        output.innerHTML = `${status}<small>${result.harmonics}/${result.requestedHarmonics} predictive cycles · adaptive ${result.adaptiveWindow}-candle window · empirical 90% error band (observed coverage ${(result.empiricalCoverage * 100).toFixed(0)}%) · stability ${(result.stability.score * 100).toFixed(0)}/100 · alignment ${(result.alignment * 100).toFixed(0)}/100${result.ambiguous ? ' · ⚠ both directions reach TP' : ''}</small>`;
        const decimals = priceDecimals(result.current);
        list.innerHTML = result.forecast.slice(1, result.horizonBars + 1).map((value, index) =>
            `<span><i>+${index + 1}</i><b>${value.toFixed(decimals)}</b><small>${result.lowerBand[index + 1].toFixed(decimals)}–${result.upperBand[index + 1].toFixed(decimals)}</small></span>`
        ).join('');
    }

    function waveletDraw(prices) {
        const canvas = document.getElementById('wavelet-canvas');
        if (!canvas || !window.EToroAnalytics) return;
        const ctx = canvas.getContext('2d');
        const analysis = window.EToroAnalytics.haarWaveletAnalysis(prices, visibleWaveletLevels);
        if (!analysis.ok) return;
        const mean = prices.reduce((sum, value) => sum + value, 0) / prices.length;
        const componentSignal = analysis.detailSignal.map(value => value + mean);
        const allValues = [...prices, ...componentSignal, ...analysis.reconstruction];
        const min = Math.min(...allValues);
        const max = Math.max(...allValues);
        const range = max - min || 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#11151d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const drawLine = (values, color, width) => {
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            values.forEach((value, index) => {
                const x = (index / (values.length - 1)) * canvas.width;
                const y = canvas.height - ((value - min) / range) * canvas.height;
                index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();
        };
        drawLine(prices, '#00e676', 1);
        drawLine(componentSignal, '#b388ff', 1);
        drawLine(analysis.reconstruction, '#ffb74d', 1.5);

        document.getElementById('wavelet-components').innerHTML = analysis.selected
            .map((component, index) => `#${index + 1}: ${component.scale}-candle scale`)
            .join(' · ');
    }

    function drawUnifiedAnalysis(prices, projection, overlays = {}, candles = []) {
        const canvas = document.getElementById('unified-analysis-canvas');
        if (!canvas || !projection?.ok) return;
        const box = canvas.getBoundingClientRect();
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const targetWidth = Math.max(320, Math.round(box.width * pixelRatio));
        const targetHeight = Math.max(160, Math.round(box.height * pixelRatio));
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;
        }
        const ctx = canvas.getContext('2d');
        const analysisCount = prices.length;
        let fourierCycles = projection.cycleHistory || [];
        let anchoredFourier = projection.fittedHistory || [];
        let cumulativeHistories = (projection.displayCumulativeHistories || projection.cumulativeHistories || []).map(series => [...series]);
        const wavelet = window.EToroAnalytics.haarWaveletAnalysis(prices, visibleWaveletLevels);
        let waveletValues = wavelet.ok ? wavelet.reconstruction : prices;
        const historyStart = Math.max(0, analysisCount - visibleHistoryCount);
        prices = prices.slice(historyStart);
        candles = candles.slice(historyStart);
        const fourierVisibleCount = Math.min(visibleHistoryCount, fourierCycles.length);
        fourierCycles = fourierCycles.slice(-fourierVisibleCount);
        anchoredFourier = anchoredFourier.slice(-fourierVisibleCount);
        cumulativeHistories = cumulativeHistories.map(series => series.slice(-fourierVisibleCount));
        waveletValues = waveletValues.slice(historyStart);
        const count = prices.length;
        const showFourier = document.getElementById('show-fourier')?.checked !== false;
        const future = projection.forecast.slice(1);
        const lower = projection.lowerBand.slice(1);
        const upper = projection.upperBand.slice(1);
        const overlayValues = [overlays.atrLevel, overlays.tp, overlays.sl, overlays.executionPrice].filter(Number.isFinite);
        const candleExtremes = chartPriceMode === 'candles'
            ? candles.flatMap(candle => [candle.l, candle.h]).filter(Number.isFinite) : [];
        const bandValues = projection.enabled ? [...lower, ...upper] : [];
        const cumulativeValues = cumulativeHistories.flat();
        const allValues = [...prices, ...candleExtremes, ...fourierCycles, ...anchoredFourier, ...cumulativeValues, ...waveletValues, ...future, ...bandValues, ...overlayValues];
        const min = Math.min(...allValues);
        const max = Math.max(...allValues);
        const padding = (max - min || 1) * 0.05;
        const low = min - padding;
        const range = max - min + padding * 2 || 1;
        const totalPoints = count + future.length;
        const x = index => index / Math.max(1, totalPoints - 1) * canvas.width;
        const y = value => canvas.height - (value - low) / range * canvas.height;
        const drawLine = (values, startIndex, color, width, dash = []) => {
            ctx.save();
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
            ctx.beginPath();
            values.forEach((value, index) => index ? ctx.lineTo(x(startIndex + index), y(value)) : ctx.moveTo(x(startIndex), y(value)));
            ctx.stroke(); ctx.restore();
        };
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#11151d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
        for (let row = 1; row < 5; row++) {
            ctx.beginPath(); ctx.moveTo(0, canvas.height * row / 5); ctx.lineTo(canvas.width, canvas.height * row / 5); ctx.stroke();
        }
        if (showFourier && projection.enabled) {
            ctx.beginPath();
            ctx.moveTo(x(count - 1), y(projection.upperBand[0]));
            upper.forEach((value, index) => ctx.lineTo(x(count + index), y(value)));
            for (let index = lower.length - 1; index >= 0; index--) ctx.lineTo(x(count + index), y(lower[index]));
            ctx.lineTo(x(count - 1), y(projection.lowerBand[0]));
            ctx.closePath(); ctx.fillStyle = projection.enabled ? 'rgba(233, 103, 255, .16)' : 'rgba(150, 158, 170, .10)'; ctx.fill();
        }
        if (showFourier) {
            const fourierStart = Math.max(0, count - fourierCycles.length);
            drawLine(fourierCycles, fourierStart, projection.enabled ? '#4fc3f7' : '#64758a', 1.1, projection.enabled ? [] : [4, 3]);
            const cumulativeColors = ['#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185'];
            cumulativeHistories.forEach((series, index) => {
                const retained = projection.displayCycleDirections?.[index]?.retained !== false;
                drawLine(series, fourierStart, retained ? cumulativeColors[index % cumulativeColors.length] : '#596474',
                    retained ? 0.85 : 0.65, retained ? [2 + index % 3, 3] : [1, 5]);
            });
            drawLine(anchoredFourier, fourierStart, projection.enabled ? '#ff5252' : '#8a7580', 1.7, projection.enabled ? [] : [4, 3]);
        }
        drawLine(waveletValues, 0, '#ffb74d', 1.3);
        if (chartPriceMode === 'candles' && candles.length === prices.length) {
            const candleWidth = Math.max(2, Math.min(10, canvas.width / Math.max(1, totalPoints) * 0.62));
            candles.forEach((candle, index) => {
                const open = Number(candle.o), high = Number(candle.h), lowPrice = Number(candle.l), close = Number(candle.c);
                if (![open, high, lowPrice, close].every(Number.isFinite)) return;
                const candleX = x(index);
                const rising = close >= open;
                ctx.strokeStyle = rising ? '#00e676' : '#ff5252';
                ctx.fillStyle = rising ? '#00c98b' : '#e94f5f';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(candleX, y(high)); ctx.lineTo(candleX, y(lowPrice)); ctx.stroke();
                const top = Math.min(y(open), y(close));
                const bodyHeight = Math.max(1.5, Math.abs(y(close) - y(open)));
                ctx.fillRect(candleX - candleWidth / 2, top, candleWidth, bodyHeight);
            });
        } else {
            drawLine(prices, 0, '#00e676', 1.8);
        }
        if (showFourier) {
            const cumulativeColors = ['#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185'];
            (projection.displayCumulativeForecasts || projection.cumulativeForecasts || []).forEach((series, index) => {
                const retained = projection.displayCycleDirections?.[index]?.retained !== false;
                drawLine(series, count - 1, retained ? cumulativeColors[index % cumulativeColors.length] : '#596474',
                    retained ? 0.85 : 0.65, retained ? [2, 4] : [1, 5]);
            });
            drawLine(projection.forecast, count - 1, projection.enabled ? '#e967ff' : '#8f98a6', 2, projection.enabled ? [5, 3] : [2, 5]);
        }
        const drawLevel = (value, color, label, dash) => {
            if (!Number.isFinite(value)) return;
            const levelY = y(value);
            ctx.save();
            ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
            ctx.beginPath(); ctx.moveTo(0, levelY); ctx.lineTo(canvas.width, levelY); ctx.stroke();
            ctx.setLineDash([]); ctx.font = 'bold 10px monospace';
            const text = `${label} ${value.toFixed(priceDecimals(value))}`;
            const width = ctx.measureText(text).width + 8;
            ctx.fillStyle = 'rgba(17,21,29,.86)'; ctx.fillRect(canvas.width - width - 3, Math.max(1, levelY - 12), width, 13);
            ctx.fillStyle = color; ctx.fillText(text, canvas.width - width + 1, Math.max(11, levelY - 2));
            ctx.restore();
        };
        if (document.getElementById('show-atr')?.checked !== false) drawLevel(overlays.atrLevel, '#ffd166', `${overlays.sideLabel || ''} 1 ATR`, [7, 4]);
        if (document.getElementById('show-tp')?.checked !== false) drawLevel(overlays.tp, '#55e8a2', 'TP', [3, 3]);
        if (document.getElementById('show-sl')?.checked !== false) drawLevel(overlays.sl, '#ff7d7d', 'SL', [3, 3]);
        drawLevel(overlays.executionPrice, '#dbeafe', `eToro ${overlays.executionLabel || 'PRICE'}`, [2, 4]);
        ctx.fillStyle = '#9aa6b5'; ctx.font = '10px monospace';
        ctx.fillText(max.toFixed(priceDecimals(max)), 4, 12);
        ctx.fillText(min.toFixed(priceDecimals(min)), 4, canvas.height - 5);
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x(count - 1), 0); ctx.lineTo(x(count - 1), canvas.height); ctx.stroke(); ctx.setLineDash([]);
        if (!projection.enabled && showFourier) {
            ctx.fillStyle = 'rgba(17,21,29,.88)'; ctx.fillRect(Math.max(4, canvas.width - 245), 6, 239, 34);
            ctx.fillStyle = '#ffd166'; ctx.font = 'bold 11px monospace';
            ctx.fillText('UNSTABLE FOURIER — DIAGNOSTIC ONLY', Math.max(8, canvas.width - 241), 19);
            ctx.fillStyle = '#9aa6b5'; ctx.font = '9px monospace';
            ctx.fillText(`endpoint ${projection.endpointErrorAtr.toFixed(2)} ATR · stability ${(projection.stability.score * 100).toFixed(0)}/100`, Math.max(8, canvas.width - 241), 33);
        }
        if (wavelet.ok) {
            const zones = overlays.waveletZones;
            const supports = zones?.supports?.length || 0;
            const resistances = zones?.resistances?.length || 0;
            const pivots = zones?.pivots?.length || 0;
            const explanation = pivots
                ? `${pivots} OHLC-confirmed pivots produced ${supports} support and ${resistances} resistance zones.`
                : 'No reconstructed plateau was confirmed as a repeated OHLC pivot; TP/SL therefore uses the ATR fallback.';
            document.getElementById('wavelet-components').innerHTML = `<b>Wavelet regime: ${(zones?.regime || 'unknown').replaceAll('_', ' ').toUpperCase()}</b><br>`
                + `Selected scales: ${wavelet.selected.map(component => `${component.scale} candles`).join(', ')}.<br>${explanation}`
                + (zones?.settings ? `<br>Contacts ≥ ${zones.settings.minContactSeparation} candles apart · confirmation ${zones.settings.confirmationBars} candles · decay half-life ${zones.settings.decayHalfLife} candles.` : '');
        }
    }

    /* ========================================================================
       7. MONITOR PRINCIPAL (LOOP)
       ======================================================================== */
    /**
     * Generates the cycle list HTML with direction indicators.
     */
    const renderListWithHistory = (list, color, isTop, N_val) => {
        return list.map((item, i) => {
            const p = N_val / item.k;
            const label = isTop ? `Cycle ${i + 1}` : `Frequency ${item.k}`;
            const phase = window.EToroAnalytics.fourierComponentDirection(item, N_val);
            const direction = phase.direction === 'up'
                ? { label: 'BULLISH', arrow: '▲', css: 'cycle-up' }
                : phase.direction === 'down'
                    ? { label: 'BEARISH', arrow: '▼', css: 'cycle-down' }
                    : { label: 'TURNING/RANGE', arrow: '◆', css: 'cycle-turning' };
            const turnBars = fourierTurnBars(item, N_val);
            return `<div class="fourier-cycle-row"><span style="color:${color}">${label}</span><b>${p.toFixed(1)}-candle period</b><strong class="${direction.css}" title="Estimated phase direction for the next candle">${direction.arrow} ${direction.label}</strong><small>nearest turn: ${turnBars === null ? '--' : `${turnBars} candle${turnBars === 1 ? '' : 's'}`}</small></div>`;
        }).join('');
    };

    /**
     * Runs the mathematical analysis on the current buffer.
     */
    /**
     * Runs the mathematical analysis on the current buffer.
     */
    
    /**
     * Runs the mathematical analysis on the current buffer.
     */
    const performCalculations = (timeframe, currentSymbol = lastSymbol) => {
        // Entry log.
        console.log(`[ATR] 🧮 Calculating... Buffer: ${candlesHistory.length} candles.`);

        if (candlesHistory.length && !lastBidPrice && !lastAskPrice && !lastPriceSource.includes('eToro')) {
            lastMarketPrice = candlesHistory[candlesHistory.length - 1].c;
            lastPriceSource = 'Yahoo Finance';
            updateBreakEven();
        }

        if (candlesHistory.length < N) {
            console.warn(`[ATR] ⚠️ Insufficient buffer (${candlesHistory.length}/${N}). Waiting for more data...`);
            document.getElementById('fourier-cycle').innerText = `Buffer: ${candlesHistory.length}/${N}`;
            return;
        }

        try {    
            const sample     = candlesHistory.slice(-N); 
            const prices     = sample.map(v => v.c);
            const timeframeMinutes = timeframeToMinutes(timeframe);
            const atrValue = calculateATR(candlesHistory, 14);
            const combined = window.EToroAnalytics.analyzeCombined(prices, atrValue, {
                ...modelParams,
                minMoveAtr: modelParams.minMoveAtr,
                harmonics: visibleCyclesCount,
                horizon: 10,
                candles: sample
            });
            lastCombinedAnalysis = combined;
            lastAtrValue = atrValue;
            const breakEstimate = combined.fourier;
            const slope = breakEstimate?.trendSlope || 0;
            const currentStatusText = Math.abs(slope) < atrValue * 0.01
                ? 'RANGE'
                : slope > 0 ? 'BULLISH' : 'BEARISH';
            const currentStatusColor = slope > 0 ? '#00e676' : slope < 0 ? '#ff5252' : '#ffeb3b';
            const candidate = breakEstimate?.candidate;
            const turnMinutes = candidate ? candidate.bars * timeframeMinutes : null;
            const turnDuration = turnMinutes === null ? '' : turnMinutes < 60
                ? `${turnMinutes} min` : timeframeMinutes >= 1440
                    ? `~${candidate.bars} sessions` : `${(turnMinutes / 60).toFixed(turnMinutes % 60 ? 1 : 0)} h`;
            const projectionText = candidate
                ? `${candidate.direction === 'bullish' ? '▲ BULLISH' : '▼ BEARISH'} · ${candidate.bars} candles · ${turnDuration}`
                : 'NO CANDIDATE';
            const projectionColor = candidate?.direction === 'bullish' ? '#00e676'
                : candidate?.direction === 'bearish' ? '#ff5252' : '#ffeb3b';

            // Update the UI.
            
            // 1. Current state.
            const statusEl = document.getElementById('txt-current-status');
            if (statusEl) {
                statusEl.innerText = currentStatusText;
                statusEl.style.color = currentStatusColor;
            }

            // 2. Future projection.
            const consensusEl = document.getElementById('txt-consensus');
            if (consensusEl) {
                consensusEl.innerText = projectionText;
                consensusEl.style.color = projectionColor;
            }
            const turnPriceEl = document.getElementById('txt-turn-price');
            if (turnPriceEl) {
                turnPriceEl.innerText = candidate ? candidate.price.toFixed(priceDecimals(candidate.price)) : '--';
                turnPriceEl.style.color = projectionColor;
            }
            
            // 3. Time.
            const reversalEl = document.getElementById('txt-reversal');
            if (reversalEl) {
                const waveletLabel = breakEstimate?.waveletActive ? 'Haar active' : 'Haar unconfirmed';
                reversalEl.innerText = waveletLabel;
                reversalEl.style.color = breakEstimate?.waveletActive ? '#ffeb3b' : '#fff';
            }

            const currentPrice = prices.at(-1);
            const recommendedAtrDistance = atrValue * 1.5;
            const sortedSupports = [...combined.zones.supports]
                .filter(zone => currentPrice - zone.high > recommendedAtrDistance)
                .sort((a, b) => Math.abs(a.center - currentPrice) - Math.abs(b.center - currentPrice));
            const sortedResistances = [...combined.zones.resistances]
                .filter(zone => zone.low - currentPrice > recommendedAtrDistance)
                .sort((a, b) => Math.abs(a.center - currentPrice) - Math.abs(b.center - currentPrice));
            const exposureUnits = (readNumber('inv-amount') * readNumber('lev-amount')) / currentPrice;
            const zoneOption = (zone, index, prefix) => {
                const decimals = priceDecimals(zone.center);
                const priceDistance = Math.abs(zone.center - currentPrice);
                const dollarImpact = exposureUnits * priceDistance;
                return `<option>${prefix}${index + 1} · price ${zone.low.toFixed(decimals)}–${zone.high.toFixed(decimals)} · impact $${dollarImpact.toFixed(2)} · zone ${(zone.strength * 100).toFixed(0)}/100</option>`;
            };
            const atrDecimals = priceDecimals(currentPrice);
            document.getElementById('current-atr-distance').innerText = `${atrValue.toFixed(atrDecimals)} · ${(atrValue / currentPrice * 100).toFixed(2)}%`;
            document.getElementById('recommended-atr').innerText = `1.50 ATR = ${recommendedAtrDistance.toFixed(atrDecimals)} · $${(exposureUnits * recommendedAtrDistance).toFixed(2)}`;
            
            // Update the remaining data.
            document.getElementById('f-samples').innerText = candlesHistory.length;
            document.getElementById('f-tf').innerText      = timeframe.toUpperCase();
            
            const valAtrEl = document.getElementById('val-atr');
            if (valAtrEl) valAtrEl.innerText = atrValue.toFixed((currentSymbol === 'SILVER' || currentSymbol === 'XAGUSD') ? 4 : 2);
            
            const leverage = readNumber('lev-amount');
            const investment = readNumber('inv-amount');
            const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
            const planFor = side => window.EToroAnalytics.calculateBestZoneTradePlan({
                side,
                entryPrice: side === 'long' ? (lastAskPrice || currentPrice) : (lastBidPrice || currentPrice),
                investment, leverage, atr: atrValue,
                supports: combined.zones.supports,
                resistances: combined.zones.resistances,
                openFeePercent: fee.openFeePercent,
                closeFeePercent: fee.closeFeePercent,
                stopBufferAtr: 0.10,
                recommendedAtrMultiple: 1.50,
                openingCostMultiple: 2,
                roundTripCostMultiple: 2
            });
            const longPlan = planFor('long');
            const shortPlan = planFor('short');
            const longTarget = longPlan.ok ? longPlan.best.technicalTarget : Infinity;
            const shortTarget = shortPlan.ok ? shortPlan.best.technicalTarget : -Infinity;
            const futureProjection = window.EToroAnalytics.projectFourierToTargets(prices, atrValue, {
                harmonics: visibleCyclesCount,
                horizonBars: projectionBars,
                minPeriodBars: 10,
                longTarget,
                shortTarget
            });
            const latestClosedAt = sample.at(-1)?.t + timeframeMinutes * 60;
            const dataAgeSeconds = Number.isFinite(latestClosedAt) ? Math.max(0, Date.now() / 1000 - latestClosedAt) : Infinity;
            const dataAgeBars = dataAgeSeconds / Math.max(60, timeframeMinutes * 60);
            const dataFresh = dataAgeBars <= 1.5;
            futureProjection.modelEnabled = futureProjection.enabled;
            futureProjection.dataFresh = dataFresh;
            futureProjection.dataAgeBars = dataAgeBars;
            if (!dataFresh) {
                const staleReason = `historical series is ${dataAgeBars.toFixed(1)} candles stale (maximum 1.5)`;
                futureProjection.enabled = false;
                futureProjection.rejectionReasons = [staleReason, ...(futureProjection.rejectionReasons || [])];
                futureProjection.disabledReason = futureProjection.rejectionReasons.join('; ');
            }
            const priceSign = currentStatusText === 'BULLISH' ? 1 : currentStatusText === 'BEARISH' ? -1 : 0;
            const fourierUsable = futureProjection.enabled && dataFresh;
            const fourierDelta = fourierUsable
                ? futureProjection.forecast.at(-1) - futureProjection.current : 0;
            const fourierSign = Math.abs(fourierDelta) >= atrValue * 0.25 ? Math.sign(fourierDelta) : 0;
            const waveletRegime = combined.zones.regime || 'range';
            const waveletSign = ['trending_up', 'bullish_breakout'].includes(waveletRegime) ? 1
                : ['trending_down', 'bearish_breakout'].includes(waveletRegime) ? -1 : 0;
            const votes = [priceSign, fourierSign, waveletSign].filter(Boolean);
            const bullishVotes = votes.filter(value => value > 0).length;
            const bearishVotes = votes.filter(value => value < 0).length;
            const consensusSign = dataFresh ? (bullishVotes >= 2 ? 1 : bearishVotes >= 2 ? -1 : 0) : 0;
            const conflict = new Set(votes).size > 1;
            const zonesForEvidence = [...combined.zones.supports, ...combined.zones.resistances];
            const waveletEvents = zonesForEvidence.reduce((sum, zone) => sum + zone.bounces + zone.breaks, 0);
            const waveletBounceRate = waveletEvents
                ? zonesForEvidence.reduce((sum, zone) => sum + zone.bounces, 0) / waveletEvents : 0;
            const agreement = votes.length ? Math.max(bullishVotes, bearishVotes) / 3 : 0;
            const empiricalConfidence = dataFresh ? Math.max(0, Math.min(1,
                (futureProjection.enabled ? futureProjection.validationDirectionAccuracy * 0.65 : 0)
                + waveletBounceRate * 0.20 + agreement * 0.15)) : 0;
            const setSignal = (id, text, color) => {
                const element = document.getElementById(id); element.textContent = text; element.style.color = color;
            };
            setSignal('signal-price-trend', dataFresh ? currentStatusText : `${currentStatusText} · STALE`, dataFresh ? currentStatusColor : '#ff7d7d');
            setSignal('signal-fourier-direction', !dataFresh ? 'STALE DATA' : !futureProjection.enabled ? 'DISABLED'
                : fourierSign > 0 ? 'BULLISH' : fourierSign < 0 ? 'BEARISH' : 'RANGE',
                !dataFresh ? '#ff7d7d' : !futureProjection.enabled ? '#ffd166' : fourierSign > 0 ? '#55e8a2' : fourierSign < 0 ? '#ff7d7d' : '#ffd166');
            setSignal('signal-wavelet-regime', waveletRegime.replaceAll('_', ' ').toUpperCase(),
                waveletSign > 0 ? '#55e8a2' : waveletSign < 0 ? '#ff7d7d' : '#ffd166');
            setSignal('signal-consensus', consensusSign > 0 ? 'BULLISH' : consensusSign < 0 ? 'BEARISH' : 'NO SIGNAL',
                consensusSign > 0 ? '#55e8a2' : consensusSign < 0 ? '#ff7d7d' : '#ffd166');
            setSignal('signal-conflict', conflict ? 'YES' : 'NO', conflict ? '#ff7d7d' : '#55e8a2');
            setSignal('signal-confidence', `${(empiricalConfidence * 100).toFixed(0)}/100`,
                empiricalConfidence >= 0.65 ? '#55e8a2' : empiricalConfidence >= 0.45 ? '#ffd166' : '#ff7d7d');
            document.getElementById('signal-confidence').title = 'Empirical diagnostic score from Fourier holdout accuracy, Wavelet bounce history and method agreement; not a probability.';
            document.getElementById('fourier-cycle').innerText = !dataFresh
                ? `Diagnostic only · historical series is ${dataAgeBars.toFixed(1)} candles stale`
                : futureProjection.enabled
                ? `Adaptive ${futureProjection.adaptiveWindow} candles · requested ${futureProjection.requestedHarmonics}, retained ${futureProjection.harmonics} · stability ${(futureProjection.stability.score * 100).toFixed(0)}/100`
                : `Fourier diagnostic only · requested ${futureProjection.requestedHarmonics}, retained ${futureProjection.harmonics}`;
            document.getElementById('fourier-top-list').innerHTML = (futureProjection.displayCycleDirections || futureProjection.cycleDirections).map((cycle, index) =>
                `<div class="fourier-cycle-row ${cycle.retained === false ? 'cycle-excluded' : ''}"><div class="fourier-cycle-head"><span>C${index + 1} · f=${cycle.k.toFixed(2)}</span><b>${cycle.period.toFixed(1)}-candle cycle</b><strong class="${cycle.direction === 'up' ? 'cycle-up' : cycle.direction === 'down' ? 'cycle-down' : 'cycle-turning'}">${cycle.direction.toUpperCase()}</strong></div><div class="fourier-cycle-state">${cycle.retained === false ? 'DIAGNOSTIC ONLY · EXCLUDED FROM SIGNAL' : 'RETAINED BY VALIDATION'}</div><div class="fourier-cycle-metrics"><span>Amplitude <b>≈ ${(currentPrice * cycle.amplitude).toFixed(priceDecimals(currentPrice))}</b></span><span>Next contribution <b>${currentPrice * cycle.delta >= 0 ? '+' : ''}${(currentPrice * cycle.delta).toFixed(priceDecimals(currentPrice))}</b></span></div></div>`
            ).join('');

            const etoroReference = lastBidPrice && lastAskPrice ? (lastBidPrice + lastAskPrice) / 2 : lastMarketPrice;
            const rawYahoo = rawYahooCandles.at(-1)?.c;
            const alignedDifference = Number.isFinite(etoroReference) ? currentPrice - etoroReference : null;
            const rawDifference = Number.isFinite(etoroReference) && Number.isFinite(rawYahoo) ? rawYahoo - etoroReference : null;
            const spread = lastBidPrice && lastAskPrice ? lastAskPrice - lastBidPrice : null;
            const fit = futureProjection.fitDiagnostics;
            const discrepancyClass = valueAtr => valueAtr > 1 ? 'discrepancy-bad' : valueAtr > 0.5 ? 'discrepancy-warning' : '';
            const discrepancyOutput = document.getElementById('discrepancy-output');
            discrepancyOutput.innerHTML = `
                <span class="${discrepancyClass(Math.abs(alignedDifference || 0) / atrValue)}">Aligned close − eToro mid <b>${Number.isFinite(alignedDifference) ? `${alignedDifference >= 0 ? '+' : ''}${alignedDifference.toFixed(priceDecimals(currentPrice))} (${(alignedDifference / atrValue).toFixed(2)} ATR)` : 'unavailable'}</b></span>
                <span class="${discrepancyClass(Math.abs(rawDifference || 0) / atrValue)}">Raw Yahoo − eToro mid <b>${Number.isFinite(rawDifference) ? `${rawDifference >= 0 ? '+' : ''}${rawDifference.toFixed(priceDecimals(currentPrice))}` : 'unavailable'}</b></span>
                <span class="${discrepancyClass((spread || 0) / atrValue)}">Executable spread <b>${Number.isFinite(spread) ? `${spread.toFixed(priceDecimals(currentPrice))} (${(spread / atrValue).toFixed(2)} ATR)` : 'unavailable'}</b></span>
                <span class="${discrepancyClass(fit.rmseAtr)}">Fourier historical RMSE <b>${fit.rmse.toFixed(priceDecimals(currentPrice))} (${fit.rmseAtr.toFixed(2)} ATR)</b></span>
                <span class="${discrepancyClass(futureProjection.endpointErrorAtr)}">Fourier endpoint error <b>${futureProjection.endpointError >= 0 ? '+' : ''}${futureProjection.endpointError.toFixed(priceDecimals(currentPrice))} (${futureProjection.endpointErrorAtr.toFixed(2)} ATR)</b></span>
                <span class="${futureProjection.validationDirectionAccuracy < 0.5 ? 'discrepancy-bad' : futureProjection.validationDirectionAccuracy < 0.6 ? 'discrepancy-warning' : ''}">Validation direction <b>${(futureProjection.validationDirectionAccuracy * 100).toFixed(1)}%</b></span>
                <span>Historical source <b>${candlesHistory.filter(candle => candle.source === 'etoro-observed').length} eToro / ${candlesHistory.length} candles</b></span>
                <span class="${dataFresh ? '' : 'discrepancy-bad'}">Last closed-candle age <b>${dataAgeBars.toFixed(1)} candles · ${(dataAgeSeconds / 60).toFixed(0)} min</b></span>
                <span>Adaptive model <b>${futureProjection.adaptiveWindow} candles · ${futureProjection.harmonics} harmonics</b></span>
                <span class="${futureProjection.enabled && dataFresh ? '' : 'discrepancy-bad'}">Projection status <b>${futureProjection.enabled && dataFresh ? 'VALIDATED FOR DISPLAY' : !dataFresh ? 'REJECTED · STALE SERIES' : 'REJECTED · DIAGNOSTIC ONLY'}</b></span>`;
            const automaticSide = consensusSign > 0 ? 'long' : consensusSign < 0 ? 'short' : null;
            const suggestedSide = chartTradeSide === 'auto' ? automaticSide : chartTradeSide;
            const suggestedPlan = suggestedSide === 'long' ? longPlan : suggestedSide === 'short' ? shortPlan : null;
            const suggestedEntry = suggestedSide === 'long'
                ? (lastAskPrice || currentPrice) : suggestedSide === 'short' ? (lastBidPrice || currentPrice) : currentPrice;
            drawUnifiedAnalysis(prices, futureProjection, {
                sideLabel: suggestedSide?.toUpperCase(),
                atrLevel: suggestedSide === 'long' ? suggestedEntry + atrValue
                    : suggestedSide === 'short' ? suggestedEntry - atrValue : null,
                tp: suggestedPlan?.ok ? suggestedPlan.best.technicalTarget : null,
                sl: suggestedPlan?.ok ? suggestedPlan.best.technicalStop : null,
                waveletZones: combined.zones,
                executionPrice: suggestedSide === 'long' ? (lastAskPrice || lastMarketPrice)
                    : suggestedSide === 'short' ? (lastBidPrice || lastMarketPrice) : lastMarketPrice,
                executionLabel: suggestedSide === 'long' ? 'ASK' : suggestedSide === 'short' ? 'BID' : 'MID'
            }, sample);
            drawFourierForecast(futureProjection, atrValue, longTarget, shortTarget, timeframeMinutes);
            const filters = window.EToroAnalytics.analyzeMarketFilters(candlesHistory.slice(-200));
            const vwapEl = document.getElementById('metric-vwap');
            vwapEl.textContent = filters.ok && Number.isFinite(filters.vwap)
                ? filters.vwap.toFixed(priceDecimals(filters.vwap)) : 'Unavailable';
            const logTrendEl = document.getElementById('metric-log-trend');
            const logPercent = (Math.exp(slope) - 1) * 100;
            logTrendEl.textContent = `${logPercent >= 0 ? '+' : ''}${logPercent.toFixed(3)}% / candle · ${currentStatusText}`;
            logTrendEl.style.color = currentStatusColor;
            lastFutureProjection = futureProjection;
            lastMarketFilters = filters;
            lastTradePlans = { long: longPlan, short: shortPlan };
            updateTradePlan();
        } catch (e) {
            console.error(`[ATR] 💥 Calculation error: ${e.message}`);
        }
    };

    /* ========================================================================
       8. INTERACTION AND EVENT LOGIC
       ======================================================================== */
    /**
     * Monitors DOM changes and updates in real time.
     */
    const monitor = async () => {
        if (isSyncing) {
            console.log("[ATR] ⏳ Synchronization in progress; skipping this cycle.");
            return;
        }

        const { symbol, timeframe } = getMetadata(); // Read the current symbol and timeframe.
        
        if (!symbol) {
            console.warn("[ATR] ⚠️ No symbol detected in the eToro URL or UI.");
            return;
        } 

        // Handle asset changes.
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            console.log(`%c[ATR] 🔄 Change detected: ${lastSymbol} -> ${symbol} (${timeframe})`, "color: yellow");
            isSyncing = true;
            candlesHistory = []; rawYahooCandles = []; lastBarTime = 0; lastClose = null; liveCandle = null;
            lastTimeframe  = timeframe; lastSymbol = symbol;
            lastMarketPrice = null; lastPriceSource = 'Yahoo Finance';
            lastBidPrice = null; lastAskPrice = null;
            historyAlignedToEtoro = false;
            historyScaleFactor = 1;
            historyPriceOffset = 0;
            lastCombinedAnalysis = null; lastAtrValue = null;
            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            const { ySymbol, yInterval, sourceMinutes, targetMinutes } = mapToYahoo(symbol, timeframe);
            
            const rangeMap = {
                '1m': '7d', '2m': '60d', '5m': '60d', '15m': '60d', '30m': '60d',
                '60m': '2y', '1h': '2y', '4h': '2y', '1d': '5y', '1w': '10y'
            };
            const dataRange = rangeMap[timeframe] || '60d';
            const downloadedCandles = await fetchHistory(ySymbol, yInterval, dataRange);
            rawYahooCandles = downloadedCandles.map(candle => ({ ...candle }));
            candlesHistory = mergeObservedEtoroCandles(
                normalizeYahooCandles(downloadedCandles, sourceMinutes, targetMinutes), symbol, timeframe
            );
            if (candlesHistory.length > 0) lastBarTime = candlesHistory[candlesHistory.length - 1].t * 1000;
            
            isSyncing = false;
            performCalculations(timeframe, symbol);
        }

        refreshEtoroQuotes();

        // Extract OHLC from the eToro DOM.
        let data = {};
        const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(d => d)];
        docs.forEach(doc => {
            doc.querySelectorAll('[class*="valueItem-"]').forEach(item => {
                const labelEl = item.querySelector('[class*="valueTitle-"]');
                if (!labelEl) return;
                const label = labelEl.innerText.trim().toUpperCase();
                const valText = item.querySelector('[class*="valueValue-"]')?.innerText.replace(/,/g, '');
                const val = parseFloat(valText);
                
                if (label === 'O' || label === 'OPEN') data.Open = val;
                if (label === 'H' || label === 'HIGH') data.High = val;
                if (label === 'L' || label === 'LOW') data.Low = val;
                if (label === 'C' || label === 'CLOSE') data.Close = val;
            });
        });

        // Update when a new closing price appears.
        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            if (!lastBidPrice && !lastAskPrice) {
                lastMarketPrice = data.Close;
                lastPriceSource = 'latest eToro chart candle';
            }
            updateBreakEven();
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            const now = Date.now();
            const barDuration = timeframeToMinutes(timeframe) * 60000;
            const currentBarTime = Math.floor(now / barDuration) * barDuration;

            if (!liveCandle || currentBarTime > liveCandle.t * 1000) {
                // Only the previous partial candle can become a closed candle.
                // Keep the current-period candle separate so it cannot contaminate
                // ATR, Fourier, Wavelet, volume or calibration.
                if (liveCandle && (!candlesHistory.length || liveCandle.t > candlesHistory.at(-1).t)) {
                    const closedEtoroCandle = { ...liveCandle, partial: false, source: 'etoro-observed' };
                    candlesHistory.push(closedEtoroCandle);
                    saveObservedEtoroCandle(symbol, timeframe, closedEtoroCandle);
                    if (candlesHistory.length > 5000) candlesHistory.shift();
                }
                liveCandle = {
                    t: Math.floor(currentBarTime / 1000),
                    o: Number.isFinite(data.Open) ? data.Open : data.Close,
                    h: Number.isFinite(data.High) ? data.High : data.Close,
                    l: Number.isFinite(data.Low) ? data.Low : data.Close,
                    c: data.Close,
                    v: null,
                    partial: true,
                    source: 'etoro-observed'
                };
                lastBarTime = currentBarTime;
            } else {
                const open = Number.isFinite(data.Open) ? data.Open : data.Close;
                const high = Number.isFinite(data.High) ? data.High : data.Close;
                const low = Number.isFinite(data.Low) ? data.Low : data.Close;
                liveCandle.o = Number.isFinite(liveCandle.o) ? liveCandle.o : open;
                liveCandle.h = Math.max(Number.isFinite(liveCandle.h) ? liveCandle.h : high, high);
                liveCandle.l = Math.min(Number.isFinite(liveCandle.l) ? liveCandle.l : low, low);
                liveCandle.c = data.Close;
            }
            performCalculations(timeframe, symbol);
        }
    }; 

    // Drag-and-drop logic.
    let isDragging = false;
    let isResizing = false;
    let offsetX, offsetY;

    const canStartDrag = e => {
        if (e.button !== 0 || e.target.closest('button, input, select, option, label, canvas, a')) return false;
        const rect = ui.getBoundingClientRect();
        const edgeSize = 10;
        const onResizeCorner = rect.right - e.clientX <= 20 && rect.bottom - e.clientY <= 20;
        if (onResizeCorner) return false;
        const onBorder = e.clientX - rect.left <= edgeSize
            || rect.right - e.clientX <= edgeSize
            || e.clientY - rect.top <= edgeSize
            || rect.bottom - e.clientY <= edgeSize;
        const inHeader = Boolean(e.target.closest('.atr-header-row'));
        const freeArea = e.target === ui || e.target.matches(
            '#atr-content-body, .analysis-head, .summary-line, .trade-plan-panel'
        );
        return onBorder || inHeader || freeArea;
    };

    ui.addEventListener('pointerdown', e => {
        if (!canStartDrag(e)) return;
        isDragging = true;
        offsetX = e.clientX - ui.getBoundingClientRect().left;
        offsetY = e.clientY - ui.getBoundingClientRect().top;
        ui.classList.add('is-dragging');
        ui.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });

    const resizeHandle = document.getElementById('plugin-resize-handle');
    let resizeOrigin = null;
    resizeHandle.addEventListener('pointerdown', e => {
        if (ui.classList.contains('atr-minimized')) return;
        const rect = ui.getBoundingClientRect();
        resizeOrigin = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height };
        isResizing = true;
        resizeHandle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('pointermove', e => {
        if (isResizing && resizeOrigin) {
            const width = Math.min(window.innerWidth - 12, Math.max(440, resizeOrigin.width + e.clientX - resizeOrigin.x));
            const height = Math.min(window.innerHeight - 45, Math.max(360, resizeOrigin.height + e.clientY - resizeOrigin.y));
            ui.style.width = `${width}px`;
            ui.style.height = `${height}px`;
            return;
        }
        if (!isDragging) return;
        const maxLeft = Math.max(0, window.innerWidth - Math.min(60, ui.offsetWidth));
        const maxTop = Math.max(0, window.innerHeight - Math.min(35, ui.offsetHeight));
        ui.style.left = `${Math.max(0, Math.min(e.clientX - offsetX, maxLeft))}px`;
        ui.style.top = `${Math.max(0, Math.min(e.clientY - offsetY, maxTop))}px`;
        ui.style.right = 'auto';
    });

    const finishDragging = () => {
        if (isResizing) {
            isResizing = false;
            resizeOrigin = null;
            const rect = ui.getBoundingClientRect();
            localStorage.setItem('atr-plugin-size', JSON.stringify({ width: rect.width, height: rect.height }));
            performCalculations(lastTimeframe, lastSymbol);
            return;
        }
        if (!isDragging) return;
        isDragging = false;
        ui.classList.remove('is-dragging');
        const rect = ui.getBoundingClientRect();
        localStorage.setItem('atr-plugin-position', JSON.stringify({ left: rect.left, top: rect.top }));
    };
    document.addEventListener('pointerup', finishDragging);
    document.addEventListener('pointercancel', finishDragging);

    // Keep wheel and trackpad scrolling inside the panel instead of letting
    // the underlying eToro page consume the event.
    const scrollViewport = ui.querySelector('.single-analysis-view');
    scrollViewport?.addEventListener('wheel', event => event.stopPropagation(), { passive: true });

    // UI event listeners.
    document.getElementById('atr-min-btn').addEventListener('click', () => {
        const body = document.getElementById('atr-content-body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        ui.classList.toggle('atr-minimized', !isHidden);
        document.getElementById('atr-min-btn').innerText = isHidden ? '_' : '▢';
        localStorage.setItem('atr-plugin-minimized', !isHidden);
        if (isHidden) requestAnimationFrame(() => {
            const rect = ui.getBoundingClientRect();
            ui.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - ui.offsetWidth))}px`;
            ui.style.top = `${Math.max(0, Math.min(rect.top, window.innerHeight - 35))}px`;
            ui.style.right = 'auto';
        });
    });

    document.getElementById('k-plus').addEventListener('click', () => {
        if (visibleCyclesCount < 12) {
            visibleCyclesCount++;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            const { symbol } = getMetadata();
            performCalculations(lastTimeframe, symbol);
        }
    });

    // Button listeners.
    document.getElementById('k-minus').addEventListener('click', () => {
        if (visibleCyclesCount > 1) { 
            visibleCyclesCount--;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            const { symbol } = getMetadata(); // <--- OBTENER SYMBOL
            performCalculations(lastTimeframe, symbol);
        }
    });

    document.getElementById('w-plus').addEventListener('click', () => {
        if (visibleWaveletLevels < 7) {
            visibleWaveletLevels++;
            document.getElementById('w-count-label').innerText = visibleWaveletLevels;
            performCalculations(lastTimeframe, lastSymbol);
        }
    });

    document.getElementById('w-minus').addEventListener('click', () => {
        if (visibleWaveletLevels > 1) {
            visibleWaveletLevels--;
            document.getElementById('w-count-label').innerText = visibleWaveletLevels;
            performCalculations(lastTimeframe, lastSymbol);
        }
    });

    document.getElementById('history-count').addEventListener('change', event => {
        visibleHistoryCount = Number(event.target.value);
        localStorage.setItem('atr-plugin-history-count', visibleHistoryCount);
        performCalculations(lastTimeframe, lastSymbol);
    });
    document.getElementById('projection-count').addEventListener('change', event => {
        projectionBars = Number(event.target.value);
        document.getElementById('projection-legend-count').textContent = projectionBars;
        localStorage.setItem('atr-plugin-projection-bars', projectionBars);
        performCalculations(lastTimeframe, lastSymbol);
    });
    document.getElementById('chart-price-mode').addEventListener('change', event => {
        chartPriceMode = event.target.value;
        localStorage.setItem('atr-plugin-chart-mode', chartPriceMode);
        performCalculations(lastTimeframe, lastSymbol);
    });
    document.getElementById('chart-trade-side').addEventListener('change', event => {
        chartTradeSide = event.target.value;
        localStorage.setItem('atr-plugin-chart-side', chartTradeSide);
        performCalculations(lastTimeframe, lastSymbol);
    });
    ['show-fourier', 'show-atr', 'show-tp', 'show-sl'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => performCalculations(lastTimeframe, lastSymbol));
    });

    document.getElementById('run-fourier-simulation').addEventListener('click', event => {
        const button = event.currentTarget;
        const output = document.getElementById('fourier-simulation-output');
        button.disabled = true;
        output.textContent = 'Running chronological simulation…';
        requestAnimationFrame(() => setTimeout(() => {
            const closedCandles = candlesHistory.filter(candle => !candle.partial && Number.isFinite(candle.c));
            const horizonBars = Number(document.getElementById('simulation-horizon').value);
            const atrMultiple = Number(document.getElementById('simulation-atr-multiple').value);
            const result = window.EToroAnalytics.simulateFourierAtrStrategy(closedCandles, {
                lookback: Math.min(128, visibleHistoryCount), horizonBars, atrMultiple
            });
            if (!result.ok) {
                output.innerHTML = `<div class="simulation-error">${result.error}</div>`;
            } else {
                const bars = value => value === null ? '--' : `${value.toFixed(1)} candles`;
                const row = (label, split) => `<div class="simulation-result"><b>${label} ${split.percent}%</b><strong class="${split.score >= 0 ? 'score-positive' : 'score-negative'}">${split.score >= 0 ? '+' : ''}${split.score}</strong><span>${split.signals} Fourier signals · ${split.wins} wins · ${split.losses} losses · ${split.unresolved} unresolved</span><small>Exceeded ${result.atrMultiple.toFixed(2)} ATR: ${(split.winRate * 100).toFixed(1)}% · projected arrival ${bars(split.projectedAverageBars)} · actual arrival ${bars(split.actualAverageBars)}</small></div>`;
                const recordRows = [...(result.splits.test.records || []), ...(result.splits.real.records || [])].slice(-20).map(record => {
                    const decimals = priceDecimals(record.entry);
                    return `<div class="simulation-record"><b>${record.direction.toUpperCase()}</b><span>Entry ${record.entry.toFixed(decimals)} → target ${record.target.toFixed(decimals)}</span><small>Projected +${record.projectedHitBar} · actual ${record.actualHitBar === null ? 'not reached' : `+${record.actualHitBar}`} · ${record.outcome.toUpperCase()} ${record.points > 0 ? '+' : ''}${record.points}</small></div>`;
                }).join('');
                output.innerHTML = `<div class="simulation-params">Condition: reach ${result.atrMultiple.toFixed(2)} ATR within ${result.horizonBars} candles.<br>Selected on Train: ${result.params.harmonics} harmonics · minimum period ${result.params.minPeriodBars} candles · rolling window ${result.lookback}</div>`
                    + row('Train', result.splits.train) + row('Test', result.splits.test) + row('Real', result.splits.real)
                    + `<details class="simulation-details"><summary>Recent Test/Real signals</summary>${recordRows || '<p>No qualifying Fourier signals.</p>'}</details>`
                    + '<p>A signal exists only when Fourier projects the selected ATR distance. A win means the market reached that directional price first; a loss means the opposite ATR was reached or the horizon ended against the signal. “Real” was never used to choose parameters.</p>';
            }
            button.disabled = false;
        }, 0));
    });

    document.getElementById('download-diagnostic').addEventListener('click', downloadDiagnosticBundle);

    const btnRefresh = document.getElementById('atr-refresh-btn');
    btnRefresh.addEventListener('click', async () => {
        console.log("[ATR] 🖱️ User requested a manual refresh.");
        if (isSyncing) return;
        btnRefresh.classList.add('spinning');
        btnRefresh.disabled = true;
        document.getElementById('atr-status').innerText = 'Refreshing everything…';
        document.getElementById('fourier-cycle').innerText = 'Updating…';
        document.getElementById('fourier-forecast-output').innerText = 'Rebuilding projection…';
        document.getElementById('trade-plan-output').innerText = 'Recalculating TP / SL…';
        document.getElementById('wavelet-components').innerText = 'Rebuilding Wavelet…';
        ['unified-analysis-canvas'].forEach(id => {
            const canvas = document.getElementById(id);
            canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        });
        calibrationToken++;
        lastSymbol = null;
        lastTimeframe = null;
        candlesHistory = [];
        rawYahooCandles = [];
        liveCandle = null;
        lastBarTime = 0;
        lastClose = null;
        lastMarketPrice = null;
        lastBidPrice = null;
        lastAskPrice = null;
        lastCombinedAnalysis = null;
        lastAtrValue = null;
        historyAlignedToEtoro = false;
        historyScaleFactor = 1;
        historyPriceOffset = 0;
        try {
            await monitor();
            if (!lastSymbol || !lastTimeframe || !candlesHistory.length) {
                throw new Error('Could not load history for the current asset.');
            }
            refreshEtoroQuotes();
            performCalculations(lastTimeframe, lastSymbol);
            updateBreakEven();
            updateTradePlan();
        } catch (error) {
            document.getElementById('atr-status').innerText = 'Refresh failed';
            console.error('[ATR] Full refresh failed:', error);
        } finally {
            btnRefresh.classList.remove('spinning');
            btnRefresh.disabled = false;
        }
    });

    // Startup.
    let quoteRefreshTimer = null;
    const quoteObserver = new MutationObserver(() => {
        if (quoteRefreshTimer) return;
        quoteRefreshTimer = setTimeout(() => {
            quoteRefreshTimer = null;
            refreshEtoroQuotes();
        }, 100);
    });
    quoteObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    monitor();
    setInterval(refreshEtoroQuotes, 1000);
    setInterval(monitor, 10000);
})();
