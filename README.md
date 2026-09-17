# ✈️ MySkyRadar

> Uma Progressive Web App (PWA) moderna e minimalista para monitorizar aviões em tempo real perto de ti.

**[🌐 Ver Demo ao Vivo](https://regs4git.github.io/myskyradar/)**

## 📱 Sobre o Projeto

O MySkyRadar acede à localização do teu dispositivo (ou usa Lisboa como fallback) e apresenta num mapa interativo todos os aviões em voo num raio selecionável. Desenhado para ser rápido, agradável ao olhar e funcional, sem a complexidade das apps de aviação profissionais.

## ✨ Funcionalidades

- 🛰️ **Dados em Tempo Real:** Atualização automática a cada 15 segundos via OpenSky Network.
- 📏 **Alcance Ajustável:** Botões rápidos para 1, 3, 5, 10 e 25 km.
- 🔔 **Alertas Inteligentes:** Notificações (e som opcional) apenas para aviões realmente visíveis (baixa altitude e curta distância), evitando spam.
- 🎨 **UI Moderna:** Tema escuro clean, glassmorphism, ícones de aviões que rodam conforme a direção real e animações suaves.
- 📴 **Offline-Ready:** Service Worker incluído para carregamento instantâneo e funcionamento básico sem rede.
- 📱 **PWA Instalável:** Adiciona ao ecrã principal do teu telemóvel como uma app nativa.

## 🛠️ Tecnologias

- **Frontend:** HTML5, CSS3 (Custom Properties, Flexbox/Grid), Vanilla JavaScript (ES6+)
- **Mapas:** [Leaflet.js](https://leafletjs.com/) + [CartoDB Dark Matter](https://carto.com/basemaps/)
- **Dados:** [OpenSky Network API](https://opensky-network.org/) (gratuita, sem chave de API para uso moderado)
- **Hospedagem:** GitHub Pages

## 🚀 Instalação e Desenvolvimento Local

1. Clona o repositório:
   ```bash
   git clone https://github.com/regs4git/myskyradar.git
   cd myskyradar
