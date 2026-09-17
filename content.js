(async () => {
    /**
     * ========================================================================
     * 1. CONFIGURATION AND GLOBAL STATE
     * ========================================================================
     * Data persistence and buffer synchronization.
     */
    const N = 128;                       // Sample size (analysis window)
    let candlesHistory  = [];            // OHLC candle buffer
    let lastClose       = null;          // Latest detected close
    let lastTimeframe   = null;          // Current chart timeframe
    let lastSymbol      = null;          // Current asset symbol
    let lastBarTime     = 0;             // Timestamp of the latest processed bar
    let lastCalcTime    = 0;             // Calculation interval control
    let isSyncing       = false;         // Prevent duplicate downloads
    let visibleCyclesCount = 1;          // Number of harmonics to display
    let visibleWaveletLevels = 2;         // Highest-energy Haar components
    let lastMarketPrice = null;           // Base price for break-even TP
    let lastPriceSource = 'Yahoo Finance';
    let lastBidPrice = null;
    let lastAskPrice = null;
    let modelParams = { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
    let calibrationToken = 0;
    let lastCombinedAnalysis = null;
    let lastAtrValue = null;
    let historyAlignedToEtoro = false;
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
        { symbol: 'VT', yahoo: 'VT', name: 'Mundo ETF' },
        { symbol: 'BND', yahoo: 'BND', name: 'Bonos ETF' },
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
            #fourier-top-list { font-size: 0.72em; color: #4fc3f7; max-height: 100px; overflow-y: auto; }

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

    // Map eToro terms to Yahoo Finance-compatible symbols.
    const mapToYahoo = (symbol, timeframe) => {
        const symbolMap = { 
            'GOLD': 'GC=F', 'SILVER': 'SI=F', 'PLATINUM': 'PL=F',
            'COPPER': 'HG=F', 'BTC': 'BTC-USD', 'ETH': 'ETH-USD' 
        };
        
        const intervalMap = { 
            '1m': '1m',   '2m': '2m',   '5m': '5m', 
            '15m': '15m', '30m': '30m', '60m': '60m', 
            '1h': '1h',   '4h': '1h',   '1d': '1d',  '1w': '1wk' 
        };
        
        const ySymbol   = symbolMap[symbol] || symbol;
        let yInterval   = intervalMap[timeframe] || (timeframe.includes('m') ? '5m' : '1d');

        console.log(`[DEBUG] Mapeo Yahoo - ySymbol: ${ySymbol}, yInterval: ${yInterval}`);
        return { ySymbol, yInterval };
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
                console.warn(`[ATR] Fallo proxy: ${config.url.split('/')[2]}`);
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
    
    // --- Estructura HTML ---
    /* ========================================================================
   SECTION 5: SIMPLIFIED UI
   ======================================================================== */
    ui.innerHTML = `
        <div class="atr-header-row">
            <div class="atr-brand"><img src="${chrome.runtime.getURL('icons/icon32.png')}" alt=""><div class="atr-header">Price, Risk and Trend Assistant</div></div>
            <div id="conn-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff5252; margin-left: 5px;" title="Connection status"></div>
            <div style="display: flex; gap: 5px; align-items: center;">
                <select id="plugin-mode" title="Switch between the trading summary and full analysis">
                    <option value="simple">Simple mode</option>
                    <option value="analysis">Analysis mode</option>
                </select>
                <button id="columns-left" class="atr-btn column-nav" title="Show columns to the left">◀</button>
                <button id="columns-right" class="atr-btn column-nav" title="Show columns to the right">▶</button>
                <button id="download-diagnostic" class="atr-btn" title="Download asset data and diagnostics">⇩ Data</button>
                <button id="layout-toggle" class="atr-btn" title="Resize the panel and columns">↔</button>
                <button id="atr-refresh-btn" class="atr-btn" title="Refresh all data">⟳</button>
                <button id="atr-min-btn">${isMinimized ? '▢' : '_'}</button>
            </div>
        </div>

        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : 'display: block;'}">
            <div id="layout-controls" class="layout-controls" hidden>
                <label>Panel width<input type="range" data-layout="panelWidth" min="1000" max="1900" step="20"></label>
                <label>Panel height<input type="range" data-layout="panelHeight" min="360" max="900" step="20"></label>
                <label>Data<input type="range" data-layout="dataWidth" min="250" max="400" step="10"></label>
                <label>Fourier<input type="range" data-layout="fourierWidth" min="270" max="420" step="10"></label>
                <label>Trade plan<input type="range" data-layout="forecastWidth" min="330" max="480" step="10"></label>
                <label>Wavelet<input type="range" data-layout="waveletWidth" min="290" max="440" step="10"></label>
                <label>Scanner<input type="range" data-layout="scannerWidth" min="350" max="500" step="10"></label>
            </div>
            <div class="plugin-grid">
                <section class="plugin-column operation-column">
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
                    <div class="cost-panel">
                        <div class="cost-title">Minimum price required to recover costs</div>
                        <div id="fee-profile">Identifying fee profile…</div>
                        <div id="breakeven-output">Waiting for price…</div>
                        <div class="cost-note">Break-even means gross profit equals estimated opening and closing costs. It is not a sell recommendation.</div>
                    </div>
                    <div class="ohlc-title">Latest detected candle</div>
                    <div class="atr-ohlc">
                        O <span id="val-o">-</span> · H <span id="val-h">-</span> · L <span id="val-l">-</span> · C <span id="val-c">-</span>
                    </div>
                    <div id="trend-summary-legend">
                        <span title="Logarithmic slope of the latest 16 closes.">16-candle direction <b id="txt-current-status">--</b></span>
                        <span title="Direction and time until the Fourier slope changes sign.">Possible Fourier turn <b id="txt-consensus">--</b></span>
                        <span title="Central curve price at the possible turn; not a guaranteed target.">Turn price <b id="txt-turn-price">--</b></span>
                        <span title="Independent multiscale confirmation from the Haar Wavelet.">Wavelet confirmation <b id="txt-reversal">--</b></span>
                    </div>
                    <div class="levels-panel">
                        <div class="levels-title">Wavelet price zones</div>
                        <div class="wavelet-zone-columns">
                            <label title="Lower zone where price declines have stalled.">Supports<select id="wavelet-supports"><option>--</option></select></label>
                            <label title="Upper zone where price advances have stalled.">Resistances<select id="wavelet-resistances"><option>--</option></select></label>
                        </div>
                        <div><span>Current ATR</span><b id="current-atr-distance">--</b></div>
                        <div><span>Minimum SL distance</span><b id="recommended-atr">--</b></div>
                        <span title="Weighted score; it is not a probability of success.">Combined score <b id="combined-score">--</b></span>
                        <details class="help-box"><summary>What does this column mean?</summary><p><b>ATR</b>: ordinary movement per candle. <b>Support</b>: possible floor. <b>Resistance</b>: possible ceiling. The dollar amount estimates how much the position would change if price reached that zone.</p></details>
                    </div>
                </section>

                <section class="plugin-column analysis-column fourier-column">
                    <div class="analysis-head">
                        <b>Fourier price cycles</b>
                        <span><span id="f-samples">--</span> candles · <span id="f-tf">--</span></span>
                    </div>
                    <div class="chart-title">Fourier spectrum <small>Tall bars = dominant cycles</small></div>
                    <canvas id="fourier-canvas" width="240" height="54"></canvas>
                    <div class="chart-legend"><span class="dot dominant"></span>Dominant <span class="dot secondary"></span>Other frequencies · <b id="fourier-cycle">Loading…</b></div>

                    <div class="chart-title reconstruction-title">Price and reconstruction</div>
                    <div id="recon-legend" class="chart-legend reconstruction-legend">
                        <span class="dot real"></span>Actual price
                        <span class="dot cycles"></span>Cycles
                        <span class="dot total"></span>Trend + cycles
                        <label><input type="checkbox" id="chk-show-price" checked> Show price</label>
                    </div>
                    <canvas id="reconstruction-canvas" width="240" height="62"></canvas>
                    <div class="time-legend">
                        <span>Start <b id="leg-time">--:--</b></span>
                        <span>Latest <b id="leg-mkt-last">--:--</b></span>
                        <span>Slope/candle <b id="leg-slope">0.0000</b></span>
                    </div>

                    <div class="cycles-toolbar">
                        <span>Active harmonics</span>
                        <button id="k-minus" class="atr-btn">−</button>
                        <b id="k-count-label">1</b>
                        <button id="k-plus" class="atr-btn">+</button>
                    </div>
                    <div id="fourier-top-list"></div>
                    <details class="help-box"><summary>How to read Fourier</summary><p>It separates history into cycles. A tall bar indicates a dominant cycle but does not guarantee persistence. The red line combines trend and cycles; the blue line shows cycles only.</p></details>
                </section>

                <section class="plugin-column analysis-column forecast-column">
                    <div class="analysis-head">
                        <b>Projection and trade plan</b>
                        <span>Next 10 candles</span>
                    </div>
                    <div class="chart-title reconstruction-title">Future Fourier path</div>
                    <canvas id="fourier-forecast-canvas" width="240" height="62"></canvas>
                    <div id="fourier-forecast-output" class="forecast-output">Waiting for projection…</div>
                    <div id="fourier-price-list" class="future-price-list"></div>
                    <div class="entry-filter-panel">
                        <div class="trade-plan-head"><b>Is opening now worthwhile?</b><span id="entry-decision">NOT VIABLE</span></div>
                        <div id="market-filter-summary">Waiting for regime, volume and volatility…</div>
                        <div id="entry-checks"></div>
                    </div>
                    <div class="simulation-panel">
                        <button id="trend-simulation-btn" class="atr-btn">Simulate log-price vs Fourier ×5</button>
                        <div id="trend-simulation-output">Uses loaded candles and predicts only the next candle.</div>
                    </div>
                    <div class="trade-plan-panel">
                        <div class="trade-plan-head">
                            <b>Price, gain and loss</b>
                            <select id="trade-plan-side">
                                <option value="long" ${savedTradeSide === 'long' ? 'selected' : ''}>LONG</option>
                                <option value="short" ${savedTradeSide === 'short' ? 'selected' : ''}>SHORT</option>
                            </select>
                        </div>
                        <div id="trade-plan-output">Waiting for Wavelet zones…</div>
                        <div class="trade-plan-note">Assuming the Fourier path occurs, a setup is viable only if it reaches TP within 10 candles, TP/SL ≥ 1.5, SL ≥ 1.50 ATR, and gross profit covers at least 2× the full round-trip cost. Wavelet defines the zones; an ATR/RR fallback is identified when a usable pair is missing.</div>
                        <details class="help-box"><summary>Decision glossary</summary><p><b>ADX</b>: trend strength. <b>ER</b>: directional efficiency from 0 to 1. <b>Relative volume</b>: current volume versus its average. <b>VWAP</b>: volume-weighted average price. <b>R/R</b>: dollars sought for each dollar at risk.</p></details>
                    </div>
                </section>

                <section class="plugin-column analysis-column wavelet-column">
                    <div class="analysis-head">
                        <b>Wavelet zones and scales</b>
                        <span>Haar · 128 candles</span>
                    </div>
                    <div class="chart-title wavelet-title">Haar Wavelet reconstruction <small>Multiscale components</small></div>
                    <div class="chart-legend wavelet-legend">
                        <span class="dot real"></span>Actual price
                        <span class="dot wave-components"></span>Components
                        <span class="dot wave-total"></span>Reconstruction
                    </div>
                    <canvas id="wavelet-canvas" width="240" height="62"></canvas>
                    <div class="chart-legend wavelet-legend">
                        <span>Active components</span>
                        <button id="w-minus" class="atr-btn">−</button>
                        <b id="w-count-label">2</b>
                        <button id="w-plus" class="atr-btn">+</button>
                    </div>
                    <div id="wavelet-components">Waiting for data…</div>
                    <details class="help-box"><summary>How to read Wavelet</summary><p>It separates fast and slow movements to locate repeated turning zones. More contacts and greater recency increase the score, but a zone remains a range rather than one exact price.</p></details>
                    <div class="model-info-panel">
                        <div class="model-info-title">Equations and calibration</div>
                        <div class="equation-line"><b>Combination</b> C = (F·wF + W·wW + A·wA) / Σw</div>
                        <div class="equation-line"><b>Fourier</b> F = min(1, movement / (2·minimum movement))</div>
                        <div class="equation-line"><b>Wavelet</b> W = contacts × zone recency</div>
                        <div class="equation-line"><b>Alignment</b> A = max(0, 1 − distance / (2·ATR))</div>
                        <div id="model-parameters">wF -- · wW -- · wA -- · threshold --</div>
                        <div class="split-grid">
                            <span>Train 80% <b id="split-train">--</b></span>
                            <span>Test 10% <b id="split-test">--</b></span>
                            <span>Validate 10% <b id="split-validation">--</b></span>
                        </div>
                        <div id="calibration-status">Historical calibration pending…</div>
                        <div id="calibration-updated">Last update: --</div>
                    </div>
                </section>

                <section class="plugin-column analysis-column scanner-column">
                    <div class="analysis-head">
                        <b>Opportunity scanner</b>
                        <button id="scanner-refresh" class="atr-btn" title="Scan now">Scan</button>
                    </div>
                    <div class="scanner-controls">
                        <label>Update every
                            <select id="scanner-interval">
                                <option value="5">5 minutes</option>
                                <option value="10" selected>10 minutes</option>
                            </select>
                        </label>
                        <span id="scanner-updated">Not scanned</span>
                    </div>
                    <div class="scanner-note">Compares VOO, VT, BND, QQQ, BTC and ETH on 15m, 30m, 1h and 4h using five Fourier cycles. Yahoo prices are indicative; always confirm in eToro.</div>
                    <div id="scanner-progress"></div>
                    <div id="scanner-results"><div class="scanner-empty">Press Scan to start.</div></div>
                    <details class="help-box"><summary>How results are ranked</summary><p>Low, medium and high risk appear in that order. Within each level, the highest potential net gain relative to loss and costs appears first. The six checks remain visible as evidence. If Wavelet has no usable TP, the fallback uses <b>TP ≥ 1.5 × SL</b> and increases it only when required to cover costs.</p></details>
                </section>
            </div>
        </div>
    `;

    // Inject into the DOM.
    Object.assign(ui.style, { position: 'fixed', top: '100px', right: '20px', zIndex: '10000' });
    ui.classList.toggle('atr-minimized', isMinimized);

    document.body.appendChild(ui);
    const savedMode = localStorage.getItem('atr-plugin-mode') || 'simple';
    document.getElementById('plugin-mode').value = savedMode;
    ui.classList.toggle('mode-simple', savedMode === 'simple');
    ui.classList.toggle('mode-analysis', savedMode === 'analysis');
    document.getElementById('scanner-interval').value = localStorage.getItem('atr-scanner-interval') || '10';
    const defaultLayout = { panelWidth: 1580, panelHeight: 540, dataWidth: 260, fourierWidth: 280, forecastWidth: 350, waveletWidth: 300, scannerWidth: 350 };
    const layoutMinimums = { panelWidth: 1000, panelHeight: 360, dataWidth: 250, fourierWidth: 270, forecastWidth: 330, waveletWidth: 290, scannerWidth: 350 };
    const storedLayout = JSON.parse(localStorage.getItem('atr-plugin-layout') || '{}');
    const savedLayout = Object.fromEntries(Object.entries(defaultLayout).map(([key, fallback]) => [
        key, Math.max(layoutMinimums[key] || 0, Number(storedLayout[key]) || fallback)
    ]));
    const applyLayout = layout => {
        ui.style.setProperty('--panel-width', `${layout.panelWidth}px`);
        ui.style.setProperty('--panel-height', `${layout.panelHeight}px`);
        ui.style.setProperty('--data-width', `${layout.dataWidth}px`);
        ui.style.setProperty('--fourier-width', `${layout.fourierWidth}px`);
        ui.style.setProperty('--forecast-width', `${layout.forecastWidth}px`);
        ui.style.setProperty('--wavelet-width', `${layout.waveletWidth}px`);
        ui.style.setProperty('--scanner-width', `${layout.scannerWidth}px`);
    };
    applyLayout(savedLayout);
    document.querySelectorAll('#layout-controls input[data-layout]').forEach(input => {
        input.value = savedLayout[input.dataset.layout];
        input.addEventListener('input', event => {
            savedLayout[event.target.dataset.layout] = Number(event.target.value);
            applyLayout(savedLayout);
            localStorage.setItem('atr-plugin-layout', JSON.stringify(savedLayout));
        });
    });
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
        if (!output || !lastMarketPrice || !window.EToroAnalytics) return;
        const leverage = readNumber('lev-amount');
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
        const longEntry = lastAskPrice || lastMarketPrice;
        const shortEntry = lastBidPrice || lastMarketPrice;
        const common = {
            investment: readNumber('inv-amount'), leverage,
            openFeePercent: fee.openFeePercent,
            closeFeePercent: fee.closeFeePercent,
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
        feeEl.textContent = fee.label;
        feeEl.classList.toggle('fee-warning', !fee.known);

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
        const side = document.getElementById('trade-plan-side').value;
        const leverage = readNumber('lev-amount');
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
        const entryPrice = side === 'long'
            ? (lastAskPrice || lastMarketPrice)
            : (lastBidPrice || lastMarketPrice);
        const minimumZoneDistance = lastAtrValue * 1.50;
        const supports = lastCombinedAnalysis.zones.supports
            .filter(zone => entryPrice - zone.high > minimumZoneDistance)
            .sort((a, b) => b.low - a.low);
        const resistances = lastCombinedAnalysis.zones.resistances
            .filter(zone => zone.low - entryPrice > minimumZoneDistance)
            .sort((a, b) => a.high - b.high);
        const result = window.EToroAnalytics.calculateBestZoneTradePlan({
            side, entryPrice,
            investment: readNumber('inv-amount'), leverage,
            atr: lastAtrValue,
            supports: supports.slice(0, 4),
            resistances: resistances.slice(0, 4),
            openFeePercent: fee.openFeePercent,
            stopBufferAtr: 0.10,
            recommendedAtrMultiple: 1.50,
            openingCostMultiple: 2,
            roundTripCostMultiple: 2
        });
        if (!result.ok) {
            output.innerHTML = `<div class="plan-warning">${result.error}</div>`;
            return;
        }
        const plan = result.best;
        const decimals = priceDecimals(entryPrice);
        const ticket = window.EToroAnalytics.calculateTicketRiskLevels({
            side, entryPrice,
            investment: readNumber('inv-amount'), leverage,
            atr: lastAtrValue, atrMultiple: plan.recommendedAtrMultiple,
            targetPrice: plan.technicalTarget, stopPrice: plan.technicalStop
        });
        const exposure = readNumber('inv-amount') * leverage;
        const openingCost = exposure * Math.max(0, fee.openFeePercent) / 100;
        const openingCostText = fee.known ? `$${openingCost.toFixed(2)}` : 'not verified';
        const targetReference = plan.targetIndex ? ` · ${side === 'long' ? 'R' : 'S'}${plan.targetIndex}` : ' · fallback';
        const stopReference = plan.stopIndex ? ` · ${side === 'long' ? 'S' : 'R'}${plan.stopIndex}` : ' · ATR';
        const fallbackNotice = result.fallback
            ? `<div class="plan-alert bad">⚠ ${result.reason} Fallback TP = ${plan.rewardRisk.toFixed(2)} × SL.</div>`
            : `<div class="plan-alert ok">✓ ${result.validCount}/${result.totalCount} technical combinations; selected by R/R (70%) and joint Wavelet zone score (30%)</div>`;
        output.innerHTML = `
            <div class="plan-level entry"><span>1. Open ${side === 'long' ? 'LONG' : 'SHORT'} at</span><b>${entryPrice.toFixed(decimals)}</b><small>Investment $${readNumber('inv-amount').toFixed(2)} · exposure $${exposure.toFixed(2)} · opening cost ${openingCostText}</small></div>
            <div class="plan-level target"><span>2. TP: close with profit${targetReference}</span><b>Price ${plan.technicalTarget.toFixed(decimals)}</b><small>Enter +$${ticket.targetAmount.toFixed(2)} in eToro · move ${plan.targetPercent.toFixed(2)}%</small></div>
            <div class="plan-level stop"><span>3. SL: close with loss${stopReference}</span><b>Price ${plan.technicalStop.toFixed(decimals)}</b><small>Enter −$${ticket.stopAmount.toFixed(2)} in eToro · move ${plan.stopPercent.toFixed(2)}%</small></div>
            <div class="plan-level minimum"><span>Volatility boundary</span><b>${ticket.atrMultiple.toFixed(2)} ATR = $${ticket.recommendedMoney.toFixed(2)}</b><small>1 ATR = ${lastAtrValue.toFixed(decimals)} / $${ticket.atrMoney.toFixed(2)} · SL must cross ${ticket.atrBoundaryPrice.toFixed(decimals)}</small></div>
            <div class="plan-level minimum"><span>Reward/risk ratio</span><b>${plan.rewardRisk.toFixed(2)} to 1</b><small>Potential gain $${ticket.targetAmount.toFixed(2)} versus loss $${ticket.stopAmount.toFixed(2)}</small></div>
            <div class="plan-alert ${ticket.stopOutsideAtr && fee.known ? 'ok' : 'bad'}">${ticket.stopOutsideAtr ? '✓ SL beyond recommended ATR' : '⚠ SL inside recommended ATR'} · TP &gt; SL · ${fee.known ? `profit > $${plan.minimumProfit.toFixed(2)}` : '⚠ verify the cost in eToro'}</div>
            ${fallbackNotice}`;
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
            ...modelParams, harmonics: SCANNER_HARMONICS, horizon: 10
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
        const alternatives = [
            { side: 'long', plan: longPlan }, { side: 'short', plan: shortPlan }
        ].map(item => {
            const decision = window.EToroAnalytics.evaluateEntryDecision({
                side: item.side, projection, plan: item.plan, feeKnown: fee.known,
                atr, atrMultiple: 1.50, roundTripCost, costMultiple: 2
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
                fallback: Boolean(item.plan.fallback || plan?.fallback)
            });
            return { ...item, decision, passed, ranking };
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
            openingCost: investment * fee.openFeePercent / 100,
            roundTripCost, netProfit, feeKnown: fee.known,
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
                <div class="scanner-forecast"><span>Fourier <b>${result.harmonics} cycles</b></span><span>1 ATR <b>${formatHours(result.atrHours)}</b></span><span>TP <b>${formatHours(result.targetHours)}</b></span></div>
                <small>${result.targetFallback ? 'Fallback TP ≥ 1.5 × SL (raised when costs require it)' : 'TP based on a Wavelet zone'} · position $${result.investment.toFixed(2)} X1 · round-trip cost ${result.roundTripCost === null ? 'not verified' : `$${result.roundTripCost.toFixed(2)}`} · risk ${(result.riskScore * 100).toFixed(0)}/100${failed ? ` · Missing: ${failed}` : ' · All checks present'}</small>
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
            schema: 'etoro-atr-diagnostic-v1',
            generatedAt: now.toISOString(),
            extension: {
                name: chrome.runtime.getManifest().name,
                version: chrome.runtime.getManifest().version,
                mode: document.getElementById('plugin-mode')?.value,
                note: 'Technical file without name, email, total balance or account identifiers.'
            },
            instrument: {
                symbol: lastSymbol,
                timeframe: lastTimeframe,
                marketPrice: lastMarketPrice,
                bid: lastBidPrice,
                ask: lastAskPrice,
                priceSource: lastPriceSource,
                historyAlignedToEtoro
            },
            positionInputs: {
                investmentUsd: readNumber('inv-amount'),
                leverage: readNumber('lev-amount'),
                selectedSide: document.getElementById('trade-plan-side')?.value,
                feeProfile: fee
            },
            latestIndicators: {
                atr14: lastAtrValue,
                combinedAnalysis: lastCombinedAnalysis,
                marketFilters: lastMarketFilters,
                fourierProjection10Bars: lastFutureProjection,
                entryDecision: lastEntryDecision,
                tradePlans: lastTradePlans,
                calibratedModelParameters: modelParams
            },
            candles: candlesHistory.map(candle => ({
                timestamp: candle.t,
                isoTime: Number.isFinite(candle.t) ? new Date(candle.t * 1000).toISOString() : null,
                open: candle.o ?? null,
                high: candle.h,
                low: candle.l,
                close: candle.c,
                volume: Number.isFinite(candle.v) ? candle.v : null
            })),
            liveCandle: liveCandle ? {
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
            scanner: {
                intervalMinutes: Number(document.getElementById('scanner-interval')?.value || 10),
                harmonics: SCANNER_HARMONICS,
                results: lastScannerResults
            },
            interpretationWarnings: [
                'Yahoo quotes may differ from executable eToro prices.',
                'The Fourier band is illustrative ±1σ dispersion, not a calibrated confidence interval.',
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
        if (nextBid === lastBidPrice && nextAsk === lastAskPrice) return false;
        lastBidPrice = nextBid;
        lastAskPrice = nextAsk;
        lastMarketPrice = lastBidPrice && lastAskPrice
            ? (lastBidPrice + lastAskPrice) / 2
            : (lastBidPrice || lastAskPrice);
        lastPriceSource = 'executable eToro prices';
        if (!historyAlignedToEtoro && candlesHistory.length) {
            const historicalLast = candlesHistory[candlesHistory.length - 1].c;
            const scale = lastMarketPrice / historicalLast;
            if (Number.isFinite(scale) && scale > 0.5 && scale < 1.5) {
                candlesHistory = candlesHistory.map(candle => ({
                    ...candle,
                    o: Number.isFinite(candle.o) ? candle.o * scale : candle.o,
                    h: Number.isFinite(candle.h) ? candle.h * scale : candle.h,
                    l: Number.isFinite(candle.l) ? candle.l * scale : candle.l,
                    c: candle.c * scale
                }));
                historyAlignedToEtoro = true;
                performCalculations(lastTimeframe, lastSymbol);
            }
        }
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
            harmonics: Math.min(visibleCyclesCount, 5)
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
    document.getElementById('trade-plan-side').addEventListener('change', event => {
        localStorage.setItem('atr-plugin-trade-side', event.target.value);
        updateTradePlan();
        if (candlesHistory.length >= N) performCalculations(lastTimeframe, lastSymbol);
    });
    document.getElementById('scanner-refresh').addEventListener('click', runOpportunityScanner);
    document.getElementById('scanner-interval').addEventListener('change', scheduleOpportunityScanner);
    document.getElementById('download-diagnostic').addEventListener('click', downloadDiagnosticBundle);
    document.getElementById('layout-toggle').addEventListener('click', () => {
        const controls = document.getElementById('layout-controls');
        controls.hidden = !controls.hidden;
    });
    document.getElementById('plugin-mode').addEventListener('change', event => {
        const mode = event.target.value;
        localStorage.setItem('atr-plugin-mode', mode);
        ui.classList.toggle('mode-simple', mode === 'simple');
        ui.classList.toggle('mode-analysis', mode === 'analysis');
        document.getElementById('layout-controls').hidden = true;
    });
    const pluginGrid = document.querySelector('.plugin-grid');
    const scrollColumns = direction => {
        const visibleColumn = Math.max(260, pluginGrid.clientWidth * 0.72);
        pluginGrid.scrollBy({ left: direction * visibleColumn, behavior: 'smooth' });
    };
    document.getElementById('columns-left').addEventListener('click', () => scrollColumns(-1));
    document.getElementById('columns-right').addEventListener('click', () => scrollColumns(1));
    pluginGrid.addEventListener('wheel', event => {
        if (!event.shiftKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
        event.preventDefault();
        pluginGrid.scrollLeft += event.deltaY;
    }, { passive: false });

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
        const canvas = document.getElementById('fourier-forecast-canvas');
        const output = document.getElementById('fourier-forecast-output');
        if (!canvas || !output || !result?.ok) return;
        const ctx = canvas.getContext('2d');
        const levels = [result.current + atr, result.current - atr];
        if (Number.isFinite(longTarget)) levels.push(longTarget);
        if (Number.isFinite(shortTarget)) levels.push(shortTarget);
        const all = [...result.forecast, ...(result.lowerBand || []), ...(result.upperBand || []), ...levels];
        const min = Math.min(...all);
        const max = Math.max(...all);
        const range = max - min || 1;
        const x = index => index / Math.max(1, result.forecast.length - 1) * canvas.width;
        const y = value => canvas.height - (value - min) / range * canvas.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#11151d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (result.lowerBand?.length === result.forecast.length && result.upperBand?.length === result.forecast.length) {
            ctx.beginPath();
            result.upperBand.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
            for (let index = result.lowerBand.length - 1; index >= 0; index--) ctx.lineTo(x(index), y(result.lowerBand[index]));
            ctx.closePath();
            ctx.fillStyle = 'rgba(79, 195, 247, 0.16)';
            ctx.fill();
        }
        const level = (value, color, label) => {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(0, y(value)); ctx.lineTo(canvas.width, y(value)); ctx.stroke();
            ctx.fillStyle = color; ctx.font = '7px monospace'; ctx.fillText(label, 3, Math.max(7, y(value) - 2));
            ctx.restore();
        };
        level(result.current + atr, '#ffd166', '+ATR');
        level(result.current - atr, '#ffd166', '-ATR');
        if (Number.isFinite(longTarget)) level(longTarget, '#55e8a2', 'Long TP');
        if (Number.isFinite(shortTarget)) level(shortTarget, '#ff7d7d', 'Short TP');
        ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 1.6; ctx.beginPath();
        result.forecast.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
        ctx.stroke();
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
        output.innerHTML = `${status}<small>${result.harmonics} cycles: ${cycles} · widening ±1σ volatility band · alignment ${(result.alignment * 100).toFixed(0)}/100${result.ambiguous ? ' · ⚠ both directions reach TP' : ''}</small>`;
        const list = document.getElementById('fourier-price-list');
        const decimals = priceDecimals(result.current);
        list.innerHTML = result.forecast.slice(1, 11).map((value, index) =>
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
            return `<div class="fourier-cycle-row"><span style="color:${color}">${label}</span><b>${p.toFixed(1)} candles</b><strong class="${direction.css}" title="Estimated phase direction for the next candle">${direction.arrow} ${direction.label}</strong></div>`;
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
            const timeframeMinutes = (() => {
                const normalized = String(timeframe).toLowerCase();
                const amount = parseFloat(normalized) || 1;
                if (normalized.includes('d')) return amount * 1440;
                if (normalized.includes('w')) return amount * 10080;
                if (normalized.includes('h')) return amount * 60;
                return amount;
            })();
            // Fourier works on log price: percentage changes become additive,
            // and cycles no longer depend on the asset's nominal scale.
            const cleanData  = fourierDetrend(prices.map(Math.log));
            const spectrum   = fourierTransform(cleanData);
            const currentIdx = N - 1;

            // Magnitudes and dominant cycle.
            const magnitudes = [];
            for (let k = 1; k < N / 2; k++) {
                magnitudes.push({
                    k,
                    mag: Math.sqrt(spectrum[k].real ** 2 + spectrum[k].imag ** 2),
                    real: spectrum[k].real,
                    imag: spectrum[k].imag
                });
            }

            const topVisible = [...magnitudes].sort((a, b) => b.mag - a.mag).slice(0, visibleCyclesCount);
            const domK = topVisible[0].k; 
            const domP = N / domK;
            const meanPrice = prices.reduce((a, b) => a + b) / N;
            const atrValue = calculateATR(candlesHistory, 14);
            const combined = window.EToroAnalytics.analyzeCombined(prices, atrValue, {
                ...modelParams,
                minMoveAtr: modelParams.minMoveAtr,
                harmonics: Math.min(visibleCyclesCount, 5),
                horizon: 10
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
                    ? `~${candidate.bars} sesiones` : `${(turnMinutes / 60).toFixed(turnMinutes % 60 ? 1 : 0)} h`;
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
            document.getElementById('wavelet-supports').innerHTML = sortedSupports.length
                ? sortedSupports.slice(0, 4).map((zone, index) => zoneOption(zone, index, 'S')).join('') : '<option>No support beyond 1.50 ATR</option>';
            document.getElementById('wavelet-resistances').innerHTML = sortedResistances.length
                ? sortedResistances.slice(0, 4).map((zone, index) => zoneOption(zone, index, 'R')).join('') : '<option>No resistance beyond 1.50 ATR</option>';
            const atrDecimals = priceDecimals(currentPrice);
            document.getElementById('current-atr-distance').innerText = `${atrValue.toFixed(atrDecimals)} · ${(atrValue / currentPrice * 100).toFixed(2)}%`;
            document.getElementById('recommended-atr').innerText = `1,50 ATR = ${recommendedAtrDistance.toFixed(atrDecimals)} · $${(exposureUnits * recommendedAtrDistance).toFixed(2)}`;
            document.getElementById('combined-score').innerText = `${(combined.score * 100).toFixed(0)}/100 · alignment ${(combined.alignment * 100).toFixed(0)}/100`;
            
            // Update the remaining data.
            document.getElementById('f-samples').innerText = candlesHistory.length;
            document.getElementById('f-tf').innerText      = timeframe.toUpperCase();
            document.getElementById('fourier-cycle').innerText = `Dominant cycle: ${domP.toFixed(1)} bars`;
            document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(topVisible, '#4fc3f7', true, N, currentIdx, prices[N-1], prices.reduce((a,b)=>a+b)/N);
            
            const valAtrEl = document.getElementById('val-atr');
            if (valAtrEl) valAtrEl.innerText = atrValue.toFixed((currentSymbol === 'SILVER' || currentSymbol === 'XAGUSD') ? 4 : 2);
            
            fourierDraw(magnitudes.map(m => m.mag), domK - 1);
            reconstructionDraw(spectrum, topVisible, N, sample);
            waveletDraw(prices);
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
                horizonBars: 10,
                longTarget,
                shortTarget
            });
            drawFourierForecast(futureProjection, atrValue, longTarget, shortTarget, timeframeMinutes);
            const filters = window.EToroAnalytics.analyzeMarketFilters(candlesHistory.slice(-200));
            const selectedSide = document.getElementById('trade-plan-side')?.value || 'long';
            const selectedPlan = selectedSide === 'long' ? longPlan : shortPlan;
            const decision = window.EToroAnalytics.evaluateEntryDecision({
                side: selectedSide, projection: futureProjection, plan: selectedPlan,
                feeKnown: fee.known, atr: atrValue, atrMultiple: 1.50,
                roundTripCost: fee.known
                    ? investment * leverage * (fee.openFeePercent + fee.closeFeePercent) / 100
                    : 0,
                costMultiple: 2
            });
            lastFutureProjection = futureProjection;
            lastMarketFilters = filters;
            lastTradePlans = { long: longPlan, short: shortPlan };
            lastEntryDecision = decision;
            const decisionEl = document.getElementById('entry-decision');
            decisionEl.textContent = decision.decision;
            decisionEl.className = decision.allowed ? 'decision-go' : 'decision-stop';
            document.getElementById('market-filter-summary').innerHTML = filters.ok
                ? `<span title="Approximate ADX measures strength; efficiency measures how direct the move was.">Regime <b>${filters.regime === 'trend' ? 'TREND' : filters.regime === 'range' ? 'RANGE' : 'TRANSITION'} · approx. ADX ${filters.adx.toFixed(1)} · efficiency ${filters.efficiency.toFixed(2)}</b></span>`
                    + `<span title="Relative volume ≥ 1.10 and position versus rolling VWAP confirm the breakout.">Liquidity <b>${filters.volumeAvailable ? `Relative volume ${filters.relativeVolume.toFixed(2)}× · 21-candle VWAP ${filters.vwap.toFixed(priceDecimals(filters.vwap))}` : 'VOLUME UNAVAILABLE'}</b></span>`
                    + `<span title="Percentile versus recent history: P80 means volatility exceeds 80% of observations.">Volatility <b>ATR percentile ${filters.atrPercentile.toFixed(0)} · ${filters.volatility === 'high' ? 'HIGH RISK' : filters.volatility === 'low' ? 'LOW' : 'NORMAL'}</b></span>`
                : `<span>${filters.error}</span>`;
            document.getElementById('entry-checks').innerHTML = decision.checks
                .map(check => `<div class="entry-check ${check.pass ? 'pass' : 'fail'}"><b>${check.pass ? '✓' : '×'}</b><span>${check.label}</span></div>`).join('');
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
            candlesHistory = []; lastBarTime = 0; lastClose = null; liveCandle = null;
            lastTimeframe  = timeframe; lastSymbol = symbol;
            lastMarketPrice = null; lastPriceSource = 'Yahoo Finance';
            lastBidPrice = null; lastAskPrice = null;
            historyAlignedToEtoro = false;
            lastCombinedAnalysis = null; lastAtrValue = null;
            try {
                const savedModel = JSON.parse(localStorage.getItem(`atr-model-${symbol}-${timeframe}`));
                modelParams = savedModel?.params
                    ? { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS, ...savedModel.params }
                    : { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
            } catch (_) {
                modelParams = { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
            }

            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            
            const rangeMap = {
                '1m': '7d', '2m': '60d', '5m': '60d', '15m': '60d', '30m': '60d',
                '60m': '2y', '1h': '2y', '4h': '2y', '1d': '5y', '1w': '10y'
            };
            const dataRange = rangeMap[timeframe] || '60d';
            candlesHistory = await fetchHistory(ySymbol, yInterval, dataRange);
            if (candlesHistory.length > 0) lastBarTime = candlesHistory[candlesHistory.length - 1].t * 1000;
            
            isSyncing = false;
            performCalculations(timeframe, symbol);
            await calibrateHistoricalModel(symbol, timeframe, candlesHistory.map(candle => candle.c), 'full refresh');
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
            const msMap = {
                '1m': 60000, '2m': 120000, '5m': 300000, '15m': 900000,
                '30m': 1800000, '60m': 3600000, '1h': 3600000,
                '4h': 14400000, '1d': 86400000, '1w': 604800000
            };
            const barDuration = msMap[timeframe] || 60000;
            const currentBarTime = Math.floor(now / barDuration) * barDuration;

            if (!liveCandle || currentBarTime > liveCandle.t * 1000) {
                // Only the previous partial candle can become a closed candle.
                // Keep the current-period candle separate so it cannot contaminate
                // ATR, Fourier, Wavelet, volume or calibration.
                if (liveCandle && (!candlesHistory.length || liveCandle.t > candlesHistory.at(-1).t)) {
                    candlesHistory.push(liveCandle);
                    if (candlesHistory.length > 5000) candlesHistory.shift();
                    recalibrateIfAlignmentIsLow(symbol, timeframe, candlesHistory);
                }
                liveCandle = {
                    t: Math.floor(currentBarTime / 1000),
                    o: Number.isFinite(data.Open) ? data.Open : data.Close,
                    h: Number.isFinite(data.High) ? data.High : data.Close,
                    l: Number.isFinite(data.Low) ? data.Low : data.Close,
                    c: data.Close,
                    v: null,
                    partial: true
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
            '#atr-content-body, .plugin-grid, .plugin-column, .analysis-head, .summary-line, .levels-panel, .trade-plan-panel, .model-info-panel'
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

    document.addEventListener('pointermove', e => {
        if (!isDragging) return;
        const maxLeft = Math.max(0, window.innerWidth - Math.min(60, ui.offsetWidth));
        const maxTop = Math.max(0, window.innerHeight - Math.min(35, ui.offsetHeight));
        ui.style.left = `${Math.max(0, Math.min(e.clientX - offsetX, maxLeft))}px`;
        ui.style.top = `${Math.max(0, Math.min(e.clientY - offsetY, maxTop))}px`;
        ui.style.right = 'auto';
    });

    const finishDragging = () => {
        if (!isDragging) return;
        isDragging = false;
        ui.classList.remove('is-dragging');
        const rect = ui.getBoundingClientRect();
        localStorage.setItem('atr-plugin-position', JSON.stringify({ left: rect.left, top: rect.top }));
    };
    document.addEventListener('pointerup', finishDragging);
    document.addEventListener('pointercancel', finishDragging);

    // --- Listeners de Eventos (UI) ---
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
        if (visibleCyclesCount < 15) { 
            visibleCyclesCount++;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            const { symbol } = getMetadata();
            performCalculations(lastTimeframe, symbol);
        }
    });

    document.getElementById('trend-simulation-btn').addEventListener('click', () => {
        const output = document.getElementById('trend-simulation-output');
        const leverage = readNumber('lev-amount');
        const fee = window.EToroAnalytics.getEtoroFeeProfile(lastSymbol, leverage);
        const barsPerYearByTimeframe = { '1m': 60 * 24 * 252, '5m': 12 * 24 * 252, '15m': 4 * 24 * 252, '30m': 2 * 24 * 252, '1h': 24 * 252, '4h': 6 * 252, '1d': 252 };
        const result = window.EToroAnalytics.compareTrendMethods(
            candlesHistory.map(candle => candle.c),
            { harmonics: 5, feePercent: fee.openFeePercent, barsPerYear: barsPerYearByTimeframe[lastTimeframe] || 24 * 252 }
        );
        if (!result.ok) {
            output.innerHTML = `<span class="plan-warning">${result.error}</span>`;
            return;
        }
        const row = (name, data) => `<div><b>${name}</b><span>Acierto ${(data.accuracy * 100).toFixed(1)}%</span><span>Ret. ${(data.return * 100).toFixed(1)}%</span><span>DD ${(data.maxDrawdown * 100).toFixed(1)}%</span><span>Sharpe ${data.sharpe.toFixed(2)}</span></div>`;
        output.innerHTML = row('Log 16', result.logPrice) + row('Fourier ×5', result.fourier5)
            + `<small>${result.logPrice.observations} predictions · cost ${result.feePercent.toFixed(3)}% per side · walk-forward</small>`;
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

    document.getElementById('chk-show-price').addEventListener('change', () => {
        const { symbol } = getMetadata();
        performCalculations(lastTimeframe, symbol);
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

    const btnRefresh = document.getElementById('atr-refresh-btn');
    btnRefresh.addEventListener('click', async () => {
        console.log("[ATR] 🖱️ User requested a manual refresh.");
        if (isSyncing) return;
        btnRefresh.classList.add('spinning');
        btnRefresh.disabled = true;
        document.getElementById('atr-status').innerText = 'Refreshing everything…';
        document.getElementById('fourier-cycle').innerText = 'Updating…';
        document.getElementById('fourier-forecast-output').innerText = 'Rebuilding projection…';
        document.getElementById('market-filter-summary').innerText = 'Recalculating filters…';
        document.getElementById('entry-checks').innerText = '';
        document.getElementById('entry-decision').innerText = 'NOT VIABLE';
        document.getElementById('trade-plan-output').innerText = 'Recalculating TP / SL…';
        document.getElementById('wavelet-components').innerText = 'Rebuilding Wavelet…';
        document.getElementById('calibration-status').innerText = 'Recalculating constants…';
        ['fourier-canvas', 'reconstruction-canvas', 'fourier-forecast-canvas', 'wavelet-canvas'].forEach(id => {
            const canvas = document.getElementById(id);
            canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        });
        calibrationToken++;
        lastSymbol = null;
        lastTimeframe = null;
        candlesHistory = [];
        liveCandle = null;
        lastBarTime = 0;
        lastClose = null;
        lastMarketPrice = null;
        lastBidPrice = null;
        lastAskPrice = null;
        lastCombinedAnalysis = null;
        lastAtrValue = null;
        historyAlignedToEtoro = false;
        try {
            await monitor();
            if (!lastSymbol || !lastTimeframe || !candlesHistory.length) {
                throw new Error('Could not load history for the current asset.');
            }
            refreshEtoroQuotes();
            performCalculations(lastTimeframe, lastSymbol);
            updateBreakEven();
            updateTradePlan();
            document.getElementById('trend-simulation-btn').click();
            await runOpportunityScanner();
        } catch (error) {
            document.getElementById('atr-status').innerText = 'Refresh failed';
            document.getElementById('calibration-status').innerText = error.message;
            console.error('[ATR] Full refresh failed:', error);
        } finally {
            btnRefresh.classList.remove('spinning');
            btnRefresh.disabled = false;
        }
    });

    // Lanzamiento
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
    scheduleOpportunityScanner();
    runOpportunityScanner();
    setInterval(refreshEtoroQuotes, 1000);
    setInterval(monitor, 10000);
})();
