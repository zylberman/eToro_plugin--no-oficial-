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

    const injectCSS = () => {
        const style = document.createElement('style');
        style.id = 'atr-plugin-styles'; // Un ID para evitar duplicados
        style.innerHTML = `
            #etoro-atr-plugin {
                position: fixed; top: 65px; right: 20px; width: 220px;
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
            canvas { width: 100%; border-radius: 4px; background: #000; margin-bottom: 5px; border: 1px solid #2a2e39; }
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
            })).filter(v => v.c !== null);
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
    const isMinimized = localStorage.getItem('atr-plugin-minimized') === 'true';
    
    // --- Estructura HTML ---
    /* ========================================================================
   CORRECCIÓN SECCIÓN 5: UI SIMPLIFICADA
   ======================================================================== */
    ui.innerHTML = `
        <div class="atr-header-row">
            <div class="atr-header">ATR(14) Assistant</div>
            <div id="conn-indicator" style="width: 8px; height: 8px; border-radius: 50%; background: #ff5252; margin-left: 5px;" title="Estado de Conexión"></div>
            <div style="display: flex; gap: 5px; align-items: center;">
                <button id="atr-refresh-btn" class="atr-btn" title="Refrescar Datos">⟳</button>
                <button id="atr-min-btn">${isMinimized ? '▢' : '_'}</button>
            </div>
        </div>

        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : 'display: block;'}">
            <div id="atr-status">Sincronizando...</div>
            <div id="atr-value-container" style="margin: 5px 0; font-family: monospace;">
                ATR(14): <b id="val-atr" style="color: #ffeb3b; font-size: 14px;">0.00</b>
            </div>
            
            <div class="input-row">
                <div class="inv-group">
                    <label>Inversión ($):</label>
                    <input type="number" id="inv-amount" value="${savedInv}" step="100">
                </div>
                <div class="lev-group">
                    <label>Leverage:</label>
                    <input type="number" id="lev-amount" value="${savedLev}" min="1">
                </div>
            </div>
            
            <div id="fourier-metadata">
                Muestra: <span id="f-samples">--</span> velas | TF: <span id="f-tf">--</span>
            </div>
            <div id="fourier-cycle">Cargando...</div>
            
            <canvas id="fourier-canvas" width="200" height="40"></canvas>
            
            <div style="font-size: 0.65em; color: #aaa; margin: 4px 0;">Análisis Start / Mkt Last (Ecu):</div>
            
            <div id="recon-legend" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px; font-size: 0.62em; color: #aaa; margin-bottom: 4px; font-family: monospace;">
                <span>Start: <b id="leg-time" style="color:#fff;">--:--</b></span>
                <span style="text-align: right;">Last: <b id="leg-mkt-last" style="color:#fff;">--:--</b></span>
                <span>Tendencia m: <b id="leg-slope" style="color:#ff5252;">0.0000</b></span>
            </div>
            
            <canvas id="reconstruction-canvas" width="200" height="40"></canvas>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; border-bottom: 1px solid #333; padding-bottom: 3px;">
                <div style="display: flex; gap: 8px; align-items: center;">
                    <span style="font-size: 0.7em;">Top Ciclos:</span>
                    <label style="font-size: 0.7em; color: #00e676; display: flex; align-items: center; gap: 3px; cursor: pointer;">
                        <input type="checkbox" id="chk-show-price" checked style="width: 10px; height: 10px; margin: 0;"> Real
                    </label>
                </div>
                <div style="display: flex; gap: 5px; align-items: center;">
                    <button id="k-minus" class="atr-btn">-</button>
                    <span id="k-count-label" style="font-size: 10px; color: #4fc3f7; min-width: 10px; text-align: center;">1</span>
                    <button id="k-plus" class="atr-btn">+</button>
                </div>
            </div>

            <div id="fourier-top-list"></div>
            <div id="trend-summary-legend" style="margin-top: 8px; padding: 6px; background: rgba(255, 255, 255, 0.05); border-radius: 4px; border: 1px solid #363a45;">              
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; border-bottom: 1px dashed #444; padding-bottom: 2px;">
                    <span style="font-size: 0.7em; color: #bbb;">Tendencia Hoy:</span>
                    <b id="txt-current-status" style="font-size: 0.8em; color: #fff;">--</b>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">
                    <span style="font-size: 0.7em; color: #bbb;">Proyección:</span>
                    <b id="txt-consensus" style="font-size: 0.8em; color: #fff;">--</b>
                </div>

                <div style="display: flex; justify-content: right; align-items: center;">
                    <span style="font-size: 0.65em; color: #888; margin-right: 4px;">Tiempo estimado:</span>
                    <b id="txt-reversal" style="font-size: 0.8em; color: #00e676;">-- velas</b>
                </div>
            </div>

            <div class="atr-ohlc">
                O:<span id="val-o">-</span> H:<span id="val-h">-</span> L:<span id="val-l">-</span> C:<span id="val-c">-</span>
            </div>
        </div>
    `;

    // --- Inyección en el DOM ---
    Object.assign(ui.style, {
        position: 'fixed', top: '100px', right: '20px', zIndex: '10000',
        width: '210px', background: 'transparent', userSelect: 'none'
    });

    document.body.appendChild(ui);
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
        const max = Math.max(...mags);
        
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Regresión Lineal: Cálculo de Pendiente (m) e Intercepto (b)
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < N_val; i++) {
            sumX += i; sumY += prices[i];
            sumXY += i * prices[i]; sumX2 += i * i;
        }
        const slope     = (N_val * sumXY - sumX * sumY) / (N_val * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / N_val;

        // 2. Actualización de Labels de Tiempo (Mercado -> Ecuador)
        const optEcu = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' };
        document.getElementById('leg-time').innerText     = new Date(sample[0].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-mkt-last').innerText = new Date(sample[sample.length - 1].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-slope').innerText    = slope.toFixed(4);

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
        let signalTrended    = signalBase.map((val, i) => val + (slope * i) + intercept);
        let signalOnlyCycles = signalBase.map(val => val + intercept);

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

    /* ========================================================================
       7. MONITOR PRINCIPAL (LOOP)
       ======================================================================== */
    /**
     * Genera el HTML de la lista de ciclos con indicadores de tendencia (F).
     */
    const renderListWithHistory = (list, color, isTop, N_val, currentIdx, price, mean) => {
        return list.map((item, i) => {
            const p = N_val / item.k;
            const semiP = p / 2;
            const fValues = [];

            for (let j = 0; j < 4; j++) {
                const idx = currentIdx - j;
                let fVal = Math.ceil(semiP - (idx % semiP));
                if (fVal <= 0) fVal = Math.ceil(semiP);
                fValues.push(fVal);
            }

            const direction = price > mean 
                ? '<span style="color:#ff5252;">▼</span>' 
                : '<span style="color:#00e676;">▲</span>';

            const [v0, v1, v2, v3] = fValues;
            let trendColor = '#ffeb3b';
            if (v0 === v1 && v1 === v2 && v2 === v3) trendColor = '#ffffff';
            else if (v0 > v1 && v1 > v2 && v2 > v3) trendColor = '#00e676';
            else if (v0 < v1 && v1 < v2 && v2 < v3) trendColor = '#ff5252';

            const label = isTop ? `#${i+1}` : `k=${item.k}`;
            return `<div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #222;">
                <span>${label}: <b>${p.toFixed(1)}v</b>${direction} <span style="color:${color}; opacity: 0.8;">(${fValues.join(',')})</span></span>
                <span style="color:${trendColor}; font-size: 8px;">■</span>
            </div>`;
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

        if (candlesHistory.length < N) {
            console.warn(`[ATR] ⚠️ Buffer insuficiente (${candlesHistory.length}/${N}). Esperando más datos...`);
            document.getElementById('fourier-cycle').innerText = `Buffer: ${candlesHistory.length}/${N}`;
            return;
        }

        try {    
            const sample     = candlesHistory.slice(-N); 
            const prices     = sample.map(v => v.c);
            const cleanData  = fourierDetrend(prices);
            const spectrum   = fourierTransform(cleanData);
            const currentIdx = candlesHistory.length;

            // Magnitudes y Ciclo Dominante
            const magnitudes = [];
            for (let k = 1; k < N / 2; k++) {
                magnitudes.push({ k, mag: Math.sqrt(spectrum[k].real ** 2 + spectrum[k].imag ** 2) });
            }

            const topVisible = [...magnitudes].sort((a, b) => b.mag - a.mag).slice(0, visibleCyclesCount);
            const domK = topVisible[0].k; 
            const domP = N / domK;
            const domF = Math.ceil((domP / 2) - (currentIdx % (domP / 2)));

            // --- LÓGICA DE DIAGNÓSTICO (NUEVA) ---
            const meanPrice = prices.reduce((a, b) => a + b) / N;
            const currentPrice = prices[N - 1];
            
            // 1. Determinar Estado ACTUAL (Diagnóstico)
            const isOverbought = currentPrice > meanPrice; // ¿Está caro?
            const currentStatusText = isOverbought ? "ALCISTA (Extendido)" : "BAJISTA (Extendido)";
            const currentStatusColor = isOverbought ? "#00e676" : "#ff5252"; // Verde si sube, Rojo si baja
            
            // 2. Determinar PROYECCIÓN (Reversión a la media)
            // Calculamos confianza basada en cuántos armónicos coinciden
            const upCycles = topVisible.filter(item => currentPrice <= meanPrice).length;
            const downCycles = topVisible.length - upCycles;
            
            let projectionText = "NEUTRAL";
            let projectionColor = "#ffeb3b";
            let confidence = 0;

            if (isOverbought) {
                // Si está caro, la proyección es BAJAR
                confidence = Math.round((downCycles / topVisible.length) * 100);
                projectionText = `▼ REVERSIÓN (${confidence}%)`;
                projectionColor = "#ff5252"; // Rojo (Short)
            } else {
                // Si está barato, la proyección es SUBIR
                confidence = Math.round((upCycles / topVisible.length) * 100);
                projectionText = `▲ REVERSIÓN (${confidence}%)`;
                projectionColor = "#00e676"; // Verde (Long)
            }

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
                reversalEl.innerText = `en ~${domF} velas`;
                reversalEl.style.color = (domF <= 3) ? "#ffeb3b" : "#fff"; 
            }
            
            // Actualizar resto de datos
            document.getElementById('f-samples').innerText = candlesHistory.length;
            document.getElementById('f-tf').innerText      = timeframe.toUpperCase();
            document.getElementById('fourier-cycle').innerText = `Ciclo Dom: ${domP.toFixed(1)}v`; // Quitamos F de aquí para limpiar
            document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(topVisible, '#4fc3f7', true, N, currentIdx, prices[N-1], prices.reduce((a,b)=>a+b)/N);
            
            const atrValue = calculateATR(candlesHistory, 14);
            const valAtrEl = document.getElementById('val-atr');
            if (valAtrEl) valAtrEl.innerText = atrValue.toFixed((currentSymbol === 'SILVER' || currentSymbol === 'XAGUSD') ? 4 : 2);
            
            fourierDraw(magnitudes.map(m => m.mag), domK - 1);
            reconstructionDraw(spectrum, topVisible, N, sample);
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

            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            
            const dataRange = (timeframe === '1m') ? '1d' : '5d'; 
            candlesHistory = await fetchHistory(ySymbol, yInterval, dataRange);
            if (candlesHistory.length > 0) lastBarTime = candlesHistory[candlesHistory.length - 1].t * 1000;
            
            isSyncing = false;
            performCalculations(timeframe, symbol); // <--- AHORA PASAMOS EL SÍMBOLO
            return;
        }

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
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            const now = Date.now();
            const msMap = { '1m': 60000, '5m': 300000, '1h': 3600000 };
            const barDuration = msMap[timeframe] || 60000;
            const currentBarTime = Math.floor(now / barDuration) * barDuration;

            if (currentBarTime > lastBarTime) {
                candlesHistory.push({ t: Math.floor(now / 1000), h: data.High, l: data.Low, c: data.Close });
                if (candlesHistory.length > 500) candlesHistory.shift();
                lastBarTime = currentBarTime;
            }
            performCalculations(timeframe, symbol);
        }
    }; 

    // --- Lógica de Arrastre (Drag & Drop) ---
    const header = ui.querySelector('.atr-header-row');
    let isDragging = false;
    let offsetX, offsetY;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        // Calculamos el desfase inicial
        offsetX = e.clientX - ui.getBoundingClientRect().left;
        offsetY = e.clientY - ui.getBoundingClientRect().top;
        ui.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        // Posicionamos el plugin respecto al mouse
        ui.style.left = (e.clientX - offsetX) + 'px';
        ui.style.top = (e.clientY - offsetY) + 'px';
        ui.style.right = 'auto'; // Anulamos el 'right' inicial de inyección
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        ui.style.cursor = 'default';
    });

    // --- Listeners de Eventos (UI) ---
    document.getElementById('atr-min-btn').addEventListener('click', () => {
        const body = document.getElementById('atr-content-body');
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        document.getElementById('atr-min-btn').innerText = isHidden ? '_' : '▢';
        localStorage.setItem('atr-plugin-minimized', !isHidden);
    });

    document.getElementById('k-plus').addEventListener('click', () => {
        if (visibleCyclesCount < 15) { 
            visibleCyclesCount++;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            const { symbol } = getMetadata();
            performCalculations(lastTimeframe, symbol); // <--- Llamada 3: Añadir symbol
        }
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

    const btnRefresh = document.getElementById('atr-refresh-btn');
    btnRefresh.addEventListener('click', async () => {
        console.log("[ATR] 🖱️ Usuario solicitó actualización manual.");
        if (isSyncing) return; // Evitar doble clic
        
        // Feedback visual (Animación)
        btnRefresh.classList.add('spinning'); 
        
        // Truco clínico: Borramos el 'lastSymbol' para engañar a la función monitor
        // y obligarla a pensar que es un activo nuevo, forzando la descarga.
        lastSymbol = null; 
        candlesHistory = [];
        
        await monitor(); // Ejecutamos la carga manualmente
        
        btnRefresh.classList.remove('spinning'); // Quitamos animación
    });

    // Lanzamiento
    setInterval(monitor, 60000);
})();