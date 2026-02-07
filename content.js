(async () => {
    /* ========================================================================
       1. VARIABLES GLOBALES DE ESTADO
       ======================================================================== */
    let candlesHistory = []; 
    let lastClose = null;    
    let lastTimeframe = null;
    let lastSymbol = null;   
    let lastBarTime = 0; 
    const N = 128; // Tamaño del buffer para Fourier

    /* ========================================================================
       2. UTILIDADES Y MAPEO DE DATOS
       ======================================================================== */
    const getMetadata = () => {
        const symbol = window.location.pathname.split('/')[2]?.toUpperCase();
        const timeframeEl = document.querySelector('et-select-header.ets-chip-period');
        const timeframe = timeframeEl ? timeframeEl.innerText.trim().toLowerCase() : '1d';
        return { symbol, timeframe };
    };

    const mapToYahoo = (symbol, timeframe) => {
        const symbolMap = { 
            'GOLD': 'GC=F', 'SILVER': 'SI=F', 'PLATINUM': 'PL=F',
            'COPPER': 'HG=F', 'BTC': 'BTC-USD', 'ETH': 'ETH-USD' 
        };
        const intervalMap = { 
            '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', 
            '1h': '60m', '4h': '240m', '1d': '1d', '1w': '1wk' 
        };
        return { 
            ySymbol: symbolMap[symbol] || symbol, 
            yInterval: intervalMap[timeframe] || '1d' 
        };
    };

    /* ========================================================================
       3. COMUNICACIÓN CON API (YAHOO FINANCE)
       ======================================================================== */
    const fetchHistory = async (ySymbol, yInterval, range = '10d') => {
        const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=${range}`;
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        
        console.log(`[ATR Assistant] Solicitando datos: ${ySymbol} (${yInterval}) en rango ${range}...`);
        
        try {
            const res = await fetch(proxyUrl);
            const wrapper = await res.json();
            if (!wrapper.contents) throw new Error("Sin respuesta del proxy AllOrigins");
            
            const json = JSON.parse(wrapper.contents);
            if (!json.chart.result) throw new Error("Yahoo no devolvió resultados para este activo/TF");

            const quotes = json.chart.result[0].indicators.quote[0];
            const timestamps = json.chart.result[0].timestamp || [];
            
            const history = timestamps.map((t, i) => ({
                h: quotes.high[i], l: quotes.low[i], c: quotes.close[i]
            })).filter(v => v.c !== null && v.h !== null && v.l !== null);

            console.info(`[ATR Assistant] Datos recibidos: ${history.length} velas.`);
            return history;
        } catch (e) { 
            console.error("[ATR Assistant] Error en fetchHistory:", e.message);
            return []; 
        }
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
            
            <div style="font-size: 0.65em; color: #787b86; margin-bottom: 5px; text-align: center; border-bottom: 1px solid #333; padding-bottom: 3px;">
                F: (Actual, -1v, -2v, -3v)
            </div>

            <div id="fourier-top-list" style="font-size: 0.72em; color: #4fc3f7; display: grid; grid-template-columns: 1fr; gap: 2px; max-height: 80px; overflow-y: auto;"></div>
            
            <div style="font-size: 0.7em; color: #aaa; margin-top: 8px; border-top: 1px solid #333; padding-top: 5px;">Ciclos Largos:</div>
            <div id="fourier-first-list" style="font-size: 0.72em; color: #ffb74d; display: grid; grid-template-columns: 1fr; gap: 2px;"></div>

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
    const monitor = async () => {
        const { symbol, timeframe } = getMetadata();
        if (!symbol) return;

        // Gestión de sincronización por cambio de activo o TF
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            console.warn(`[ATR Assistant] Cambio detectado: ${lastSymbol}->${symbol} | ${lastTimeframe}->${timeframe}`);
            
            lastTimeframe = timeframe; 
            lastSymbol = symbol;
            lastBarTime = 0; 
            candlesHistory = []; // Limpiamos para evitar mezclar datos de activos distintos
            
            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            document.getElementById('fourier-cycle').innerText = "Sincronizando...";

            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            
            // Ajustamos el rango para asegurar que Yahoo devuelva al menos N (128) velas
            let dynamicRange = '10d';
            if (timeframe === '1m') dynamicRange = '5d';
            else if (timeframe === '5m') dynamicRange = '10d';
            else if (timeframe === '15m' || timeframe === '30m') dynamicRange = '20d';
            else if (timeframe === '1h' || timeframe === '60m') dynamicRange = '30d';
            else dynamicRange = '60d';

            const fetched = await fetchHistory(ySymbol, yInterval, dynamicRange);
            
            if (fetched.length < N) {
                console.error(`[ATR Assistant] ATENCIÓN: Yahoo solo devolvió ${fetched.length} velas. Se requieren ${N} para Fourier. El plugin "colgará" hasta completar el buffer.`);
            }
            
            candlesHistory = fetched;
        }

        // Extracción de datos OHLC de eToro
        let data = {};
        const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(d => d)];
        docs.forEach(doc => {
            doc.querySelectorAll('[class*="valueItem-"]').forEach(item => {
                const label = item.querySelector('[class*="valueTitle-"]')?.innerText.trim();
                const val = parseFloat(item.querySelector('[class*="valueValue-"]')?.innerText.trim().replace(/,/g, ''));
                if (label === 'O') data.Open = val; 
                if (label === 'H') data.High = val;
                if (label === 'L') data.Low = val; 
                if (label === 'C') data.Close = val;
            });
        });

        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            
            const msMap = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 };
            const barDuration = msMap[timeframe] || 60000;
            const currentBarTime = Math.floor(Date.now() / barDuration) * barDuration;

            if (currentBarTime > lastBarTime) {
                candlesHistory.push({ h: data.High, l: data.Low, c: data.Close });
                if (candlesHistory.length > 500) candlesHistory.shift();
                lastBarTime = currentBarTime;
            }

            // Actualizar etiquetas UI
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            if (candlesHistory.length >= N) {
                const prices = candlesHistory.slice(-N).map(v => v.c);
                const cleanData = fourierDetrend(prices);
                const spectrum = fourierTransform(cleanData);
                
                const currentPrice = prices[prices.length - 1];
                const sampleMean = prices.reduce((a, b) => a + b, 0) / N;

                const magnitudes = [];
                for (let k = 1; k < N / 2; k++) {
                    const mag = Math.sqrt(spectrum[k].real ** 2 + spectrum[k].imag ** 2);
                    magnitudes.push({ k, mag });
                }

                const top6 = [...magnitudes].sort((a, b) => b.mag - a.mag).slice(0, 6);
                const first6 = magnitudes.slice(0, 6);
                const currentIdx = candlesHistory.length;

                document.getElementById('f-samples').innerText = candlesHistory.length;
                document.getElementById('f-tf').innerText = timeframe.toUpperCase();
                
                const domK = top6[0].k;
                const domP = N / domK;
                const domF = Math.ceil((domP / 2) - (currentIdx % (domP / 2)));
                document.getElementById('fourier-cycle').innerText = `Ciclo Dom: ${domP.toFixed(1)}v (F: ${domF}v)`;

                document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(top6, '#4fc3f7', true, N, currentIdx, currentPrice, sampleMean);
                document.getElementById('fourier-first-list').innerHTML = renderListWithHistory(first6, '#ffb74d', false, N, currentIdx, currentPrice, sampleMean);
                
                fourierDraw(magnitudes.map(m => m.mag), domK - 1);
            } else {
                document.getElementById('fourier-cycle').innerText = `Buffer: ${candlesHistory.length}/${N}`;
            }
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

    // Ejecución inicial y loop
    setInterval(monitor, 2000);
})();