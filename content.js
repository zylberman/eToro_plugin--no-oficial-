(async () => {
    /* --- 1. VARIABLES GLOBALES DE ESTADO --- */
    let candlesHistory = []; // Almacena las velas históricas obtenidas de Yahoo
    let lastClose = null;    // Rastrea el último precio para evitar cálculos innecesarios
    let lastTimeframe = null;// Detecta si el usuario cambia la temporalidad (1m, 5m, etc.)
    let lastSymbol = null;   // Detecta si el usuario cambia de activo (Oro, Bitcoin, etc.)

    /* --- 2. CONSTRUCCIÓN DE LA INTERFAZ (UI) --- */
    const ui = document.createElement('div');
    ui.id = 'etoro-atr-plugin';

    // Recuperamos preferencias guardadas en el navegador para no perderlas al refrescar
    const savedInv = localStorage.getItem('atr-plugin-inv') || "1000";
    const savedLev = localStorage.getItem('atr-plugin-lev') || "1";
    const isMinimized = localStorage.getItem('atr-plugin-minimized') === 'true';
    
    // Inyección del HTML: Estructura de cabecera, inputs de riesgo y panel de datos
    ui.innerHTML = `
        <div class="atr-header-row">
            <div class="atr-header">ATR(14) Assistant</div>
            <button id="atr-min-btn">${isMinimized ? '▢' : '_'}</button>
        </div>
        <div id="atr-content-body" style="${isMinimized ? 'display: none;' : ''}">
            <div id="atr-status">Sincronizando...</div>
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
            <div id="atr-value">--</div>
            <div id="atr-cash-value">--</div>
            
            <div id="fourier-metadata" style="font-size: 0.75em; color: #aaa; margin-top: 10px; border-top: 1px solid #333; pt: 5px;">
                Muestra: <span id="f-samples">--</span> velas | TF: <span id="f-tf">--</span>
            </div>
            <div id="fourier-cycle" style="color: #00e676; font-weight: bold; margin: 3px 0; font-size: 0.9em;">Ciclo Dom: --</div>
            <canvas id="fourier-canvas" style="width: 100%; height: 50px; background: #000; border-radius: 4px;"></canvas>
            
            <div style="font-size: 0.65em; color: #787b86; margin-top: 5px; text-align: center; border-bottom: 1px solid #333; padding-bottom: 3px;">
                F: (Actual, -1v, -2v, -3v)
            </div>

            <div style="font-size: 0.7em; color: #aaa; margin-top: 5px;">Top 6 Potencia (Fuerza):</div>
            <div id="fourier-top-list" style="font-size: 0.75em; color: #4fc3f7; display: grid; grid-template-columns: 1fr 1fr; gap: 2px;"></div>
            
            <div style="font-size: 0.7em; color: #aaa; margin-top: 5px;">Primeras 6 (Ciclos Largos):</div>
            <div id="fourier-first-list" style="font-size: 0.75em; color: #ffb74d; display: grid; grid-template-columns: 1fr 1fr; gap: 2px;"></div>

            <div class="atr-ohlc" style="margin-top: 10px;">
                O: <span id="val-o">-</span> H: <span id="val-h">-</span><br>
                L: <span id="val-l">-</span> C: <span id="val-c">-</span>
            </div>
        </div>
    `;
    document.body.appendChild(ui);

    /* --- 3. LÓGICA DE INTERACCIÓN (EVENTOS) --- */
    const minBtn = document.getElementById('atr-min-btn');
    const contentBody = document.getElementById('atr-content-body');
    /* --- LÓGICA DE ARRASTRE (DRAG & DROP) --- */
    let isDragging = false;
    let offsetX, offsetY;

    const header = ui.querySelector('.atr-header-row');

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        // Calculamos la posición inicial del clic respecto a la esquina del plugin
        offsetX = e.clientX - ui.getBoundingClientRect().left;
        offsetY = e.clientY - ui.getBoundingClientRect().top;
        ui.style.transition = 'none'; // Desactivamos transiciones para fluidez
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        // Calculamos la nueva posición
        let x = e.clientX - offsetX;
        let y = e.clientY - offsetY;
        
        // Aplicamos los nuevos valores al estilo
        ui.style.left = x + 'px';
        ui.style.top = y + 'px';
        ui.style.right = 'auto'; // Desactivamos el "right" original para permitir el libre movimiento
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        ui.style.transition = 'border-color 0.3s'; // Restauramos efectos visuales
    });

    // Maneja el colapso/expansión del panel
    minBtn.addEventListener('click', () => {
        const currentlyHidden = contentBody.style.display === 'none';
        contentBody.style.display = currentlyHidden ? 'block' : 'none';
        minBtn.innerText = currentlyHidden ? '_' : '▢';
        localStorage.setItem('atr-plugin-minimized', !currentlyHidden);
    });

    // Guarda los valores de inversión y apalancamiento automáticamente al escribir
    document.getElementById('inv-amount').addEventListener('input', (e) => localStorage.setItem('atr-plugin-inv', e.target.value));
    document.getElementById('lev-amount').addEventListener('input', (e) => localStorage.setItem('atr-plugin-lev', e.target.value));

    /* --- 4. EXTRACCIÓN DE DATOS DE ETORO --- */
    const getMetadata = () => {
        // Extrae el símbolo de la URL (ej: GOLD, BTC)
        const symbol = window.location.pathname.split('/')[2]?.toUpperCase();
        // Busca el elemento de eToro que indica la temporalidad del gráfico
        const timeframeEl = document.querySelector('et-select-header.ets-chip-period');
        const timeframe = timeframeEl ? timeframeEl.innerText.trim().toLowerCase() : '1d';
        return { symbol, timeframe };
    };

    // Diccionario para traducir símbolos de eToro a Tickers de Yahoo Finance
    const mapToYahoo = (symbol, timeframe) => {
        const symbolMap = { 
            'GOLD': 'GC=F', 'SILVER': 'SI=F', 'PLATINUM': 'PL=F',
            'COPPER': 'HG=F', 'BTC': 'BTC-USD', 'ETH': 'ETH-USD' 
        };
        const intervalMap = { '1m': '1m', '5m': '5m', '1h': '60m', '1d': '1d' };
        return { ySymbol: symbolMap[symbol] || symbol, yInterval: intervalMap[timeframe] || '1d' };
    };

    /* --- 5. COMUNICACIÓN CON API EXTERNA --- */
    const fetchHistory = async (ySymbol, yInterval) => {
        const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=7d`;
        // Bypass de CORS usando AllOrigins para permitir la petición desde eToro
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        try {
            const res = await fetch(proxyUrl);
            const wrapper = await res.json();
            const json = JSON.parse(wrapper.contents);
            const quotes = json.chart.result[0].indicators.quote[0];
            // Formateamos el historial para tener High, Low y Close
            return json.chart.result[0].timestamp.map((t, i) => ({
                h: quotes.high[i], l: quotes.low[i], c: quotes.close[i]
            })).filter(v => v.c !== null);
        } catch (e) { return []; }
    };

    /* --- 6. MONITOR PRINCIPAL (LOOP) --- */
    
    let lastBarTime = 0; 

    const monitor = async () => {
        const { symbol, timeframe } = getMetadata();
        if (!symbol) return;

        // Sincronización temporal según TF
        const msMap = { '1m': 60000, '5m': 300000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
        const barDuration = msMap[timeframe] || 60000;
        const currentBarTime = Math.floor(Date.now() / barDuration) * barDuration;

        // Si el usuario cambia de gráfico, reseteamos el reloj y cargamos historial
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            lastTimeframe = timeframe; lastSymbol = symbol;
            lastBarTime = 0; // RESET CRÍTICO para nueva sincronización
            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            
            // Ajuste de Rango: 1m (5d), 5m (15d), Otros (60d) para asegurar N=128
            const rMap = { '1m': '5d', '5m': '15d', '1h': '60d', '4h': '60d', '1d': '60d' };
            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            const dynamicRange = rMap[timeframe] || '30d';
            
            // Re-definimos fetchHistory internamente para usar el rango dinámico
            const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=${dynamicRange}`;
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
            try {
                const res = await fetch(proxyUrl);
                const wrapper = await res.json();
                const json = JSON.parse(wrapper.contents);
                const quotes = json.chart.result[0].indicators.quote[0];
                candlesHistory = json.chart.result[0].timestamp.map((t, i) => ({
                    h: quotes.high[i], l: quotes.low[i], c: quotes.close[i]
                })).filter(v => v.c !== null);
            } catch (e) { candlesHistory = []; }
        }

        /* --- 7. EXTRACCIÓN OHLC --- */
        let data = {};
        const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map(f => f.contentDocument).filter(d => d)];
        docs.forEach(doc => {
            doc.querySelectorAll('[class*="valueItem-"]').forEach(item => {
                const label = item.querySelector('[class*="valueTitle-"]')?.innerText.trim();
                const val = parseFloat(item.querySelector('[class*="valueValue-"]')?.innerText.trim().replace(/,/g, ''));
                if (label === 'O') data.Open = val; if (label === 'H') data.High = val;
                if (label === 'L') data.Low = val; if (label === 'C') data.Close = val;
            });
        });

        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            
            // Inyección de vela cronológica
            if (currentBarTime > lastBarTime) {
                candlesHistory.push({ h: data.High, l: data.Low, c: data.Close });
                if (candlesHistory.length > 300) candlesHistory.shift();
                lastBarTime = currentBarTime;
            }

            // Actualización de UI básica
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            /* --- 8. CÁLCULOS MATEMÁTICOS (FOURIER CON DIRECCIÓN ▲/▼) --- */
            const N = 128; 
            if (candlesHistory.length >= N) {
                const prices = candlesHistory.slice(-N).map(v => v.c);
                const cleanData = fourierDetrend(prices);
                const spectrum = fourierTransform(cleanData);
                
                // --- FIX: DEFINICIÓN DE VARIABLES PARA DIRECCIÓN ---
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

                // Función de renderizado corregida con lógica de dirección
                const renderListWithHistory = (list, color, isTop, N, currentIdx, price, mean) => list.map((item, i) => {
                    const p = N / item.k;
                    const semiP = p / 2;
                    const fValues = [];

                    for (let j = 0; j < 4; j++) {
                        const idx = currentIdx - j;
                        let fVal = Math.ceil(semiP - (idx % semiP));
                        if (fVal <= 0) fVal = Math.ceil(semiP);
                        fValues.push(fVal);
                    }

                    // Lógica de Dirección: ▲ Giro Alcista (en suelo), ▼ Giro Bajista (en techo)
                    const direction = price > mean ? 
                        '<span style="color:#ff5252; font-size:10px; margin-left:2px;">▼</span>' : 
                        '<span style="color:#00e676; font-size:10px; margin-left:2px;">▲</span>';

                    // Lógica de Pendiente (■)
                    const [v0, v1, v2, v3] = fValues;
                    let trendColor = '#ffeb3b';
                    if (v0 === v1 && v1 === v2 && v2 === v3) trendColor = '#ffffff';
                    else if (v0 > v1 && v1 > v2 && v2 > v3) trendColor = '#00e676';
                    else if (v0 < v1 && v1 < v2 && v2 < v3) trendColor = '#ff5252';

                    const label = isTop ? `#${i+1}` : `k=${item.k}`;
                    return `<div style="display: flex; justify-content: space-between; align-items: center; padding-right: 5px;">
                        <span>${label}: <b>${p.toFixed(1)}v</b>${direction} <span style="color:${color}; font-size:0.85em;">(${fValues.join(',')})</span></span>
                        <span style="color:${trendColor}; font-size: 10px; margin-left: 2px;">■</span>
                    </div>`;
                }).join('');

                document.getElementById('f-samples').innerText = candlesHistory.length;
                document.getElementById('f-tf').innerText = timeframe.toUpperCase();
                
                const domK = top6[0].k;
                const domP = N / domK;
                const domF = Math.ceil((domP / 2) - (currentIdx % (domP / 2)));
                document.getElementById('fourier-cycle').innerText = `Ciclo Dom: ${domP.toFixed(1)}v (F: ${domF}v)`;

                // --- INYECCIÓN CON VARIABLES DEFINIDAS ---
                document.getElementById('fourier-top-list').innerHTML = renderListWithHistory(top6, '#4fc3f7', true, N, currentIdx, currentPrice, sampleMean);
                document.getElementById('fourier-first-list').innerHTML = renderListWithHistory(first6, '#ffb74d', false, N, currentIdx, currentPrice, sampleMean);
                
                fourierDraw(magnitudes.map(m => m.mag), domK - 1);
            } else {
                document.getElementById('fourier-cycle').innerText = `Cargando buffer: ${candlesHistory.length}/${N}`;
            }
        }
    };

    /* --- FUNCIONES AUXILIARES FOURIER (ADICIÓN) --- */
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

    function fourierDraw(mags, peakIdx) {
        const canvas = document.getElementById('fourier-canvas');
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

    // Ejecución del monitor cada 2 segundos para balancear precisión y rendimiento
    setInterval(monitor, 2000);
})();
