(async () => {
    /**
     * ========================================================================
     * 1. CONFIGURACIÓN Y ESTADO GLOBAL
     * ========================================================================
     * Manejo de la persistencia de datos y sincronización del buffer.
     */
    const N = 128;                       // Tamaño de la muestra (Ventana de análisis)
    let candlesHistory  = [];            // Buffer de velas (OHLC)
    let lastClose       = null;          // Último precio de cierre detectado
    let lastTimeframe   = null;          // Timeframe actual del gráfico
    let lastSymbol      = null;          // Símbolo actual del activo
    let lastBarTime     = 0;             // Timestamp de la última barra procesada
    let lastCalcTime    = 0;             // Control del intervalo de cálculo
    let isSyncing       = false;         // Flag para evitar descargas duplicadas
    let visibleCyclesCount = 1;          // Cantidad de armónicos a mostrar
    let visibleWaveletLevels = 2;         // Componentes Haar con mayor energía
    let lastMarketPrice = null;           // Precio base para el TP de equilibrio
    let lastPriceSource = 'Yahoo Finance';
    let lastBidPrice = null;
    let lastAskPrice = null;
    let modelParams = { ...window.EToroAnalytics.DEFAULT_MODEL_PARAMS };
    let calibrationToken = 0;
    let lastCombinedAnalysis = null;
    let lastAtrValue = null;
    let historyAlignedToEtoro = false;

    const injectCSS = () => {
        const style = document.createElement('style');
        style.id = 'atr-plugin-styles'; // Un ID para evitar duplicados
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
     * 2. UTILIDADES DE EXTRACCIÓN Y MAPEO
     * ========================================================================
     * Funciones para sincronizar el DOM de eToro con los requerimientos de la API.
     */
    
    // Obtiene el Símbolo y Timeframe directamente desde el DOM de eToro
    // Obtiene el Símbolo y Timeframe filtrando páginas de sistema
    const getMetadata = () => {
        const pathParts = window.location.pathname.split('/');
        let symbol = pathParts[2]?.toUpperCase();
        
        // LISTA NEGRA: Palabras reservadas de eToro que NO son activos
        const ignored = ['PORTFOLIO', 'WATCHLIST', 'DISCOVER', 'MARKETS', 'BREAKDOWN', 'SETTINGS', 'COPY', 'PEOPLE'];
        
        // Si la URL es algo como /portfolio/breakdown, ignoramos
        if (!symbol || ignored.includes(symbol)) {
            // Intento secundario: a veces el símbolo está en la parte 3 (/markets/gold)
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
        
        // Si detectamos "BREAKDOWN" u otra palabra prohibida, abortamos silenciosamente
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

    // Traduce los términos de eToro a nomenclatura compatible con Yahoo Finance
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
     * 3. CAPA DE COMUNICACIÓN (API YAHOO FINANCE)
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
                t, h: quotes.high[i], l: quotes.low[i], c: quotes.close[i]
            })).filter(v => Number.isFinite(v.h) && Number.isFinite(v.l) && Number.isFinite(v.c));
        };

        console.log(`%c[ATR] 🌐 Intentando descarga desde ${queryHost}...`, "color: #4fc3f7");

        // 1) Prioridad: usar el background script (sin CORS, más fiable)
        try {
            const response = await chrome.runtime.sendMessage({ action: 'fetchYahooChart', url: targetUrl });
            if (response?.ok && response?.data) {
                const candles = parseChartResult(response.data);
                if (candles?.length) {
                    if (indicator) indicator.style.background = '#00e676';
                    console.log(`%c[ATR] ✅ Conexión exitosa (background)`, "color: #00e676");
                    return candles;
                }
            }
        } catch (e) {
            console.warn('[ATR] Background fetch falló:', e?.message || e);
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
                    console.log(`%c[ATR] ✅ Conexión exitosa (${config.url.split('/')[2]})`, "color: #00e676");
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
       4. LÓGICA MATEMÁTICA (FOURIER & FFT)
       ======================================================================== */
    /**
     * Aplica "Detrending" a la serie temporal mediante regresión lineal.
     * Remueve la tendencia para que la FFT se enfoque en la estacionalidad/ciclos.
     * Ecuaciones: $m = \frac{n\sum xy - \sum x \sum y}{n\sum x^2 - (\sum x)^2}$ y $b = \frac{\sum y - m\sum x}{n}$
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

        // Retorna el residual: valor real menos el valor de la tendencia
        return data.map((y, x) => y - (slope * x + intercept));
    }

    /**
     * Implementación Recursiva de la Transformada Rápida de Fourier (FFT).
     * @param {Array} input - Datos residuales (detrended).
     * @returns {Array} - Espectro de frecuencias con componentes reales e imaginarios.
     */

    /**
     * Calcula el Average True Range (ATR) de 14 periodos.
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
        
        // Promedio simple de los últimos 'period' valores de TR
        const slice = trValues.slice(-period);
        return slice.reduce((a, b) => a + b, 0) / period;
    }

    function fourierTransform(input) {
        const n = input.length;
        if (n <= 1) return input.map(v => ({ real: v, imag: 0 }));

        // En lugar de filter, separamos por índices para evitar iteraciones extra
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
       5. CONSTRUCCIÓN DE LA INTERFAZ (UI)
       ======================================================================== */
    // --- Inicialización del Contenedor ---
    const ui = document.createElement('div');
    ui.id    = 'etoro-atr-plugin';

    // --- Persistencia y Estado ---
    const savedInv    = localStorage.getItem('atr-plugin-inv') || "1000";
    const savedLev    = localStorage.getItem('atr-plugin-lev') || "1";
    const savedTradeSide = localStorage.getItem('atr-plugin-trade-side') || 'long';
    const isMinimized = localStorage.getItem('atr-plugin-minimized') === 'true';
    
    // --- Estructura HTML ---
    /* ========================================================================
   CORRECCIÓN SECCIÓN 5: UI SIMPLIFICADA
   ======================================================================== */
    ui.innerHTML = `
        <div class="atr-header-row">
            <div class="atr-brand"><img src="${chrome.runtime.getURL('icons/icon32.png')}" alt=""><div class="atr-header">ATR(14) Assistant</div></div>
            <div id="conn-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff5252; margin-left: 5px;" title="Estado de Conexión"></div>
            <div style="display: flex; gap: 5px; align-items: center;">
                <button id="atr-refresh-btn" class="atr-btn" title="Refrescar Datos">⟳</button>
                <button id="atr-min-btn">${isMinimized ? '▢' : '_'}</button>
            </div>
        </div>

        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : 'display: block;'}">
            <div class="plugin-grid">
                <section class="plugin-column operation-column">
                    <div class="summary-line">
                        <b id="atr-status">Sincronizando...</b>
                        <span>ATR(14) <b id="val-atr">0.00</b></span>
                    </div>
                    <div class="market-price-card">
                        <span>Precio actual</span>
                        <b id="current-price">--</b>
                        <small id="price-source">Esperando fuente…</small>
                    </div>
                    <div class="input-row">
                        <label>Importe operación ($)
                            <input type="number" id="inv-amount" value="${savedInv}" min="1" step="10">
                        </label>
                        <label>Apalancamiento
                            <select id="lev-amount">
                                ${[1, 2, 5, 10, 20, 30].map(value => `<option value="${value}" ${String(value) === savedLev ? 'selected' : ''}>X${value}</option>`).join('')}
                            </select>
                        </label>
                    </div>
                    <div class="cost-panel">
                        <div class="cost-title">TP de equilibrio</div>
                        <div id="fee-profile">Identificando tarifa…</div>
                        <div id="breakeven-output">Esperando precio…</div>
                        <div class="cost-note">Cubre apertura y cierre estimados. No incluye financiación nocturna ni deslizamiento.</div>
                    </div>
                    <div class="ohlc-title">Última vela detectada</div>
                    <div class="atr-ohlc">
                        O <span id="val-o">-</span> · H <span id="val-h">-</span> · L <span id="val-l">-</span> · C <span id="val-c">-</span>
                    </div>
                    <div id="trend-summary-legend">
                        <span>Tendencia actual <b id="txt-current-status">--</b></span>
                        <span>Posible ruptura <b id="txt-consensus">--</b></span>
                        <span>Confirmación <b id="txt-reversal">--</b></span>
                    </div>
                    <div class="levels-panel">
                        <div class="levels-title">Soportes y resistencias Wavelet</div>
                        <div class="wavelet-zone-columns">
                            <label>Soportes<select id="wavelet-supports"><option>--</option></select></label>
                            <label>Resistencias<select id="wavelet-resistances"><option>--</option></select></label>
                        </div>
                        <div><span>ATR actual</span><b id="current-atr-distance">--</b></div>
                        <div><span>SL recomendado</span><b id="recommended-atr">--</b></div>
                        <span>Combinación <b id="combined-score">--</b></span>
                    </div>
                </section>

                <section class="plugin-column analysis-column fourier-column">
                    <div class="analysis-head">
                        <b>Fourier</b>
                        <span><span id="f-samples">--</span> velas · <span id="f-tf">--</span></span>
                    </div>
                    <div class="chart-title">Espectro Fourier <small>Barras altas = ciclos dominantes</small></div>
                    <canvas id="fourier-canvas" width="240" height="54"></canvas>
                    <div class="chart-legend"><span class="dot dominant"></span>Dominante <span class="dot secondary"></span>Otras frecuencias · <b id="fourier-cycle">Cargando…</b></div>

                    <div class="chart-title reconstruction-title">Precio y reconstrucción</div>
                    <div id="recon-legend" class="chart-legend reconstruction-legend">
                        <span class="dot real"></span>Precio real
                        <span class="dot cycles"></span>Ciclos
                        <span class="dot total"></span>Tendencia + ciclos
                        <label><input type="checkbox" id="chk-show-price" checked> Mostrar precio</label>
                    </div>
                    <canvas id="reconstruction-canvas" width="240" height="62"></canvas>
                    <div class="time-legend">
                        <span>Inicio <b id="leg-time">--:--</b></span>
                        <span>Última <b id="leg-mkt-last">--:--</b></span>
                        <span>Pendiente/vela <b id="leg-slope">0.0000</b></span>
                    </div>

                    <div class="cycles-toolbar">
                        <span>Armónicos activos</span>
                        <button id="k-minus" class="atr-btn">−</button>
                        <b id="k-count-label">1</b>
                        <button id="k-plus" class="atr-btn">+</button>
                    </div>
                    <div id="fourier-top-list"></div>
                </section>

                <section class="plugin-column analysis-column forecast-column">
                    <div class="analysis-head">
                        <b>Proyección y operación</b>
                        <span>Horizonte 12 h</span>
                    </div>
                    <div class="chart-title reconstruction-title">Trayectoria Fourier futura</div>
                    <canvas id="fourier-forecast-canvas" width="240" height="62"></canvas>
                    <div id="fourier-forecast-output" class="forecast-output">Esperando proyección…</div>
                    <div class="simulation-panel">
                        <button id="trend-simulation-btn" class="atr-btn">Simular log-precio vs Fourier ×5</button>
                        <div id="trend-simulation-output">Usa las velas ya cargadas y predice únicamente la vela siguiente.</div>
                    </div>
                    <div class="trade-plan-panel">
                        <div class="trade-plan-head">
                            <b>TP / SL mínimos válidos</b>
                            <select id="trade-plan-side">
                                <option value="long" ${savedTradeSide === 'long' ? 'selected' : ''}>COMPRA</option>
                                <option value="short" ${savedTradeSide === 'short' ? 'selected' : ''}>VENTA</option>
                            </select>
                        </div>
                        <div id="trade-plan-output">Esperando zonas Wavelet…</div>
                        <div class="trade-plan-note">Reglas: TP &gt; SL; beneficio TP &gt; 2× coste de apertura; SL &gt; 1,50 ATR. Las zonas Wavelet indican si hay espacio técnico.</div>
                    </div>
                </section>

                <section class="plugin-column analysis-column wavelet-column">
                    <div class="analysis-head">
                        <b>Wavelet</b>
                        <span>Haar · 128 velas</span>
                    </div>
                    <div class="chart-title wavelet-title">Reconstrucción Wavelet Haar <small>Componentes multiescala</small></div>
                    <div class="chart-legend wavelet-legend">
                        <span class="dot real"></span>Precio real
                        <span class="dot wave-components"></span>Componentes
                        <span class="dot wave-total"></span>Reconstrucción
                    </div>
                    <canvas id="wavelet-canvas" width="240" height="62"></canvas>
                    <div class="chart-legend wavelet-legend">
                        <span>Componentes activos</span>
                        <button id="w-minus" class="atr-btn">−</button>
                        <b id="w-count-label">2</b>
                        <button id="w-plus" class="atr-btn">+</button>
                    </div>
                    <div id="wavelet-components">Esperando datos…</div>
                    <div class="model-info-panel">
                        <div class="model-info-title">Ecuaciones y calibración</div>
                        <div class="equation-line"><b>Combinación</b> C = (F·wF + W·wW + A·wA) / Σw</div>
                        <div class="equation-line"><b>Fourier</b> F = min(1, movimiento / (2·movimiento mínimo))</div>
                        <div class="equation-line"><b>Wavelet</b> W = contactos × recencia de la zona</div>
                        <div class="equation-line"><b>Alineación</b> A = max(0, 1 − distancia / (2·ATR))</div>
                        <div id="model-parameters">wF -- · wW -- · wA -- · umbral --</div>
                        <div class="split-grid">
                            <span>Entrena 80% <b id="split-train">--</b></span>
                            <span>Test 10% <b id="split-test">--</b></span>
                            <span>Valida 10% <b id="split-validation">--</b></span>
                        </div>
                        <div id="calibration-status">Calibración histórica pendiente…</div>
                        <div id="calibration-updated">Última actualización: --</div>
                    </div>
                </section>
            </div>
        </div>
    `;

    // --- Inyección en el DOM ---
    Object.assign(ui.style, { position: 'fixed', top: '100px', right: '20px', zIndex: '10000' });
    ui.classList.toggle('atr-minimized', isMinimized);

    document.body.appendChild(ui);
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
            closeFeePercent: fee.closeFeePercent
        };
        const longResult = window.EToroAnalytics.calculateBreakEvenTP({ ...common, side: 'long', entryPrice: longEntry });
        const shortResult = window.EToroAnalytics.calculateBreakEvenTP({ ...common, side: 'short', entryPrice: shortEntry });
        const priceEl = document.getElementById('current-price');
        const sourceEl = document.getElementById('price-source');
        if (lastBidPrice && lastAskPrice) {
            priceEl.textContent = `${lastBidPrice.toFixed(priceDecimals(lastBidPrice))} / ${lastAskPrice.toFixed(priceDecimals(lastAskPrice))}`;
            sourceEl.textContent = 'Venta / Compra · fuente: eToro';
        } else {
            priceEl.textContent = lastMarketPrice.toFixed(priceDecimals(lastMarketPrice));
            sourceEl.textContent = `Fuente: ${lastPriceSource}`;
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
        output.innerHTML = `<div><span>COMPRA</span><b>≥ ${longResult.targetPrice.toFixed(decimals)}</b><small>+${longResult.distancePercent.toFixed(3)}%</small></div>`
            + `<div><span>VENTA</span><b>≤ ${shortResult.targetPrice.toFixed(decimals)}</b><small>−${shortResult.distancePercent.toFixed(3)}%</small></div>`
            + `<p>Coste ida/vuelta ≈ $${longResult.estimatedCostAtTarget.toFixed(2)}</p>`;
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
            openingCostMultiple: 2
        });
        if (!result.ok) {
            output.innerHTML = `<div class="plan-warning">${result.error}</div>`;
            return;
        }
        const plan = result.best;
        const decimals = priceDecimals(entryPrice);
        const targetReference = plan.targetIndex ? ` · ${side === 'long' ? 'R' : 'S'}${plan.targetIndex}` : ' · respaldo';
        const stopReference = plan.stopIndex ? ` · ${side === 'long' ? 'S' : 'R'}${plan.stopIndex}` : ' · ATR';
        const fallbackNotice = result.fallback
            ? `<div class="plan-alert bad">⚠ ${result.reason} TP de respaldo = ${plan.rewardRisk.toFixed(2)} × SL.</div>`
            : `<div class="plan-alert ok">✓ ${result.validCount}/${result.totalCount} combinaciones válidas; elegida por R/R (70%) y fuerza Wavelet (30%)</div>`;
        output.innerHTML = `
            <div class="plan-level"><span>Entrada ${side === 'long' ? 'COMPRA' : 'VENTA'}</span><b>${entryPrice.toFixed(decimals)}</b></div>
            <div class="plan-level target"><span>TP elegido${targetReference}</span><b>${plan.technicalTarget.toFixed(decimals)}</b><small>Δ ${plan.targetDistance.toFixed(decimals)} · ${plan.targetPercent.toFixed(2)}% · +$${plan.potentialProfit.toFixed(2)}</small></div>
            <div class="plan-level stop"><span>SL elegido${stopReference}</span><b>${plan.technicalStop.toFixed(decimals)}</b><small>Δ ${plan.stopDistance.toFixed(decimals)} · ${plan.stopPercent.toFixed(2)}% · −$${plan.potentialLoss.toFixed(2)}</small></div>
            <div class="plan-level minimum"><span>Mejor combinación</span><b>R/R ${plan.rewardRisk.toFixed(2)}</b><small>Fuerza TP ${(plan.targetStrength * 100).toFixed(0)}% · SL ${(plan.stopStrength * 100).toFixed(0)}%</small></div>
            <div class="plan-alert ok">✓ TP &gt; SL · beneficio &gt; $${plan.minimumProfit.toFixed(2)} · SL &gt; ${plan.recommendedAtrMultiple.toFixed(2)} ATR</div>
            ${fallbackNotice}`;
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
        lastPriceSource = 'precios ejecutables de eToro';
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

    const calibrateHistoricalModel = (symbol, timeframe, prices, reason = 'automática') => {
        const token = ++calibrationToken;
        const status = document.getElementById('calibration-status');
        if (status) status.textContent = `Actualizando (${reason}) · pasos de 0,01…`;
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
            const updatedAt = new Date().toLocaleString('es-EC', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            });
            document.getElementById('model-parameters').textContent =
                `wF ${result.params.fourierWeight.toFixed(2)} · wW ${result.params.waveletWeight.toFixed(2)} · `
                + `wA ${result.params.alignmentWeight.toFixed(2)} · U ${result.params.signalThreshold.toFixed(2)} · `
                + `zona ${result.params.zoneWidthAtr.toFixed(2)} ATR · mov. mín. ${result.params.minMoveAtr.toFixed(2)} ATR`;
            document.getElementById('split-train').textContent =
                `${result.splits.train.count} casos · ${(result.splits.train.accuracy * 100).toFixed(1)}%`;
            document.getElementById('split-test').textContent =
                `${result.splits.test.count} casos · ${(result.splits.test.accuracy * 100).toFixed(1)}%`;
            document.getElementById('split-validation').textContent =
                `${result.splits.validation.count} casos · ${(result.splits.validation.accuracy * 100).toFixed(1)}%`;
            if (status) status.textContent = `Calculado (${reason}) · ${result.samples} casos cronológicos`;
            document.getElementById('calibration-updated').textContent = `Última actualización: ${updatedAt}`;
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
            const checkedAt = new Date().toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
            status.textContent = `Revisado ${checkedAt} · alineación ${(combined.score * 100).toFixed(0)}/100 alta; constantes conservadas`;
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
        });
    });
    document.getElementById('trade-plan-side').addEventListener('change', event => {
        localStorage.setItem('atr-plugin-trade-side', event.target.value);
        updateTradePlan();
    });

    /* ========================================================================
       6. RENDERIZADO Y DIBUJO
       ======================================================================== */
    /**
     * Dibuja el espectro de magnitudes de Fourier.
     * Permite visualizar qué frecuencias (k) tienen más "peso" en el precio.
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
     * Reconstruye la señal en el dominio del tiempo.
     * Aplica la tendencia calculada (m, b) y superpone los ciclos armónicos.
     */
    function reconstructionDraw(spectrum, selectedK, N_val, sample) {
        const canvas    = document.getElementById('reconstruction-canvas');
        const showPrice = document.getElementById('chk-show-price')?.checked;
        if (!canvas || !sample || sample.length < N_val) return;

        const ctx    = canvas.getContext('2d');
        const prices = sample.map(v => v.c);
        const logPrices = prices.map(Math.log);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Regresión Lineal: Cálculo de Pendiente (m) e Intercepto (b)
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < N_val; i++) {
            sumX += i; sumY += logPrices[i];
            sumXY += i * logPrices[i]; sumX2 += i * i;
        }
        const slope     = (N_val * sumXY - sumX * sumY) / (N_val * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / N_val;

        // 2. Actualización de Labels de Tiempo (Mercado -> Ecuador)
        const optEcu = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' };
        document.getElementById('leg-time').innerText     = new Date(sample[0].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-mkt-last').innerText = new Date(sample[sample.length - 1].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-slope').innerText    = `${((Math.exp(slope) - 1) * 100).toFixed(3)}%`;

        // 3. Síntesis de la señal mediante los componentes K seleccionados
        let signalBase = new Array(N_val).fill(0);
        selectedK.forEach(item => {
            const comp = spectrum[item.k];
            const ampFactor = 2 / N_val; // Factor crítico para que la onda azul no sea "plana" o "gigante"
            for (let i = 0; i < N_val; i++) {
                const angle = (2 * Math.PI * item.k * i) / N_val;
                signalBase[i] += (comp.real * Math.cos(angle) - comp.imag * Math.sin(angle)) * ampFactor;
            }
        });

        // 4. Mapeo a escala real
        const meanLog = logPrices.reduce((sum, value) => sum + value, 0) / N_val;
        let signalTrended    = signalBase.map((val, i) => Math.exp(val + (slope * i) + intercept));
        let signalOnlyCycles = signalBase.map(val => Math.exp(val + meanLog));

        // 5. Normalización Global y Dibujo
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

        if (showPrice) drawLine(prices, '#00e676', 1);        // Verde: Mercado Real
        drawLine(signalOnlyCycles, '#4fc3f7', 1);            // Azul: Solo Ciclos
        drawLine(signalTrended, '#ff5252', 1.5);             // Roja: Reconstrucción Total
    }

    function drawFourierForecast(result, atr, longTarget, shortTarget, minutesPerBar) {
        const canvas = document.getElementById('fourier-forecast-canvas');
        const output = document.getElementById('fourier-forecast-output');
        if (!canvas || !output || !result?.ok) return;
        const ctx = canvas.getContext('2d');
        const levels = [result.current + atr, result.current - atr];
        if (Number.isFinite(longTarget)) levels.push(longTarget);
        if (Number.isFinite(shortTarget)) levels.push(shortTarget);
        const all = [...result.forecast, ...levels];
        const min = Math.min(...all);
        const max = Math.max(...all);
        const range = max - min || 1;
        const x = index => index / Math.max(1, result.forecast.length - 1) * canvas.width;
        const y = value => canvas.height - (value - min) / range * canvas.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#11151d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
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
        if (Number.isFinite(longTarget)) level(longTarget, '#55e8a2', 'TP compra');
        if (Number.isFinite(shortTarget)) level(shortTarget, '#ff7d7d', 'TP venta');
        ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 1.6; ctx.beginPath();
        result.forecast.forEach((value, index) => index ? ctx.lineTo(x(index), y(value)) : ctx.moveTo(x(index), y(value)));
        ctx.stroke();
        const duration = bars => {
            const totalMinutes = bars * minutesPerBar;
            return totalMinutes < 60 ? `${totalMinutes} min` : `${(totalMinutes / 60).toFixed(totalMinutes % 60 ? 1 : 0)} h`;
        };
        let status;
        if (result.winner) {
            const label = result.winner.direction === 'up' ? 'ALCISTA' : 'BAJISTA';
            status = `<b class="${result.winner.direction === 'up' ? 'cycle-up' : 'cycle-down'}">${label}</b> · ATR en ${duration(result.winner.atrBar)} · TP en ${duration(result.winner.targetBar)}`;
        } else if (result.upAtrBar !== null || result.downAtrBar !== null) {
            const direction = result.upAtrBar !== null && (result.downAtrBar === null || result.upAtrBar < result.downAtrBar) ? 'ALCISTA' : 'BAJISTA';
            const bar = direction === 'ALCISTA' ? result.upAtrBar : result.downAtrBar;
            status = `<b class="cycle-turning">${direction}: ATR en ${duration(bar)}, TP no alcanzado</b>`;
        } else {
            status = '<b class="cycle-turning">SIN CONFIRMACIÓN: no supera 1 ATR</b>';
        }
        const cycles = result.cycleDirections.map(item => `K${item.k}`).join(', ');
        output.innerHTML = `${status}<small>${result.harmonics} ciclos: ${cycles} · alineación ${(result.alignment * 100).toFixed(0)}%${result.ambiguous ? ' · ⚠ ambas direcciones alcanzan TP' : ''}</small>`;
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
            .map((component, index) => `#${index + 1}: escala ${component.scale} velas`)
            .join(' · ');
    }

    /* ========================================================================
       7. MONITOR PRINCIPAL (LOOP)
       ======================================================================== */
    /**
     * Genera el HTML de la lista de ciclos con indicadores de tendencia (F).
     */
    const renderListWithHistory = (list, color, isTop, N_val) => {
        return list.map((item, i) => {
            const p = N_val / item.k;
            const label = isTop ? `Ciclo ${i + 1}` : `Frecuencia ${item.k}`;
            const phase = window.EToroAnalytics.fourierComponentDirection(item, N_val);
            const direction = phase.direction === 'up'
                ? { label: 'ALCISTA', arrow: '▲', css: 'cycle-up' }
                : phase.direction === 'down'
                    ? { label: 'BAJISTA', arrow: '▼', css: 'cycle-down' }
                    : { label: 'GIRO/LATERAL', arrow: '◆', css: 'cycle-turning' };
            return `<div class="fourier-cycle-row"><span style="color:${color}">${label}</span><b>${p.toFixed(1)} velas</b><strong class="${direction.css}" title="Dirección de fase estimada para la próxima vela">${direction.arrow} ${direction.label}</strong></div>`;
        }).join('');
    };

    /**
     * Ejecuta el análisis matemático sobre el buffer actual.
     */
    /**
     * Ejecuta el análisis matemático sobre el buffer actual.
     */
    
    /**
     * Ejecuta el análisis matemático sobre el buffer actual.
     */
    const performCalculations = (timeframe, currentSymbol = lastSymbol) => {
        // Log de entrada
        console.log(`[ATR] 🧮 Calculando... Buffer: ${candlesHistory.length} velas.`);

        if (candlesHistory.length && !lastBidPrice && !lastAskPrice && !lastPriceSource.includes('eToro')) {
            lastMarketPrice = candlesHistory[candlesHistory.length - 1].c;
            lastPriceSource = 'Yahoo Finance';
            updateBreakEven();
        }

        if (candlesHistory.length < N) {
            console.warn(`[ATR] ⚠️ Buffer insuficiente (${candlesHistory.length}/${N}). Esperando más datos...`);
            document.getElementById('fourier-cycle').innerText = `Buffer: ${candlesHistory.length}/${N}`;
            return;
        }

        try {    
            const sample     = candlesHistory.slice(-N); 
            const prices     = sample.map(v => v.c);
            // Fourier trabaja en log-precio: cambios porcentuales se vuelven aditivos
            // y los ciclos dejan de depender de la escala nominal del activo.
            const cleanData  = fourierDetrend(prices.map(Math.log));
            const spectrum   = fourierTransform(cleanData);
            const currentIdx = N - 1;

            // Magnitudes y Ciclo Dominante
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
                harmonics: Math.min(visibleCyclesCount, 5)
            });
            lastCombinedAnalysis = combined;
            lastAtrValue = atrValue;
            const breakEstimate = combined.fourier;
            const slope = breakEstimate?.trendSlope || 0;
            const currentStatusText = Math.abs(slope) < atrValue * 0.01
                ? 'LATERAL'
                : slope > 0 ? 'ALCISTA' : 'BAJISTA';
            const currentStatusColor = slope > 0 ? '#00e676' : slope < 0 ? '#ff5252' : '#ffeb3b';
            const candidate = breakEstimate?.candidate;
            const projectionText = candidate
                ? `${combined.active ? 'ACTIVA' : 'PREPARACIÓN'} ${candidate.direction === 'alcista' ? '▲' : '▼'} ${candidate.price.toFixed(priceDecimals(candidate.price))}`
                : 'SIN CANDIDATO';
            const projectionColor = candidate?.direction === 'alcista' ? '#00e676'
                : candidate?.direction === 'bajista' ? '#ff5252' : '#ffeb3b';

            // --- ACTUALIZACIÓN DE UI ---
            
            // 1. Estado Actual
            const statusEl = document.getElementById('txt-current-status');
            if (statusEl) {
                statusEl.innerText = currentStatusText;
                statusEl.style.color = currentStatusColor;
            }

            // 2. Proyección Futura
            const consensusEl = document.getElementById('txt-consensus');
            if (consensusEl) {
                consensusEl.innerText = projectionText;
                consensusEl.style.color = projectionColor;
            }
            
            // 3. Tiempo
            const reversalEl = document.getElementById('txt-reversal');
            if (reversalEl) {
                const waveletLabel = breakEstimate?.waveletActive ? 'Haar activa' : 'Haar sin confirmar';
                reversalEl.innerText = candidate ? `~${candidate.bars} velas · ${waveletLabel}` : waveletLabel;
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
            const zoneOption = (zone, index, prefix) => {
                const decimals = priceDecimals(zone.center);
                return `<option>${prefix}${index + 1} · ${zone.low.toFixed(decimals)}–${zone.high.toFixed(decimals)} · Δ${Math.abs(zone.center - currentPrice).toFixed(decimals)} · ${(zone.strength * 100).toFixed(0)}%</option>`;
            };
            document.getElementById('wavelet-supports').innerHTML = sortedSupports.length
                ? sortedSupports.slice(0, 4).map((zone, index) => zoneOption(zone, index, 'S')).join('') : '<option>Sin soporte &gt; 1,50 ATR</option>';
            document.getElementById('wavelet-resistances').innerHTML = sortedResistances.length
                ? sortedResistances.slice(0, 4).map((zone, index) => zoneOption(zone, index, 'R')).join('') : '<option>Sin resistencia &gt; 1,50 ATR</option>';
            const atrDecimals = priceDecimals(currentPrice);
            const exposureUnits = (readNumber('inv-amount') * readNumber('lev-amount')) / currentPrice;
            document.getElementById('current-atr-distance').innerText = `${atrValue.toFixed(atrDecimals)} · ${(atrValue / currentPrice * 100).toFixed(2)}%`;
            document.getElementById('recommended-atr').innerText = `1,50 ATR = ${recommendedAtrDistance.toFixed(atrDecimals)} · $${(exposureUnits * recommendedAtrDistance).toFixed(2)}`;
            document.getElementById('combined-score').innerText = `${(combined.score * 100).toFixed(0)}/100 ${combined.active ? 'ALINEACIÓN ALTA' : 'ALINEACIÓN BAJA'}`;
            
            // Actualizar resto de datos
            document.getElementById('f-samples').innerText = candlesHistory.length;
            document.getElementById('f-tf').innerText      = timeframe.toUpperCase();
            document.getElementById('fourier-cycle').innerText = `Ciclo Dom: ${domP.toFixed(1)}v`; // Quitamos F de aquí para limpiar
            document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(topVisible, '#4fc3f7', true, N, currentIdx, prices[N-1], prices.reduce((a,b)=>a+b)/N);
            
            const valAtrEl = document.getElementById('val-atr');
            if (valAtrEl) valAtrEl.innerText = atrValue.toFixed((currentSymbol === 'SILVER' || currentSymbol === 'XAGUSD') ? 4 : 2);
            
            fourierDraw(magnitudes.map(m => m.mag), domK - 1);
            reconstructionDraw(spectrum, topVisible, N, sample);
            waveletDraw(prices);
            const timeframeMinutes = (() => {
                const normalized = String(timeframe).toLowerCase();
                const amount = parseFloat(normalized) || 1;
                if (normalized.includes('d')) return amount * 1440;
                if (normalized.includes('h')) return amount * 60;
                return amount;
            })();
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
                stopBufferAtr: 0.10,
                recommendedAtrMultiple: 1.50,
                openingCostMultiple: 2
            });
            const longPlan = planFor('long');
            const shortPlan = planFor('short');
            const longTarget = longPlan.ok ? longPlan.best.technicalTarget : Infinity;
            const shortTarget = shortPlan.ok ? shortPlan.best.technicalTarget : -Infinity;
            const futureProjection = window.EToroAnalytics.projectFourierToTargets(prices, atrValue, {
                harmonics: visibleCyclesCount,
                horizonBars: Math.max(1, Math.ceil(720 / timeframeMinutes)),
                longTarget,
                shortTarget
            });
            drawFourierForecast(futureProjection, atrValue, longTarget, shortTarget, timeframeMinutes);
            updateTradePlan();
        } catch (e) {
            console.error(`[ATR] 💥 Error en cálculos: ${e.message}`);
        }
    };

    /* ========================================================================
       8. LÓGICA DE INTERACCIÓN Y EVENTOS
       ======================================================================== */
    /**
     * Monitor de cambios en el DOM y actualización en tiempo real.
     */
    const monitor = async () => {
        if (isSyncing) {
            console.log("[ATR] ⏳ Sincronización en curso, saltando ciclo.");
            return;
        }

        const { symbol, timeframe } = getMetadata(); // Aquí obtenemos el símbolo
        
        if (!symbol) {
            console.warn("[ATR] ⚠️ No se detectó símbolo en la URL o UI de eToro.");
            return;
        } 

        // Gestión de Cambio de Activo
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            console.log(`%c[ATR] 🔄 Cambio detectado: ${lastSymbol} -> ${symbol} (${timeframe})`, "color: yellow");
            isSyncing = true;
            candlesHistory = []; lastBarTime = 0; lastClose = null;
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
            performCalculations(timeframe, symbol); // <--- AHORA PASAMOS EL SÍMBOLO
            await calibrateHistoricalModel(symbol, timeframe, candlesHistory.map(candle => candle.c), 'actualización completa');
        }

        refreshEtoroQuotes();

        // Extracción OHLC del DOM de eToro
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

        // Si hay un nuevo precio de cierre, actualizamos
        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            if (!lastBidPrice && !lastAskPrice) {
                lastMarketPrice = data.Close;
                lastPriceSource = 'última vela del gráfico de eToro';
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

            if (currentBarTime > lastBarTime) {
                // La vela que estaba en curso ya cerró. Se calibra sin incluir
                // la nueva vela parcial para evitar anticipación de datos.
                const closedCandles = [...candlesHistory];
                candlesHistory.push({
                    t: Math.floor(currentBarTime / 1000),
                    o: Number.isFinite(data.Open) ? data.Open : data.Close,
                    h: Number.isFinite(data.High) ? data.High : data.Close,
                    l: Number.isFinite(data.Low) ? data.Low : data.Close,
                    c: data.Close
                });
                if (candlesHistory.length > 500) candlesHistory.shift();
                lastBarTime = currentBarTime;
                recalibrateIfAlignmentIsLow(symbol, timeframe, closedCandles);
            } else if (candlesHistory.length) {
                // Mantener la vela actualizada mientras continúa abierta. Estos
                // valores se dibujan, pero no entran en la calibración hasta cerrar.
                const liveCandle = candlesHistory[candlesHistory.length - 1];
                if (liveCandle.t * 1000 === currentBarTime) {
                    const open = Number.isFinite(data.Open) ? data.Open : data.Close;
                    const high = Number.isFinite(data.High) ? data.High : data.Close;
                    const low = Number.isFinite(data.Low) ? data.Low : data.Close;
                    liveCandle.o = Number.isFinite(liveCandle.o) ? liveCandle.o : open;
                    liveCandle.h = Math.max(Number.isFinite(liveCandle.h) ? liveCandle.h : high, high);
                    liveCandle.l = Math.min(Number.isFinite(liveCandle.l) ? liveCandle.l : low, low);
                    liveCandle.c = data.Close;
                }
            }
            performCalculations(timeframe, symbol);
        }
    }; 

    // --- Lógica de Arrastre (Drag & Drop) ---
    let isDragging = false;
    let offsetX, offsetY;

    const canStartDrag = e => {
        if (e.button !== 0 || e.target.closest('button, input, select, option, label, canvas, a')) return false;
        const rect = ui.getBoundingClientRect();
        const edgeSize = 10;
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
            performCalculations(lastTimeframe, symbol); // <--- Llamada 3: Añadir symbol
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
            + `<small>${result.logPrice.observations} predicciones · coste ${result.feePercent.toFixed(3)}% por lado · walk-forward</small>`;
    });

    // Listener de los botones - ¡Asegúrate de pasar el symbol!
    document.getElementById('k-minus').addEventListener('click', () => {
        if (visibleCyclesCount > 1) { 
            visibleCyclesCount--;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            const { symbol } = getMetadata(); // <--- OBTENER SYMBOL
            performCalculations(lastTimeframe, symbol); // <--- PASAR SYMBOL
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
        console.log("[ATR] 🖱️ Usuario solicitó actualización manual.");
        if (isSyncing) return;
        btnRefresh.classList.add('spinning');
        btnRefresh.disabled = true;
        document.getElementById('atr-status').innerText = 'Actualizando todo…';
        document.getElementById('fourier-cycle').innerText = 'Actualizando…';
        document.getElementById('fourier-forecast-output').innerText = 'Reconstruyendo proyección…';
        document.getElementById('trade-plan-output').innerText = 'Recalculando TP / SL…';
        document.getElementById('wavelet-components').innerText = 'Reconstruyendo Wavelet…';
        document.getElementById('calibration-status').innerText = 'Recalculando constantes…';
        ['fourier-canvas', 'reconstruction-canvas', 'fourier-forecast-canvas', 'wavelet-canvas'].forEach(id => {
            const canvas = document.getElementById(id);
            canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        });
        calibrationToken++;
        lastSymbol = null;
        lastTimeframe = null;
        candlesHistory = [];
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
                throw new Error('No se pudo cargar el historial del activo actual.');
            }
            refreshEtoroQuotes();
            performCalculations(lastTimeframe, lastSymbol);
            updateBreakEven();
            updateTradePlan();
            document.getElementById('trend-simulation-btn').click();
        } catch (error) {
            document.getElementById('atr-status').innerText = 'Error al actualizar';
            document.getElementById('calibration-status').innerText = error.message;
            console.error('[ATR] Actualización completa fallida:', error);
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
    setInterval(refreshEtoroQuotes, 1000);
    setInterval(monitor, 10000);
})();
