# eToro ATR(14) Assistant - Browser Extension

## 📌 Descripción
Esta extensión de navegador es una herramienta de ingeniería financiera diseñada para la plataforma **eToro**. Su objetivo es calcular y visualizar el **Average True Range (ATR)** de 14 periodos en tiempo real, permitiendo cuantificar la volatilidad del mercado y el riesgo monetario directo sobre una inversión específica.

El plugin sincroniza automáticamente el historial de velas desde **Yahoo Finance** y lo combina con los datos en vivo del DOM de eToro para ofrecer una lectura precisa sin depender de indicadores externos manuales.

---

## 🚀 Características Principales
* **Cálculo de ATR(14) en Vivo:** Implementación del estándar de 14 velas para medir volatilidad.
* **Gestión de Riesgo Monetario:** Permite introducir inversión y apalancamiento para calcular la exposición real en USD.
* **TP de equilibrio automático:** Con el importe y el apalancamiento calcula los precios mínimos de compra y venta que cubren apertura y cierre según el perfil CFD oficial del instrumento.
* **Sincronización Multi-Activo:** Mapeo automático de símbolos (GOLD, SILVER, BTC, ETH, etc.).
* **Detección de Temporalidad:** Ajusta el cálculo automáticamente al cambiar entre 1m, 5m, 1h o 1d en la interfaz de eToro.
* **Interfaz Ergonómica:** Panel flotante minimalista con función de minimizar para no obstruir el gráfico.
* **Panel desplazable:** Puede arrastrarse desde el encabezado, cualquiera de sus bordes o áreas vacías; la posición queda guardada localmente.
* **Diseño en cuatro columnas:** Separa datos del activo, análisis Fourier, proyección/plan operativo y reconstrucción Wavelet.
* **Minimización compacta:** Al minimizar, el panel se convierte en una barra pequeña que conserva únicamente el título, estado de conexión y control de restauración.
* **Actualización integral:** El botón de actualización vuelve a descargar el historial, leer precios ejecutables, recalcular ATR, Fourier, proyección, Wavelet, TP/SL, simulación y constantes calibradas.
* **Identidad visual:** Incluye un icono propio para el panel y para la extensión en tamaños 16, 32, 48 y 128 px.
* **Soportes, resistencias y ATR:** La primera columna agrupa en dos listas desplegables los primeros cuatro soportes y resistencias cuya distancia supera 1,50 ATR, junto con distancia y fuerza.
* **Respaldo sin zona:** Si falta un soporte o resistencia utilizable, calcula un SL por ATR/estructura disponible y sitúa el TP al menos a 1,50 veces la distancia del SL, sin dejar de cubrir los costes mínimos.
* **Plan TP/SL óptimo:** Bajo Fourier evalúa las 16 combinaciones entre las cuatro zonas de objetivo y las cuatro de stop. Descarta las que no cumplen TP > SL, beneficio mayor que dos veces el coste de apertura y SL > 1,50 ATR; entre las restantes prioriza R/R (70%) y fuerza Wavelet conjunta (30%).
* **Fourier logarítmico:** El espectro y la reconstrucción usan log-precios para estudiar oscilaciones relativas (porcentuales) sin depender de la escala nominal del activo.
* **Dirección por ciclo:** Cada armónico Fourier indica si su fase apunta hacia arriba, hacia abajo o está cerca de un giro/lateralidad en la siguiente vela.
* **Proyección operativa a 12 horas:** Extiende la tendencia logarítmica y los ciclos activos, dibuja la trayectoria futura y señala si supera 1 ATR y alcanza primero el TP de compra o venta dentro del horizonte.
* **Simulación comparativa:** Ejecuta un walk-forward causal sobre las velas cargadas para comparar la pendiente logarítmica de 16 velas con la dirección conjunta de los cinco armónicos Fourier dominantes, incluyendo costes por cambio de posición.
* **Calibración walk-forward:** Ajusta pesos de Fourier, Wavelet, alineación y umbral en pasos de 0,01 usando exclusivamente información anterior a cada resultado histórico.
* **Persistencia de Datos:** Guarda tus configuraciones locales mediante `localStorage`.
* **Ruptura exploratoria:** Extrapola armónicos Fourier conservando fase y muestra si un detalle Haar multiescala confirma una transición reciente.
* **Reconstrucción Wavelet:** Descompone la serie con Haar, ordena las escalas por energía y permite sumar o quitar componentes para comparar precio real, componentes aislados y reconstrucción.

## TP mínimo: uso y fórmula

Los costes de eToro no son universales. La extensión identifica el símbolo y aplica automáticamente la tarifa CFD por operación publicada por eToro para materias primas, índices, divisas, cripto y acciones/ETF apalancados. El usuario solo introduce el importe y selecciona el apalancamiento.

Fuente de tarifas: [Comisiones de eToro](https://www.etoro.com/es/trading/fees/) y [spreads CFD por instrumento](https://www.etoro.com/es/trading/fees/cfd-spreads/), consultadas el 14 de septiembre de 2026. Las tarifas pueden cambiar; la pantalla de ejecución de eToro prevalece.

El precio actual se obtiene en este orden: precios ejecutables Venta/Compra de eToro, cierre de la última vela del gráfico y, solo como respaldo, último cierre de Yahoo Finance. El panel siempre indica la fuente. Yahoo puede diferir porque, por ejemplo, `SILVER` se mapea al futuro `SI=F`, mientras eToro muestra su propio CFD. El TP de COMPRA parte del precio de compra y el TP de VENTA del precio de venta, por lo que una pequeña diferencia entre ambos es normal. Se calculan simultáneamente ambos lados, evitando otro selector.

Los precios Venta/Compra se vigilan con `MutationObserver` y se comprueban cada segundo como respaldo. El análisis completo de velas se mantiene separado para no recalcular FFT y Wavelet innecesariamente con cada cambio visual de la página.

Para una compra, con unidades $q$, entrada $P_0$, tasas $s$, $f_o$, $f_c$ y costes fijos $C$:

$$TP_{long}=\frac{qP_0(1+s+f_o)+C}{q(1-f_c)}$$

Para una venta:

$$TP_{short}=\frac{qP_0(1-s-f_o)-C}{q(1+f_c)}$$

El resultado es un punto de equilibrio estimado, no una recomendación de TP. No incluye financiación nocturna porque depende del número de noches, ni deslizamiento, conversión de divisas o impuestos. Si el símbolo no tiene un perfil inequívoco, el panel pide comprobar el coste estimado del ticket de eToro.

## Plan técnico TP y SL

Para COMPRA, la entrada usa el precio comprador de eToro, los TP se ordenan por resistencias Wavelet ascendentes y los SL por soportes descendentes, añadiendo un margen de 0,10 ATR. Para VENTA se invierten las zonas: TP en soportes descendentes y SL sobre resistencias ascendentes. Se muestran hasta cuatro niveles de cada clase con distancia absoluta, porcentaje y resultado monetario aproximado.

Cuando Yahoo y el CFD de eToro tienen una base de precio diferente, el historial OHLC se escala una sola vez al precio medio Venta/Compra de eToro antes de calcular las zonas. Esto conserva las variaciones relativas del historial y evita expresar soportes y resistencias en la escala de otro instrumento; sigue siendo una aproximación porque ambos feeds no son idénticos.

También calcula el precio mínimo necesario para que la ganancia bruta sea dos veces el coste de apertura. Cada TP muestra si su distancia supera la del SL1, su relación beneficio/riesgo frente a ese stop y si cubre al menos 2× el coste de apertura. No se incluyen deslizamiento ni financiación nocturna y los niveles son referencias técnicas, no recomendaciones.

## Qué significa “candidato de ruptura”

La salida combina dos piezas distintas:

1. Fourier elimina una tendencia lineal, conserva amplitud **y fase** de hasta cinco componentes dominantes y extrapola un máximo de 32 velas.
2. Haar compara retornos de dos bloques contiguos en escalas 2, 4 y 8. “Haar activa” significa que el cambio multiescala reciente supera un umbral heurístico; no es una probabilidad calibrada.

Se muestra un candidato solo cuando la pendiente proyectada cambia de signo y la separación frente a la tendencia supera medio ATR (con un piso de 0,05%). Esto reduce señales triviales, pero no convierte una extrapolación espectral en una predicción fiable. Debe validarse con pruebas walk-forward por símbolo y temporalidad.

## Combinación y calibración histórica

Wavelet agrupa pivotes de la señal reconstruida dentro de zonas cuyo ancho depende del ATR. Los contactos, la recencia y la proximidad entre el precio Fourier proyectado y la zona Wavelet producen tres valores: fuerza Fourier, fuerza Wavelet y alineación. Su promedio ponderado se compara con un umbral de señal.

Al cargar un activo se generan hasta 60 cortes históricos y se conserva un múltiplo de diez para obtener una separación cronológica exacta: el primer 80% ajusta las constantes, el siguiente 10% funciona como test y el 10% final como validación no utilizada durante el ajuste. Cada corte usa 128 velas pasadas y congela su cálculo antes de observar las 16 siguientes. Un descenso por coordenadas prueba los pesos de Fourier, Wavelet, alineación y el umbral en incrementos exactos de 0,01, utilizando únicamente el 80% de entrenamiento. Se minimiza una combinación de error de Brier y error de clasificación. El panel informa por separado tamaño y acierto de entrenamiento, test y validación. Estos porcentajes describen únicamente el historial descargado y no son probabilidades garantizadas.

El botón de actualización fuerza una nueva descarga del activo, reconstruye Fourier y Wavelet y vuelve a calibrar las constantes aunque la alineación anterior fuera alta. Bajo la columna Wavelet se muestran las ecuaciones, todos los parámetros vigentes, estado del cálculo, partición 80/10/10 y fecha de la última actualización.

Cuando comienza una vela nueva se revisa la alineación usando exclusivamente las velas cerradas. Si la puntuación combinada está por debajo del umbral calibrado, se repite la búsqueda de constantes en pasos de 0,01. Cuando la alineación es alta se conservan las constantes para evitar perseguir ruido. La vela en curso se actualiza en el buffer y queda excluida del ajuste hasta que finaliza. Si una calibración anterior continúa pendiente, su resultado se descarta mediante un token cuando existe una ejecución más reciente.

## Errores de lógica corregidos y limitaciones pendientes

* La versión anterior llamaba “consenso” a `topVisible.filter(item => currentPrice <= meanPrice)`: la condición no usaba `item`, así que todos los armónicos votaban lo mismo y la supuesta confianza normalmente era 100%.
* El tiempo de reversión se calculaba con `currentIdx % semiperiodo`, sin usar la fase real del coeficiente complejo. El máximo o mínimo de una onda no se deduce solo de su frecuencia.
* Precio sobre la media no equivale a tendencia alcista ni implica reversión a la media. Ahora el estado usa una pendiente reciente y la ruptura se etiqueta como candidato, no como certeza.
* No existía ninguna transformada Wavelet. Ahora hay detalles Haar causales multiescala, usados como confirmación descriptiva.
* El índice de fase mezclaba el tamaño del historial completo con una ventana móvil de 128 puntos. Ahora el análisis usa coordenadas locales coherentes.
* Velas con OHLC parcial podían producir `NaN` en ATR/FFT. Ahora se descartan al importar.
* El monitor esperaba 60 segundos antes de la primera ejecución y varias temporalidades se trataban como velas de un minuto al anexar datos en vivo. Ambos casos fueron corregidos.
* **Pendiente:** eToro 4h se solicita a Yahoo como 1h, pero todavía no se agregan cuatro velas de Yahoo en una vela 4h. Por ello no debe interpretarse el resultado 4h como una serie 4h correcta.
* **Pendiente:** Yahoo y eToro pueden tener feeds, sesiones, ajustes y precios diferentes. El cálculo analítico usa Yahoo para el historial y el DOM de eToro para el último dato, lo que puede crear discontinuidades.
* Los selectores del DOM de eToro son frágiles y pueden romperse cuando la plataforma cambie sus clases.

---

## 🛠️ Implementación Técnica

### Fórmula del True Range (TR)
Para garantizar la precisión en activos volátiles o con "gaps", utilizamos el cálculo técnico estándar:

$$TR = \max(High - Low, |High - Close_{prev}|, |Low - Close_{prev}|)$$

### Cálculo de Riesgo en Dólares
El plugin traduce la volatilidad del precio a impacto financiero real usando la siguiente ecuación de dimensionamiento:

$$Riesgo_{USD} = \frac{Inversión \times Apalancamiento}{Precio\,Actual} \times ATR$$

---

## 📂 Estructura del Proyecto
* **`manifest.json`**: Configuración de la extensión (MV3) y permisos de red.
* **`analytics.js`**: Cálculo puro y comprobable del TP de equilibrio, proyección Fourier y detector Haar.
* **`content.js`**: Lógica principal de scraping (DOM), fetch de APIs e interfaz.
* **`style.css`**: Estilos de la interfaz (Dark Mode) y animaciones de minimizado.
* **`tests/analytics.test.js`**: Pruebas unitarias del cálculo de costes y del análisis exploratorio.

---

## 🔧 Instalación
1.  Descarga o clona este repositorio en tu carpeta local `~/Documentos/eToro-plugin`.
2.  Abre tu navegador (Chrome/Edge) y dirígete a la gestión de extensiones: `chrome://extensions/`.
3.  Activa el **Modo de Desarrollador**.
4.  Haz clic en **Cargar Descomprimida** y selecciona la carpeta del proyecto.
5.  Refresca la página de eToro y abre cualquier gráfico.

Para ejecutar las pruebas locales:

```bash
node --test tests/analytics.test.js
```

---

## ⚠️ Disclaimer
Este software ha sido desarrollado con fines informativos y de análisis técnico. El trading conlleva riesgos significativos. El autor no se hace responsable de las decisiones financieras tomadas basadas en los datos proporcionados por esta herramienta.

---
**Desarrollado por un Ingeniero & Médico MIR 🇪🇨**
