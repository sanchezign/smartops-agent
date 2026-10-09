# Caso de estudio: SmartOps Agent

(English version: [case-study.md](case-study.md).)

## El problema

Las distribuidoras y ferreterías chicas trabajan por WhatsApp. Los proveedores mandan listas de
precios como fotos de hojas impresas, PDF, planillas con su propio formato y audios. Los clientes
consultan precios y hacen pedidos en los mismos chats. Alguien pasa los precios a mano a una
planilla, los pedidos se pierden entre mensajes y nadie ve un aumento del 20 % hasta que el
margen ya no está.

## El objetivo

Un agente de operaciones que lea lo que llega por WhatsApp, mantenga el catálogo al día, le avise
al equipo solo lo que requiere acción y trabaje junto a las personas que atienden el mismo
número. Tenía que estar hecho con el estándar de una entrega a un cliente real, y la demo pública
tenía que funcionar con **$0** de infraestructura.

## El enfoque

- **El backend decide; la IA lee.** Claude extrae datos estructurados, validados contra un
  esquema. Todas las reglas (duplicados, precios atípicos, moneda, IVA, lista completa o
  actualización parcial) viven en código con tests, nunca en un prompt ni en la orquestación.
- **Nunca adivinar.** Los valores dudosos, las coincidencias inciertas, los formatos de planilla
  nuevos y los mensajes sospechosos pasan a revisión, con el mensaje original al lado.
- **Gastar solo donde sirve.** Un filtro previo determinístico deja fuera de la IA los saludos,
  los stickers y la charla de clientes. Las planillas con un formato conocido se leen por código.
  Los topes de gasto se controlan antes de cada llamada.
- **Confiable por diseño.** Los webhooks se guardan antes de responder, el trabajo pasa por
  colas con reintentos y mensajes muertos, y un outbox transaccional le entrega el trabajo a n8n.
  Cada paso es idempotente.
- **Las personas primero.** La respuesta de una persona pausa solo las respuestas automáticas de
  ese chat, las bajas se respetan y el equipo recibe un resumen por período.

## La arquitectura en un párrafo

Una API en Express 5 + TypeScript se encarga del webhook de WhatsApp, de las reglas y de toda
escritura en PostgreSQL. Un worker (colas de pg-boss en la misma base) descarga archivos,
transcribe audios (Whisper en Groq), convierte documentos en un hilo aislado y envía mensajes.
n8n orquesta los agentes receptor, procesador y notificador llamando a los endpoints internos de
la API. Un panel en Next.js (en inglés y en español, pensado primero para el teléfono) muestra
revisiones, conversaciones, el catálogo y las reglas, actualizado en vivo con SSE. Detalle:
[architecture.md](architecture.md) (en inglés).

## Resultados (medidos)

- **Costo de IA:** unos $0,32 de créditos de Claude en total para construir y probar todo el proyecto,
  registrado llamada por llamada. Extraer una lista de precios típica cuesta entre $0,012 y
  $0,017. Un formato de planilla nuevo cuesta unos $0,011 una vez, y $0 después.
- **Precisión con los datos de prueba:** un PDF de septiembre seguido de una foto de octubre dio
  exactamente los 5 cambios de precio automáticos y las 2 alertas esperadas, mandó 1 producto
  dudoso a revisión y no tocó un producto ausente.
- **Prompt injection:** 8 de 8 casos correctos contra el modelo real (6 ataques, 2 controles).
  Los ataques quedaron marcados y frenados para revisión, y no se aplicó ningún precio inventado.
- **Tests:** 1.098 tests unitarios y HTTP de la API y 222 contra un Postgres real; 121 tests
  unitarios del panel y 86 tests en navegador (Chrome de escritorio, Pixel 7 e iPhone con
  WebKit), con controles de accesibilidad en los dos idiomas. Puntaje de mutación: 80 %.
- **Resiliencia:** con n8n detenido y vuelto a levantar, cada mensaje se entregó una sola vez,
  con una sola corrida cada uno.
- **Infraestructura de la demo:** pensada para una VM Always Free de Oracle Cloud (todo el sistema
  usó unos 0,7 GB de memoria en una prueba de despliegue local).

## Lo difícil, y lo que aprendí

- **Meta deshabilitó la cuenta de negocio** el primer día (un falso positivo en una cuenta
  nueva). La revisión se resolvió, pero mientras tanto el desarrollo siguió contra un simulador
  local de WhatsApp que firma los webhooks e imita la Graph API. Sigue siendo la forma de trabajo
  por defecto.
- **Tiempo real a través de un túnel:** el borde de Cloudflare retenía los streams de eventos por
  GET, mientras que por POST fluían en unos 75 ms. El panel ahora abre su stream con POST y, si
  falla, se actualiza cada 30 segundos.
- **Un job de CI colgado 24 minutos:** pnpm 12 lanza los procesos hijos en un grupo de procesos
  nuevo, y Playwright no podía detener sus servidores web. Ahora esos servidores arrancan sin
  pnpm.
- **Planillas:** "1.850" puede ser mil ochocientos cincuenta o 1,85. El sistema nunca adivina: lee
  el formato del proveedor una vez, con una persona eligiendo la columna de precio, y rechaza los
  números ambiguos escritos a mano.
- **Capacidad en la nube:** la región ARM gratuita no tuvo capacidad durante días. Un script de
  reintento, con un usuario de privilegio mínimo, prueba cada pocos minutos y se detiene ante
  cualquier error que no sea de capacidad.

## Lo que sigue

Antes de un cliente real: autenticación de dos factores, dividir los PDF largos en bloques,
políticas de retención de datos, y revisar los precios por mensaje de WhatsApp (cambian el 1 de
octubre de 2026). Los costos de una instalación para un cliente están estimados en
[costs.md](costs.md) (en inglés).
