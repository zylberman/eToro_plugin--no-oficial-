# eToro ATR(14) Assistant - Browser Extension

## 📌 Descripción
Esta extensión de navegador es una herramienta de ingeniería financiera diseñada para la plataforma **eToro**. Su objetivo es calcular y visualizar el **Average True Range (ATR)** de 14 periodos en tiempo real, permitiendo cuantificar la volatilidad del mercado y el riesgo monetario directo sobre una inversión específica.

El plugin sincroniza automáticamente el historial de velas desde **Yahoo Finance** y lo combina con los datos en vivo del DOM de eToro para ofrecer una lectura precisa sin depender de indicadores externos manuales.

---

## 🚀 Características Principales
* **Cálculo de ATR(14) en Vivo:** Implementación del estándar de 14 velas para medir volatilidad.
* **Gestión de Riesgo Monetario:** Permite introducir inversión y apalancamiento para calcular la exposición real en USD.
* **Sincronización Multi-Activo:** Mapeo automático de símbolos (GOLD, SILVER, BTC, ETH, etc.).
* **Detección de Temporalidad:** Ajusta el cálculo automáticamente al cambiar entre 1m, 5m, 1h o 1d en la interfaz de eToro.
* **Interfaz Ergonómica:** Panel flotante minimalista con función de minimizar para no obstruir el gráfico.
* **Persistencia de Datos:** Guarda tus configuraciones locales mediante `localStorage`.

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
* **`content.js`**: Lógica principal de scraping (DOM), fetch de APIs y cálculos matemáticos.
* **`style.css`**: Estilos de la interfaz (Dark Mode) y animaciones de minimizado.

---

## 🔧 Instalación
1.  Descarga o clona este repositorio en tu carpeta local `~/Documentos/eToro-plugin`.
2.  Abre tu navegador (Chrome/Edge) y dirígete a la gestión de extensiones: `chrome://extensions/`.
3.  Activa el **Modo de Desarrollador**.
4.  Haz clic en **Cargar Descomprimida** y selecciona la carpeta del proyecto.
5.  Refresca la página de eToro y abre cualquier gráfico.

---

## ⚠️ Disclaimer
Este software ha sido desarrollado con fines informativos y de análisis técnico. El trading conlleva riesgos significativos. El autor no se hace responsable de las decisiones financieras tomadas basadas en los datos proporcionados por esta herramienta.

---
**Desarrollado por un Ingeniero & Médico MIR 🇪🇨**
