# M1 — Reintento automático para crear la VM (fase 12)

São Paulo está sin capacidad ARM ("500-InternalError, Out of host capacity"). En vez de
reintentar a mano, un script corre **en tu PC** y prueba crear la VM cada 5–10 minutos (con
variación al azar) durante hasta 5 días, sin Pay As You Go. Usa **OCI CLI** con un **usuario
aparte de mínimo privilegio** (`smartops-launcher`), no tu usuario administrador. Apenas tenemos
la VM, se borran ese usuario y su clave.

Script: [`scripts/oci/launch-retry.ps1`](../../scripts/oci/launch-retry.ps1). Guía anterior:
[`m1-oracle-setup.md`](m1-oracle-setup.md) (después de crear la VM, seguís desde su paso 6.1).

> 🔒 **Nunca pegues en el chat** la clave privada (`.pem`), el contenido de `~/.oci/config`
> ni tokens. Podés mandarme el log del script: no tiene secretos.

## Qué hace el script (y qué NO)

- **Antes de cada intento** busca una instancia `smartops-demo` en el compartimento `smartops`
  (en cualquier estado salvo terminada). Si existe, **no crea otra** y se detiene.
- Crea la VM con la configuración aprobada, fija en el script: `VM.Standard.A1.Flex`, **1 OCPU /
  3 GB**, Ubuntu 24.04 aarch64 (no Minimal), subred `smartops-public`, **sin IP pública** (la
  reservada se asigna a mano después), tu clave pública `smartops_oci.pub`.
- "Out of host capacity" → espera 5–10 min y reintenta. Demasiadas llamadas (429) → 15 min.
- **Cualquier otro error** (autenticación, permisos, límites, parámetros) → **se frena**, te
  avisa y deja una pista en el log. No reintenta a ciegas.
- Cuando lo logra: se detiene, **notificación de Windows + sonido**.
- Log local sin secretos: `%LOCALAPPDATA%\smartops\launch-retry.log`.
- Mientras corre, **le pide a Windows que no suspenda la PC** (se libera al terminar).
- Después de 5 días sin capacidad se detiene y lo decidimos juntos.

**Por qué lanza la instancia directo y no un job del stack de Resource Manager**: una sola
llamada a la API con el código de error exacto (capacidad vs. autenticación vs. límites), que
es lo que permite frenar ante lo que no es capacidad; los jobs del stack envuelven Terraform
(errores dentro de logs, ~1 min por intento, historial de jobs y un estado de Terraform que
puede quedar "failed") y además necesitarían más permisos (`orm-stacks`/`orm-jobs` encima de los
de la instancia). El stack `smartops-demo-vm` queda como registro de la configuración y se
borra en la limpieza.

---

## Paso 1 — Instalar OCI CLI en Windows

1. Abrí https://github.com/oracle/oci-cli/releases, bajá el instalador **MSI para Windows** de
   la última versión y ejecutalo (Siguiente → Siguiente → Finalizar).
2. Abrí una **PowerShell nueva** (normal, no hace falta como administrador) y verificá:

   ```powershell
   oci --version
   ```

   Tiene que mostrar un número de versión (por ejemplo `3.94.0`).

## Paso 2 — Usuario, grupo y política de mínimo privilegio

Las cuentas nuevas de Oracle usan **Identity Domains**: los usuarios y grupos viven en el
dominio **Default**. Todo esto lo hacés con tu usuario administrador en la consola.

### 2.1 Usuario `smartops-launcher`

1. Menú ☰ → **Identity & Security** → **Domains** → **Default** → **User management** →
   **Users** → **Create user**.
2. Valores:
   - **First name:** `SmartOps` · **Last name:** `Launcher`
   - **Username / Email:** Oracle exige un mail. Usá un alias de tu casilla, por ejemplo
     `tu.usuario+smartops-launcher@gmail.com` (llega a tu mismo buzón).
   - **No** le asignes roles de administrador ni lo agregues a _Administrators_.
3. **Create**. Si llega un mail de activación de la consola, **ignoralo**: este usuario nunca
   entra a la consola, solo usa la clave de API.

### 2.2 Grupo `smartops-launchers`

1. En el mismo dominio → **User management** → **Groups** → **Create group**.
2. **Name:** `smartops-launchers` · **Description:** `Solo crear la VM de la demo` · agregá al
   usuario `smartops-launcher`. **Create**.

### 2.3 Política

1. Menú ☰ → **Identity & Security** → **Policies**. A la izquierda elegí el compartimento
   **raíz** (el de la cuenta; la política tiene una línea "in tenancy").
2. **Create Policy** → **Name:** `smartops-launcher-policy` → **Description:** `Crear la VM de la
demo en smartops` → **Show manual editor** y pegá exactamente:

   ```text
   Allow group 'Default'/'smartops-launchers' to manage instance-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to use volume-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to use virtual-network-family in compartment smartops
   Allow group 'Default'/'smartops-launchers' to read app-catalog-listing in tenancy
   ```

   Es la receta oficial de Oracle "Let users launch compute instances", **limitada al
   compartimento `smartops`**: puede crear/ver instancias y usar la red y el disco de ese
   compartimento, y leer el catálogo de imágenes. No puede tocar otros compartimentos, la
   facturación ni la identidad.

3. **Create**.

**Verificá:** Policies muestra `smartops-launcher-policy` con 4 sentencias.

### 2.4 Clave de API (se genera en la consola)

1. **Domains** → **Default** → **Users** → `smartops-launcher` → **API keys** → **Add API key**.
2. **Generate API key pair** → **Download private key** (baja un `.pem`) → **Add**.
3. Aparece **Configuration file preview**: dejá esa ventana abierta (la usás en el paso 3).
4. Mové el `.pem` descargado a `C:\Users\<tu usuario>\.oci\smartops_launcher.pem` (creá la
   carpeta `.oci` si no existe). **Nunca** lo pongas dentro del repo ni en Drive/OneDrive.
5. Restringí sus permisos:

   ```powershell
   oci setup repair-file-permissions --file $HOME\.oci\smartops_launcher.pem
   ```

## Paso 3 — Configurar `~/.oci/config`

1. Abrí (o creá) `C:\Users\<tu usuario>\.oci\config` con el Bloc de notas.
2. Agregá una sección `[SMARTOPS]` copiando los valores de **Configuration file preview**:

   ```ini
   [SMARTOPS]
   user=ocid1.user.oc1..(el del preview)
   fingerprint=(el del preview)
   tenancy=ocid1.tenancy.oc1..(el del preview)
   region=sa-saopaulo-1
   key_file=C:\Users\<tu usuario>\.oci\smartops_launcher.pem
   ```

   (Si el archivo ya tenía una sección `[DEFAULT]`, dejala como está.)

3. Restringí también el archivo de configuración:

   ```powershell
   oci setup repair-file-permissions --file $HOME\.oci\config
   ```

## Paso 4 — Probar la conexión (sin crear nada)

1. Copiá el **OCID del compartimento `smartops`**: Identity & Security → Compartments →
   `smartops` → _OCID_ → **Copy**.
2. Prueba de autenticación:

   ```powershell
   oci --profile SMARTOPS iam region list --output table
   ```

   Tiene que listar regiones. Si dice `NotAuthenticated`: revisá fingerprint, `key_file` y que
   la clave de API sea la del usuario `smartops-launcher`.

3. **Dry-run del script** (resuelve subred, dominio de disponibilidad e imagen, y verifica que
   no exista ya la VM; **no crea nada**):

   ```powershell
   cd C:\dev\smartops-agent
   powershell -ExecutionPolicy Bypass -File scripts\oci\launch-retry.ps1 -CompartmentId <OCID de smartops> -DryRun
   ```

   Esperado: líneas `subred smartops-public = …`, `dominio de disponibilidad = …`,
   `imagen = Canonical-Ubuntu-24.04-aarch64-…` y al final `DRYRUN todo resuelto…`.

   - Si se frena en _listar dominios de disponibilidad_ con `NotAuthorizedOrNotFound`: copiá el
     nombre del dominio de la pantalla _Create Instance_ (algo como `Xyz1:SA-SAOPAULO-1-AD-1`) y
     agregá `-AvailabilityDomain "Xyz1:SA-SAOPAULO-1-AD-1"` al comando.
   - Cualquier otro error: mandame la línea `STOP` y la `HINT` del log.

## Paso 5 — Dejar la PC lista para varios días

- **Enchufada** (si es notebook) y con la **tapa abierta**, o en _Configuración → Sistema →
  Energía → Acciones de la tapa_ poné "No hacer nada" mientras corre.
- El script le pide a Windows que no suspenda; podés verificarlo con
  `powercfg /requests` (aparece `powershell.exe` en **SYSTEM**).
- **Windows Update**: _Configuración → Windows Update → Pausar actualizaciones_ por 1 semana, así
  no reinicia solo.
- La pantalla sí puede apagarse; eso no frena el script.

## Paso 6 — Correr el reintento

En una PowerShell que vas a dejar abierta:

```powershell
cd C:\dev\smartops-agent
powershell -ExecutionPolicy Bypass -File scripts\oci\launch-retry.ps1 -CompartmentId <OCID de smartops>
```

- Cada intento aparece en pantalla y en el log (`CAPACITY intento 12: 500 InternalError Out of
host capacity. -> proximo en 7,3 min`).
- Ver el log desde otra ventana:
  `Get-Content $env:LOCALAPPDATA\smartops\launch-retry.log -Tail 20 -Wait`
- **Pararlo:** `Ctrl + C` en su ventana (o cerrarla). Volver a lanzarlo es seguro: primero se
  fija si la VM ya existe.

Cuando lo logra: notificación **"SmartOps: VM creada!"** + sonido, y una línea `SUCCESS` en el
log. Seguí con el **paso 6.1** de [`m1-oracle-setup.md`](m1-oracle-setup.md) (asignar la IP
reservada) y el resto de la guía (Bastion, verificación).

Si se frena solo (`STOP`): leé la línea `HINT`, corregí y volvé a correrlo; si no está claro,
mandame esas dos líneas.

## Paso 7 — Limpieza (apenas la VM está RUNNING)

El usuario de lanzamiento no se necesita más: **borralo con su clave**.

1. **Domains → Default → Users → `smartops-launcher` → API keys**: borrá la clave.
2. Borrá el usuario `smartops-launcher` (Users → ⋮ → _Delete_).
3. **Groups**: borrá `smartops-launchers`.
4. **Policies** (compartimento raíz): borrá `smartops-launcher-policy`.
5. En tu PC:
   - borrá `C:\Users\<tu usuario>\.oci\smartops_launcher.pem`;
   - quitá la sección `[SMARTOPS]` de `C:\Users\<tu usuario>\.oci\config`.
6. **Resource Manager → Stacks → `smartops-demo-vm`**: revisá que _Stack resources_ esté vacío
   (los intentos fallidos no crearon nada) y borrá el stack.
7. Reanudá Windows Update y volvé la configuración de energía a como estaba.
8. (Opcional) Desinstalá OCI CLI desde _Aplicaciones instaladas_.

**Verificá:** Users ya no muestra `smartops-launcher` y Policies ya no tiene la política.
