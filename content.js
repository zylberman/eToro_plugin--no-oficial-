(async () => {
    /* ========================================================================
       1. VARIABLES GLOBALES DE ESTADO
       ======================================================================== */
    let candlesHistory = []; 
    let lastClose = null;    
    let lastTimeframe = null;
    let lastSymbol = null;   
    let lastBarTime = 0; 
    let lastCalcTime = 0;    // <--- NUEVA: Para controlar el intervalo de cálculo (30s/1m)
    let isSyncing = false;   // <--- NUEVA: Para evitar múltiples descargas simultáneas
    let visibleCyclesCount = 1; // <--- NUEVA: Controla cuántos ciclos mostrar (inicia en 1)
    const N = 128;
  

    /* ========================================================================
       2. UTILIDADES Y MAPEO DE DATOS
       ======================================================================== */
    const getMetadata = () => {
        const symbol = window.location.pathname.split('/')[2]?.toUpperCase();
        const timeframeEl = document.querySelector('et-select-header.ets-chip-period');
        // Limpiamos el texto: quitamos espacios y pasamos a minúsculas
        let timeframe = timeframeEl ? timeframeEl.innerText.replace(/\s+/g, '').toLowerCase() : '1d';
        
        // Normalización para eToro (ej: "1min" -> "1m", "1h" -> "1h")
        if (timeframe.includes('min')) timeframe = timeframe.replace('min', 'm');
        console.log(`[DEBUG] Metadata detectada - Symbol: ${symbol}, TF: "${timeframe}"`);
        return { symbol, timeframe };
    };

    const mapToYahoo = (symbol, timeframe) => {
        const symbolMap = { 
            'GOLD': 'GC=F', 'SILVER': 'SI=F', 'PLATINUM': 'PL=F',
            'COPPER': 'HG=F', 'BTC': 'BTC-USD', 'ETH': 'ETH-USD' 
        };
        const intervalMap = { 
            '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', 
            '60m': '60m', '1h': '1h', '4h': '1h', '1d': '1d', '1w': '1wk' 
        };
        
        // CORRECCIÓN: Definir las variables antes de usarlas en el console.log
        const ySymbol = symbolMap[symbol] || symbol;
        let yInterval = intervalMap[timeframe];
        
        if (!yInterval) {
            yInterval = timeframe.includes('m') ? '5m' : '1d';
        }

        console.log(`[DEBUG] Mapeo Yahoo - ySymbol: ${ySymbol}, yInterval: ${yInterval}`);

        return { ySymbol, yInterval };
    };

    /* ========================================================================
       3. COMUNICACIÓN CON API (YAHOO FINANCE)
       ======================================================================== */
    const fetchHistory = async (ySymbol, yInterval, range = '5d') => {
        const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=${range}`;
        
        const proxyConfigs = [
            { url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, type: 'wrapped' },
            { url: `https://thingproxy.freeboard.io/fetch/${targetUrl}`, type: 'direct' },
            { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, type: 'direct' }
        ];

        console.log(`[ATR Assistant] Descargando: ${ySymbol} (${yInterval})...`);

        for (const config of proxyConfigs) {
            try {
                const res = await fetch(config.url);
                if (!res.ok) continue;

                let json;
                const body = await res.json();
                json = (config.type === 'wrapped') ? JSON.parse(body.contents) : body;

                if (json.chart && json.chart.result) {
                    const resData = json.chart.result[0];
                    const quotes = resData.indicators.quote[0];
                    const ts = resData.timestamp || [];
                    
                    console.log(`[DEBUG] Proxy ${config.url.split('/')[2]} - Velas: ${ts.length}`);

                    const history = ts.map((t, i) => ({
                        t: t, // <--- GUARDAMOS EL TIMESTAMP
                        h: quotes.high[i], l: quotes.low[i], c: quotes.close[i]
                    })).filter(v => v.c !== null && v.h !== null);

                    if (history.length > 0) return history;
                }
            } catch (e) {
                console.warn(`[DEBUG] Fallo proxy ${config.url.split('/')[2]}: ${e.message}`);
                continue;
            }
        }
        return [];
    };

    /* ========================================================================
       4. LÓGICA MATEMÁTICA (FOURIER & FFT)
       ======================================================================== */
    function fourierDetrend(data) {
        const n = data.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < n; i++) {
            sumX += i; sumY += data[i];
            sumXY += i * data[i]; sumX2 += i * i;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        return data.map((y, x) => y - (slope * x + intercept));
    }

    function fourierTransform(input) {
        const n = input.length;
        if (n <= 1) return input.map(v => ({ real: v, imag: 0 }));
        const even = fourierTransform(input.filter((_, i) => i % 2 === 0));
        const odd = fourierTransform(input.filter((_, i) => i % 2 !== 0));
        const output = new Array(n);
        for (let k = 0; k < n / 2; k++) {
            const angle = -2 * Math.PI * k / n;
            const t = {
                real: Math.cos(angle) * odd[k].real - Math.sin(angle) * odd[k].imag,
                imag: Math.cos(angle) * odd[k].imag + Math.sin(angle) * odd[k].real
            };
            output[k] = { real: even[k].real + t.real, imag: even[k].imag + t.imag };
            output[k + n / 2] = { real: even[k].real - t.real, imag: even[k].imag - t.imag };
        }
        return output;
    }

    /* ========================================================================
       5. CONSTRUCCIÓN DE LA INTERFAZ (UI)
       ======================================================================== */
    const ui = document.createElement('div');
    ui.id = 'etoro-atr-plugin';

    const savedInv = localStorage.getItem('atr-plugin-inv') || "1000";
    const savedLev = localStorage.getItem('atr-plugin-lev') || "1";
    const isMinimized = localStorage.getItem('atr-plugin-minimized') === 'true';
    
    ui.innerHTML = `
        <div class="atr-header-row" style="cursor: move; background: #2a2e39; padding: 8px; display: flex; justify-content: space-between; align-items: center; border-radius: 8px 8px 0 0;">
            <div class="atr-header" style="font-weight: bold; font-size: 11px; color: #fff; pointer-events:none;">ATR(14) Assistant</div>
            <button id="atr-min-btn" style="background: none; border: none; color: #fff; cursor: pointer; font-size: 14px; padding: 0 5px;">${isMinimized ? '▢' : '_'}</button>
        </div>
        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : 'display: block;'} background: #131722; padding: 10px; border-radius: 0 0 8px 8px; border: 1px solid #2a2e39;">
            <div id="atr-status" style="color: #00e676; font-size: 11px; margin-bottom: 8px;">Iniciando...</div>
            <div class="input-row" style="display: flex; gap: 5px; margin-bottom: 10px;">
                <div class="inv-group">
                    <label style="display: block; font-size: 9px; color: #aaa;">Inversión ($):</label>
                    <input type="number" id="inv-amount" value="${savedInv}" step="100" style="width: 65px; background: #2a2e39; border: 1px solid #333; color: #fff; font-size: 11px; padding: 2px;">
                </div>
                <div class="lev-group">
                    <label style="display: block; font-size: 9px; color: #aaa;">Leverage:</label>
                    <input type="number" id="lev-amount" value="${savedLev}" min="1" style="width: 40px; background: #2a2e39; border: 1px solid #333; color: #fff; font-size: 11px; padding: 2px;">
                </div>
            </div>
            
            <div id="fourier-metadata" style="font-size: 0.72em; color: #aaa; margin-top: 5px; border-top: 1px solid #333; padding-top: 5px;">
                Muestra: <span id="f-samples">--</span> velas | TF: <span id="f-tf">--</span>
            </div>
            <div id="fourier-cycle" style="color: #00e676; font-weight: bold; margin: 3px 0; font-size: 0.85em;">Cargando...</div>
            <canvas id="fourier-canvas" width="200" height="40" style="width: 100%; height: 40px; background: #000; border-radius: 4px; margin-bottom: 5px;"></canvas>
            
            <div style="font-size: 0.65em; color: #aaa; margin-bottom: 2px;">Reconstrucción (Azul: Ciclos | Roja: +Pendiente):</div>
            <div id="recon-legend" style="display: grid; grid-template-columns: 1fr 1fr; gap: 2px; font-size: 0.62em; color: #aaa; margin-bottom: 4px; font-family: monospace; line-height: 1.2;">
                <span>Análisis Start: <b id="leg-time" style="color:#fff;">--:--</b></span>
                <span style="text-align: right;">Mkt Last (Ecu): <b id="leg-mkt-last" style="color:#fff;">--:--</b></span>
                <span>Pendiente m: <b id="leg-slope" style="color:#ff5252;">0.0000</b></span>
            </div>
            <canvas id="reconstruction-canvas" width="200" height="40" style="width: 100%; height: 40px; background: #000; border-radius: 4px; margin-bottom: 8px; border: 1px solid #2a2e39;"></canvas>
            <div style="font-size: 0.65em; color: #787b86; margin-bottom: 5px; text-align: center; border-bottom: 1px solid #333; padding-bottom: 3px;">
                F: (Actual, -1v, -2v, -3v)
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; border-bottom: 1px solid #333; padding-bottom: 3px;">
                <span style="font-size: 0.7em; color: #aaa;">Top Ciclos:</span>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; border-bottom: 1px solid #333; padding-bottom: 3px;">
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <span style="font-size: 0.7em; color: #aaa;">Top Ciclos:</span>
                        <label style="font-size: 0.7em; color: #00e676; display: flex; align-items: center; gap: 3px; cursor: pointer;">
                            <input type="checkbox" id="chk-show-price" checked style="width: 10px; height: 10px; margin: 0;"> Real
                        </label>
                    </div>
                    <div style="display: flex; gap: 5px; align-items: center;">
                        <button id="k-minus" style="background: #2a2e39; border: 1px solid #444; color: #fff; cursor: pointer; padding: 0 6px; font-size: 10px; border-radius: 3px;">-</button>
                        <span id="k-count-label" style="font-size: 10px; color: #4fc3f7; min-width: 10px; text-align: center;">1</span>
                        <button id="k-plus" style="background: #2a2e39; border: 1px solid #444; color: #fff; cursor: pointer; padding: 0 6px; font-size: 10px; border-radius: 3px;">+</button>
                    </div>
                </div>
            </div>
            <div id="fourier-top-list" style="font-size: 0.72em; color: #4fc3f7; display: grid; grid-template-columns: 1fr; gap: 2px; max-height: 120px; overflow-y: auto;"></div>

            <div class="atr-ohlc" style="margin-top: 8px; font-size: 9px; color: #888; font-family: monospace; border-top: 1px solid #333; padding-top: 5px;">
                O:<span id="val-o">-</span> H:<span id="val-h">-</span> L:<span id="val-l">-</span> C:<span id="val-c">-</span>
            </div>
        </div>
    `;

    Object.assign(ui.style, {
        position: 'fixed', top: '100px', right: '20px', zIndex: '10000',
        width: '210px', background: 'transparent', userSelect: 'none'
    });

    document.body.appendChild(ui);

    /* ========================================================================
       6. RENDERIZADO Y DIBUJO
       ======================================================================== */
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

    function reconstructionDraw(spectrum, selectedK, N_val, sample) {
        const canvas = document.getElementById('reconstruction-canvas');
        const showPrice = document.getElementById('chk-show-price')?.checked;
        if (!canvas || !sample || sample.length < N_val) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const prices = sample.map(v => v.c);

        // 1. Regresión Lineal Completa (Pendiente m e Intercepto b)
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        for (let i = 0; i < N_val; i++) {
            sumX += i; sumY += prices[i];
            sumXY += i * prices[i]; sumX2 += i * i;
        }
        const slope = (N_val * sumXY - sumX * sumY) / (N_val * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / N_val; // <--- EL FIX: Calculamos la base del precio

        // 2. Tiempos (Mercado -> Ecuador)
        const optEcu = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' };
        document.getElementById('leg-time').innerText = new Date(sample[0].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-mkt-last').innerText = new Date(sample[sample.length - 1].t * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-slope').innerText = slope.toFixed(4);

        // 3. Reconstrucción de la señal
        let signalBase = new Array(N_val).fill(0);
        selectedK.forEach(item => {
            const comp = spectrum[item.k];
            for (let i = 0; i < N_val; i++) {
                const angle = (2 * Math.PI * item.k * i) / N_val;
                // Sumamos los componentes armónicos
                signalBase[i] += (comp.real * Math.cos(angle) - comp.imag * Math.sin(angle)) / (N_val / 2);
            }
        });

        // 4. Mapeo a la escala real del precio
        // Línea Roja = Ciclos + Tendencia + Intercepto (Debe seguir al precio casi exacto)
        let signalTrended = signalBase.map((val, i) => val + (slope * i) + intercept);
        
        // Línea Azul = Ciclos + Intercepto (Para ver la oscilación sobre el precio inicial)
        let signalOnlyCycles = signalBase.map(val => val + intercept);

        // 5. Normalización Global del Canvas
        const dataToScale = [...prices, ...signalTrended];
        const gMin = Math.min(...dataToScale), gMax = Math.max(...dataToScale), gRange = gMax - gMin || 1;

        const drawLine = (data, color, width = 1.5) => {
            ctx.beginPath(); 
            ctx.strokeStyle = color; 
            ctx.lineWidth = width;
            for (let i = 0; i < N_val; i++) {
                const x = (i / (N_val - 1)) * canvas.width;
                const y = canvas.height - ((data[i] - gMin) / gRange) * canvas.height;
                (i === 0) ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        // DIBUJAR
        if (showPrice) drawLine(prices, '#00e676', 1);        // Verde: Realidad
        drawLine(signalOnlyCycles, '#4fc3f7', 1);            // Azul: Solo ciclos
        drawLine(signalTrended, '#ff5252', 1.5);             // Roja: Reconstrucción total (Predicción)
    }

    const renderListWithHistory = (list, color, isTop, N_val, currentIdx, price, mean) => list.map((item, i) => {
        const p = N_val / item.k;
        const semiP = p / 2;
        const fValues = [];

        for (let j = 0; j < 4; j++) {
            const idx = currentIdx - j;
            let fVal = Math.ceil(semiP - (idx % semiP));
            if (fVal <= 0) fVal = Math.ceil(semiP);
            fValues.push(fVal);
        }

        const direction = price > mean ? 
            '<span style="color:#ff5252;">▼</span>' : '<span style="color:#00e676;">▲</span>';

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

    /* ========================================================================
       7. MONITOR PRINCIPAL (LOOP)
       ======================================================================== */
    const performCalculations = (timeframe) => {
        // SEGURIDAD: Si los elementos de la UI no existen aún, abortamos
        const legTime = document.getElementById('leg-time');
        const legMkt = document.getElementById('leg-mkt-last');
        if (!legTime || !legMkt || candlesHistory.length === 0) return;

        // 1. CÁLCULO DE TIEMPOS (Mercado -> Ecuador)
        const msMap = { '1m': 60, '2m': 120, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600 };
        const stepSeconds = msMap[timeframe] || 60;
        
        const lastMktTime = candlesHistory[candlesHistory.length - 1].t;
        const startMktTime = lastMktTime - (N * stepSeconds);

        const optEcu = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Guayaquil' };
        
        legTime.innerText = new Date(startMktTime * 1000).toLocaleTimeString('en-GB', optEcu);
        legMkt.innerText = new Date(lastMktTime * 1000).toLocaleTimeString('en-GB', optEcu);
        
        // CORRECCIÓN: Usar 'leg-mkt-last' para que coincida con tu HTML
        document.getElementById('leg-time').innerText = new Date(startMktTime * 1000).toLocaleTimeString('en-GB', optEcu);
        document.getElementById('leg-mkt-last').innerText = new Date(lastMktTime * 1000).toLocaleTimeString('en-GB', optEcu);

        // 2. BLOQUEO TÉCNICO (N=128)
        if (candlesHistory.length < N) {
            document.getElementById('fourier-cycle').innerText = `Buffer: ${candlesHistory.length}/${N}`;
            return;
        }
        
        const sample = candlesHistory.slice(-N); 
        const prices = sample.map(v => v.c);
        const cleanData = fourierDetrend(prices);
        const spectrum = fourierTransform(cleanData);
        
        const currentPrice = prices[prices.length - 1];
        const sampleMean = prices.reduce((a, b) => a + b, 0) / N;

        const magnitudes = [];
        for (let k = 1; k < N / 2; k++) {
            magnitudes.push({ k, mag: Math.sqrt(spectrum[k].real ** 2 + spectrum[k].imag ** 2) });
        }

        const topVisible = [...magnitudes].sort((a, b) => b.mag - a.mag).slice(0, visibleCyclesCount);
        const currentIdx = candlesHistory.length;

        const domK = topVisible[0].k; 
        const domP = N / domK;
        const domF = Math.ceil((domP / 2) - (currentIdx % (domP / 2)));
        
        document.getElementById('f-samples').innerText = candlesHistory.length;
        document.getElementById('f-tf').innerText = timeframe.toUpperCase();
        document.getElementById('fourier-cycle').innerText = `Ciclo Dom: ${domP.toFixed(1)}v (F: ${domF}v)`;

        document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(topVisible, '#4fc3f7', true, N, currentIdx, currentPrice, sampleMean);
        
        fourierDraw(magnitudes.map(m => m.mag), domK - 1);
        reconstructionDraw(spectrum, topVisible, N, sample);
        
        lastCalcTime = Date.now();
    };
    
    const monitor = async () => {
        if (isSyncing) return;
        const { symbol, timeframe } = getMetadata();
        if (!symbol) return;

        // --- A. GESTIÓN DE DESCARGA (Cambio de Activo/TF) ---
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            isSyncing = true;
            candlesHistory = []; lastBarTime = 0; lastClose = null;
            lastTimeframe = timeframe; lastSymbol = symbol;

            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            
            // CAMBIO CRÍTICO: Forzar siempre 5 días para evitar buffers vacíos
            const range = '5d'; 
            
            candlesHistory = await fetchHistory(ySymbol, yInterval, range);
            if (candlesHistory.length > 0) {
                lastBarTime = candlesHistory[candlesHistory.length - 1].t * 1000;
            }
            isSyncing = false;
            performCalculations(timeframe); 
            return;
        }

        // --- B. EXTRACCIÓN DE PRECIO Y VALORES OHLC DEL DOM ---
        let data = {};
        const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(d => d)];
        
        docs.forEach(doc => {
            doc.querySelectorAll('[class*="valueItem-"]').forEach(item => {
                const label = item.querySelector('[class*="valueTitle-"]')?.innerText.trim();
                const valText = item.querySelector('[class*="valueValue-"]')?.innerText.trim().replace(/,/g, '');
                const val = parseFloat(valText);
                if (label === 'O') data.Open = val; 
                if (label === 'H') data.High = val;
                if (label === 'L') data.Low = val; 
                if (label === 'C') data.Close = val;
            });
        });

        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            
            // ACTUALIZAR ETIQUETAS OHLC EN LA INTERFAZ
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            const now = Date.now();
            const msMap = { '1m': 60000, '2m': 120000, '5m': 300000, '10m': 600000, '15m': 900000, '30m': 1800000, '1h': 3600000 };
            const barDuration = msMap[timeframe] || 60000;
            const currentBarTime = Math.floor(now / barDuration) * barDuration;

            if (currentBarTime > lastBarTime) {
                // Guardamos la nueva vela con timestamp UTC del sistema (que Yahoo interpreta correctamente)
                candlesHistory.push({ t: Math.floor(now / 1000), h: data.High, l: data.Low, c: data.Close });
                if (candlesHistory.length > 500) candlesHistory.shift();
                lastBarTime = currentBarTime;
            }
            performCalculations(timeframe);
        }
    }; 

    /* ========================================================================
       8. LÓGICA DE INTERACCIÓN Y EVENTOS
       ======================================================================== */
    const minBtn = document.getElementById('atr-min-btn');
    const contentBody = document.getElementById('atr-content-body');
    const header = ui.querySelector('.atr-header-row');

    let isDragging = false;
    let offsetX, offsetY;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        offsetX = e.clientX - ui.getBoundingClientRect().left;
        offsetY = e.clientY - ui.getBoundingClientRect().top;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        ui.style.left = (e.clientX - offsetX) + 'px';
        ui.style.top = (e.clientY - offsetY) + 'px';
        ui.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => isDragging = false);

    minBtn.addEventListener('click', () => {
        const currentlyHidden = contentBody.style.display === 'none';
        contentBody.style.display = currentlyHidden ? 'block' : 'none';
        minBtn.innerText = currentlyHidden ? '_' : '▢';
        localStorage.setItem('atr-plugin-minimized', !currentlyHidden);
    });

    document.getElementById('inv-amount').addEventListener('input', (e) => localStorage.setItem('atr-plugin-inv', e.target.value));
    document.getElementById('lev-amount').addEventListener('input', (e) => localStorage.setItem('atr-plugin-lev', e.target.value));

    document.getElementById('k-plus').addEventListener('click', () => {
        if (visibleCyclesCount < 15) { // Límite máximo de 15 para no romper la UI
            visibleCyclesCount++;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            performCalculations(lastTimeframe);
        }
    });

    document.getElementById('k-minus').addEventListener('click', () => {
        if (visibleCyclesCount > 1) { // Mínimo 1
            visibleCyclesCount--;
            document.getElementById('k-count-label').innerText = visibleCyclesCount;
            performCalculations(lastTimeframe);
        }
    });

    document.getElementById('chk-show-price').addEventListener('change', () => {
            performCalculations(lastTimeframe); 
        });

    // Ejecución inicial y loop
    setInterval(monitor, 2000);
})();