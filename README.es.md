[English](README.md) · Español

# SmartOps Agent

**Un agente de operaciones con IA para negocios que trabajan por WhatsApp.** Proveedores, clientes
y personal mandan listas de precios, pedidos y consultas en cualquier formato: texto, fotos de
listas impresas, PDF, planillas, audios. SmartOps los lee, mantiene el catálogo de productos al
día, le pregunta a una persona cuando algo es dudoso y le avisa al equipo solo lo que requiere
acción. Una persona puede tomar cualquier chat en cualquier momento.

> Estado: hecho con estándar de producción y probado de punta a punta. **La demo pública está en
> línea:** [https://smartops-demo.duckdns.org](https://smartops-demo.duckdns.org) (datos de
> ejemplo, gratis, se reinicia cada hora). La pantalla de ingreso muestra la cuenta de demo
> compartida; "Probar el sistema" envía mensajes de ejemplo por el procesamiento real. El panel
> está en inglés y en español: elige el idioma en el selector de arriba a la derecha.

> **Demo pública y sistema real.** La demo pública corre en una VM gratuita de 1 GB, así que usa un
> orquestador liviano dentro del mismo proceso en lugar de n8n (y la API y el worker en un solo
> proceso). El sistema real usa n8n; un test de paridad comprueba que los dos hacen las mismas
> llamadas ([ADR-025](docs/adr/ADR-025-light-demo-profile.md), en inglés).

## Míralo

![El recorrido de la demo: la foto de una lista de precios impresa pasa por el procesamiento real y actualiza el catálogo; un formato de planilla nuevo espera a una persona; una persona toma un chat; el panel cambia a español](docs/media/demo.gif)

La animación tiene textos en inglés. Las capturas de abajo son del panel en español:

| Inicio                                                                                                                                                      | Elegir la columna de precios de una planilla                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Inicio con revisiones pendientes, alertas abiertas, la tasa de automatización, el costo de IA y los mensajes por día](docs/guide/media-es/dashboard.webp) | ![La revisión de un formato de planilla nuevo: cada columna de precios muestra valores reales del archivo y la sugerida viene preseleccionada](docs/guide/media-es/review-columns.webp) |
| **Historial de precios**                                                                                                                                    | **Una conversación**                                                                                                                                                                    |
| ![El historial de precios de un producto como gráfico escalonado, con cada cambio y el mensaje que lo causó](docs/guide/media-es/product.webp)              | ![El chat de un proveedor con la foto de una lista de precios, una planilla y las respuestas del bot](docs/guide/media-es/chat.webp)                                                    |

## Qué hace

- **Lee cualquier formato.** Recibe texto, fotos, PDF y archivos de Word, lee las planillas por
  código cuando ya conoce su formato y transcribe los audios. Claude extrae los precios con una
  salida estructurada y validada.
- **Mantiene el catálogo correcto.** Reconoce productos aunque el nombre cambie, aplica los
  cambios de precio, guarda el historial y distingue una lista completa de una actualización
  parcial. Vigila precios atípicos, cambios de moneda e IVA, y productos que desaparecen de una
  lista completa.
- **Nunca adivina.** Todo lo dudoso de un mensaje pasa a revisión para una persona, con el mensaje
  original al lado: una coincidencia incierta, un mensaje sospechoso, un formato de planilla nuevo,
  un audio que no se entendió.
- **Trabaja con las personas.** La respuesta de una persona pausa solo las respuestas automáticas
  del bot en ese chat, y el bot vuelve solo más tarde. Las palabras de baja se respetan. El equipo
  recibe un resumen por WhatsApp por período en lugar de un mensaje por cada novedad.
- **Cuesta poco.** Un filtro previo determinístico deja fuera de la IA los saludos, los stickers y
  la charla de clientes. Las planillas con un formato conocido cuestan $0. Los topes de gasto se
  controlan antes de cada llamada a la IA. Gasto total de IA durante todo el desarrollo:
  **~$0,32**.

## Documentación

- [Guía del panel](docs/guide/guia-del-panel.md) — cada pantalla, para el dueño del negocio y el
  equipo
- [Caso de estudio](docs/caso-de-estudio.md) — el problema, el enfoque, los resultados medidos y
  lo aprendido

La documentación técnica (arquitectura, seguridad, costos, desarrollo, tests, CI/CD y las
decisiones de arquitectura) está en inglés: [docs/README.md](docs/README.md).

## Licencia

Copyright (c) 2026 Ignacio Sánchez ([sanchezign](https://github.com/sanchezign)). Todos los
derechos reservados: este repositorio se comparte solo para revisión de portfolio. Ver
[LICENSE](LICENSE).
