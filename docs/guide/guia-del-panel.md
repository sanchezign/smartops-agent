# Guía del panel de SmartOps

Para el dueño del negocio y el equipo que usa el panel todos los días. Explica qué muestra cada
pantalla y qué hacer en ella. No hace falta saber nada técnico. (English version:
[panel-guide.md](panel-guide.md).)

## Qué hace SmartOps por ti

Tus proveedores envían listas de precios por WhatsApp: texto, fotos de listas impresas, PDF,
planillas, audios. SmartOps las lee y actualiza tu catálogo solo. Cuando no está seguro de algo,
no adivina: lo deja en **Revisiones** para que decida una persona. Las consultas y los pedidos
de clientes le llegan al equipo, y el equipo recibe un resumen corto por WhatsApp en lugar de un
mensaje por cada novedad.

## Ingresar

![La pantalla de ingreso](media-es/login.webp)

- Ingresa con tu email y tu contraseña. Las contraseñas son frases largas (mínimo 15
  caracteres); después de varios intentos fallidos la cuenta se bloquea un rato, y un
  administrador puede desbloquearla.
- **Idioma:** elige English o Español en el selector (arriba a la derecha, o en el menú de tu
  cuenta en el teléfono). El panel recuerda tu elección en todos tus dispositivos.
- **Tema:** claro, oscuro o el del dispositivo, desde el menú de tu cuenta.
- **Cerrar todas mis sesiones** (menú de tu cuenta) cierra tu sesión en todos los dispositivos,
  por ejemplo si pierdes el teléfono.

## Inicio

![La pantalla de inicio](media-es/dashboard.webp)

- La primera fila es lo que necesita a una persona ahora: **revisiones pendientes**, **alertas
  abiertas**, **chats atendidos por una persona** y **errores**. Toca una tarjeta para ir ahí.
- **Resuelto sin intervención** es la parte de los mensajes procesados que no necesitó a nadie.
- **Filtrado sin IA** cuenta los mensajes (saludos, stickers, charla de clientes) que no costaron
  nada, con el ahorro estimado.
- Los gráficos muestran los mensajes por día y el costo de IA por día, con los presupuestos
  diario y total.
- Cambia entre 7, 14 y 30 días arriba a la derecha.

## Revisiones

![La cola de revisiones](media-es/reviews.webp)

Una revisión es una decisión que el sistema no toma solo. Nada de una revisión pendiente se
aplicó todavía al catálogo. Filtra por tipo (listas enteras, productos, catálogo) y por estado.

**Una línea de producto** (por ejemplo, un cambio de precio fuera de lo normal):

![Una revisión de producto](media-es/review-line.webp)

1. Lee lo que dice la lista y el mensaje original (el enlace abre la conversación).
2. Elige qué producto es, o "Es un producto nuevo".
3. Revisa o corrige el precio y toca **Aplicar precio**. Escribe los precios sin punto de miles
   (1850 o 1850,50): un "1.850" ambiguo se rechaza a propósito.
4. **Rechazar** si está mal; puedes dejar una nota para el equipo.

**Un formato de planilla nuevo**: la primera vez que un proveedor manda una planilla con otra
forma, eliges qué columna de precio va al catálogo. Cada opción muestra valores reales del
archivo, y la sugerida viene marcada. Después, las planillas con la misma forma se leen solas,
sin IA y sin costo.

![Elegir la columna de precio](media-es/review-columns.webp)

Otras revisiones que puedes ver: "¿Es este producto?", un producto que falta en una lista
completa ("¿Marcar como no disponible?"), un aumento general ("todo +8 %"), un cambio del IVA de
la lista, y un **mensaje sospechoso** que intenta darle órdenes al sistema (no se aplicó nada;
léelo antes de procesarlo).

Los operadores resuelven líneas de producto. Las revisiones que afectan una lista entera o todo el
catálogo son para administradores.

## Conversaciones

![La bandeja de entrada](media-es/inbox.webp)

- Cada chat muestra quién está respondiendo: 🤖 **responde el bot**, 👤 **atiende una persona**
  (hasta una hora), o ⛔ **dado de baja**.
- Busca por nombre, proveedor o teléfono, y filtra por tipo.

![Una conversación](media-es/chat.webp)

- **Responder como persona** desde el cuadro de abajo. Se envía por WhatsApp como la empresa, y
  el bot se pausa en ese chat (por defecto, 2 horas desde tu último mensaje). WhatsApp solo
  permite respuestas libres dentro de las 24 horas del último mensaje del contacto; el panel te
  avisa cuando la ventana está cerrada.
- **Pausar el bot** (30 minutos, 2 horas, 8 horas o hasta que lo reactives) y **Reactivar el
  bot** cuando quieras.
- La respuesta de una persona solo pausa las respuestas automáticas: las listas de precios de ese
  contacto se siguen procesando y el equipo sigue recibiendo avisos.
- **Bajas:** si un contacto escribe BAJA o STOP, deja de recibir mensajes automáticos. También
  puedes registrar una baja a mano (menú ⋮). Solo un administrador vuelve a dar de alta a
  alguien. La lista de contactos dados de baja está en **Dados de baja**.

## Catálogo

![El historial de precios de un producto](media-es/product.webp)

- Los productos de cada proveedor con su último precio y su último cambio. Busca por nombre o
  filtra por proveedor y disponibilidad.
- Abre un producto para ver su historial de precios: el gráfico y la lista de cambios, cada uno
  con un enlace al mensaje que lo causó.
- Los administradores pueden **renombrar un proveedor** (por ejemplo, cuando se creó con el
  nombre de WhatsApp).

## Alertas

![Alertas](media-es/alerts.webp)

Aumentos grandes, poco stock, audios demasiado largos para transcribir y errores de integración.
Marca cada una como **vista** cuando la resuelvas.

## Reglas

![Reglas](media-es/rules.webp)

Cómo se comporta el sistema, sin tocar código. Los cambios aplican al instante y quedan
registrados. Solo los administradores pueden cambiarlas.

- **Respuestas automáticas:** el idioma de los mensajes de WhatsApp, el bot prendido o apagado,
  la confirmación a los proveedores de que llegó su lista, y cuánto tiempo queda pausado el bot
  después de que responde una persona.
- **Horario de atención:** fuera de horario, los resúmenes por WhatsApp que no son urgentes
  esperan a la apertura.
- **Precios:** desde qué porcentaje un cambio genera una alerta, y desde qué aumento o baja un
  precio espera una revisión; crear productos nuevos automáticamente.
- **Avisos al equipo por WhatsApp:** quién recibe los resúmenes, cada cuánto, y los límites por
  hora.
- **Audios y bajas:** el audio más largo que se transcribe automáticamente, y las palabras de
  baja y de alta.

## Usuarios (administradores)

![Usuarios](media-es/users.webp)

- Crea usuarios como **operador** (revisiones de líneas de producto y conversaciones) o
  **administrador** (todo, incluidas las reglas y los usuarios).
- Cambia roles, desactiva, pon una contraseña nueva, desbloquea o cierra las sesiones de un
  usuario. Cada cambio de rol, desactivación o contraseña nueva cierra las sesiones de ese
  usuario.
- Nadie puede cambiar su propio rol ni desactivarse, y siempre queda al menos un administrador
  activo.

## El resumen por WhatsApp

El equipo recibe un mensaje por período (10 minutos por defecto) con lo que requiere acción:
pedidos, consultas de clientes, listas con cambios grandes o revisiones pendientes, y errores. El
enlace del final abre las pantallas correspondientes del panel (primero pide ingresar).

## Lo que SmartOps nunca hace

- Nunca inventa un precio ni adivina un valor dudoso: pregunta en Revisiones.
- Nunca aplica instrucciones escritas dentro de un mensaje o de un archivo.
- Nunca les escribe a los contactos dados de baja, salvo la única confirmación.
- Nunca envía más de los límites que pongas en Reglas.
