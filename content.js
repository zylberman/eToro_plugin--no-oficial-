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
            <div class="atr-ohlc">
                O: <span id="val-o">-</span> H: <span id="val-h">-</span><br>
                L: <span id="val-l">-</span> C: <span id="val-c">-</span>
            </div>
        </div>
    `;
    document.body.appendChild(ui);

    /* --- 3. LÓGICA DE INTERACCIÓN (EVENTOS) --- */
    const minBtn = document.getElementById('atr-min-btn');
    const contentBody = document.getElementById('atr-content-body');

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
        const targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=${yInterval}&range=1d`;
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
    const monitor = async () => {
        const { symbol, timeframe } = getMetadata();
        if (!symbol) return;

        // Si el usuario cambia de gráfico o tiempo, recargamos el historial
        if (timeframe !== lastTimeframe || symbol !== lastSymbol) {
            lastTimeframe = timeframe; lastSymbol = symbol;
            document.getElementById('atr-status').innerText = `${symbol} (${timeframe})`;
            const { ySymbol, yInterval } = mapToYahoo(symbol, timeframe);
            candlesHistory = await fetchHistory(ySymbol, yInterval);
        }

        /* --- 7. EXTRACCIÓN OHLC DE LOS IFRAMES --- */
        let data = {};
        // TradingView inyecta el gráfico en un iframe; buscamos en todos los frames disponibles
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

        /* --- 8. CÁLCULOS MATEMÁTICOS --- */
        // Solo operamos si el precio de cierre ha cambiado
        if (data.Close && data.Close !== lastClose) {
            lastClose = data.Close;
            // Actualizamos la UI con los valores OHLC actuales
            document.getElementById('val-o').innerText = data.Open || '-';
            document.getElementById('val-h').innerText = data.High || '-';
            document.getElementById('val-l').innerText = data.Low || '-';
            document.getElementById('val-c').innerText = data.Close || '-';

            if (candlesHistory.length >= 13) {
                // Combinamos las 13 velas anteriores con la actual para completar el ATR(14)
                const all = [...candlesHistory.slice(-13), { h: data.High, l: data.Low, c: data.Close }];
                let trs = [];
                // Cálculo del True Range (TR)
                for (let i = 1; i < all.length; i++) {
                    trs.push(Math.max(all[i].h - all[i].l, Math.abs(all[i].h - all[i-1].c), Math.abs(all[i].l - all[i-1].c)));
                }
                
                // ATR = Promedio simple de los 14 TR obtenidos
                const atrVal = (trs.reduce((a, b) => a + b, 0) / 14);
                
                // Cálculo de riesgo monetario basado en la exposición total (Margin * Leverage)
                const inv = parseFloat(document.getElementById('inv-amount').value) || 0;
                const lev = parseFloat(document.getElementById('lev-amount').value) || 1;
                
                document.getElementById('atr-value').innerText = atrVal.toFixed(4);
                // Riesgo monetario: (Unidades controladas) * ATR
                const cashRisk = ((inv * lev) / data.Close) * atrVal;
                document.getElementById('atr-cash-value').innerText = `Riesgo: $${cashRisk.toFixed(2)} USD`;
            }
        }
    };

    // Ejecución del monitor cada 2 segundos para balancear precisión y rendimiento
    setInterval(monitor, 2000);
})();