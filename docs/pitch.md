# SmartOps Agent — Pitch original

> Documento de origen del proyecto. El stack definitivo está en `CLAUDE.md`
> (Express + PostgreSQL + n8n + Claude API + WhatsApp Cloud API + Next.js, deploy en Render,
> Whisper para audios).

**Agente Operativo Multi-Canal con IA** — sistema de automatización empresarial con agentes
de IA, WhatsApp y panel de administración.

## El problema
Una empresa recibe información de proveedores, consultas de clientes y pedidos internos por
WhatsApp en formatos caóticos (textos, PDFs, fotos, audios). Hoy alguien los procesa a mano.
SmartOps lo automatiza.

## Funcionalidades clave

1. **Procesamiento inteligente de documentos** — recibe PDFs, fotos de listas de precios,
   audios y texto libre; Claude extrae datos estructurados (productos, precios, moneda,
   disponibilidad); detecta duplicados, precios inválidos y datos incompletos; actualiza el
   catálogo diferenciando lista completa vs. actualización parcial.
2. **Coexistencia humano + bot** — mismo número de WhatsApp; pausa automática por
   conversación cuando interviene un humano; reactivación por timeout configurable;
   indicador en el panel de quién responde cada chat.
3. **Multi-agente** — agente receptor (clasifica), procesador (extrae y actualiza),
   notificador (alerta cambios de precio, stock bajo, datos faltantes), orquestados en n8n.
4. **Panel de administración** — métricas (mensajes procesados, tasa de automatización,
   errores), catálogo en tiempo real, historial de precios por proveedor, control de
   coexistencia por chat, configuración de reglas sin código.

## Diferencial frente a un chatbot genérico

| Chatbot genérico | SmartOps Agent |
|---|---|
| Responde preguntas frecuentes | Procesa documentos y toma decisiones |
| Un solo flujo de conversación | Arquitectura multi-agente |
| Bot reemplaza al humano | Coexistencia humano + bot |
| Sin panel admin | Dashboard con métricas en tiempo real |
| API no oficial | WhatsApp Business Cloud API oficial |
| Solo texto | Texto + PDFs + imágenes + audio |

## Texto para el portfolio
**SmartOps Agent — Agente operativo con IA para automatización empresarial.**
Sistema multi-agente que procesa información de proveedores recibida por WhatsApp (textos,
PDFs, imágenes, audio), extrae datos con IA, mantiene un catálogo actualizado y coexiste con
operadores humanos en el mismo número.

Stack: n8n · Claude API · WhatsApp Business Cloud API · Node.js/Express · PostgreSQL ·
Next.js · Whisper · Docker · Render

## Plan: 4 semanas
- Semana 1: setup (monorepo, Postgres, n8n, WhatsApp API) + flujo básico de mensajes
- Semana 2: audios con Whisper + extracción con Claude + lógica de catálogo + n8n multi-agente
- Semana 3: coexistencia + auth + panel admin
- Semana 4: tests + CI/CD + deploy en Render + documentación
