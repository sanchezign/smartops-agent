# M1 — Oracle Cloud paso a paso (fase 12)

Guía para crear, **a $0**, todo lo que la demo pública necesita en Oracle Cloud: cuenta,
presupuesto con alertas, red, IP pública fija, la VM, el acceso SSH por Bastion y el nombre en
DuckDNS. Está pensada para alguien que **nunca usó Oracle Cloud**. Nada de esta guía instala la
demo todavía: eso es el M2 (endurecer la VM) y el M3 (primer deploy).

> Las pantallas de Oracle cambian de nombre seguido. Si un botón no se llama exactamente igual,
> buscá el más parecido; los **valores** que hay que poner son los de esta guía.

**Reglas de oro durante todo el M1**

- **Nunca hagas "Upgrade to Pay As You Go"** (ni aunque la consola lo sugiera para conseguir
  capacidad). Según Oracle, la tarjeta no se cobra salvo que actualices la cuenta.
- **Solo recursos con la etiqueta "Always Free-eligible"**. Si una forma, imagen o servicio no la
  tiene, no lo crees.
- **No toques** nada que no esté en esta guía (bases de datos, Kubernetes, balanceadores, VPN,
  NAT gateway, instancias AMD, etc.).
- **Nada de secretos en capturas ni en el chat conmigo**: podés mandarme IPs, nombres y
  mensajes de error, nunca claves privadas ni el token de DuckDNS.

**Qué vas a tener al final (me lo pasás para el M2):**

| Dato                              | Ejemplo                                 |
| --------------------------------- | --------------------------------------- |
| Región de origen                  | `sa-saopaulo-1` (São Paulo)             |
| IP pública reservada de la VM     | `144.22.x.y`                            |
| IP privada de la VM               | `10.0.0.23`                             |
| Nombre DuckDNS                    | `smartops-demo.duckdns.org`             |
| Forma de la VM                    | `VM.Standard.A1.Flex`, 1 OCPU, 3 GB     |
| Resultado de la prueba de Bastion | "entré" / "no entré + mensaje de error" |

Tiempo estimado: 1 a 2 horas (más reintentos si aparece "Out of capacity").

---

## Paso 0 — Antes de empezar (en tu PC)

### 0.1 Clave SSH

La VM solo acepta clave SSH (nunca contraseña). Si ya tenés una clave **ed25519** que usás
solo para servidores, podés usarla; si no, creá una nueva. En PowerShell:

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\smartops_oci -C "smartops-oci"
```

- Te pide una **passphrase**: poné una (protege la clave si alguien copia el archivo).
- Se crean dos archivos: `smartops_oci` (**privada — nunca sale de tu PC**) y
  `smartops_oci.pub` (pública — esta es la que se sube a Oracle).

**Verificá:** `Get-Content $HOME\.ssh\smartops_oci.pub` muestra una línea que empieza con
`ssh-ed25519`.

### 0.2 Tu IP pública (para el plan B)

Entrá a https://ifconfig.me desde tu PC y anotá la IP. Solo se usa si Bastion falla (paso 7).

---

## Paso 1 — Crear la cuenta (región de origen: São Paulo)

1. Entrá a https://www.oracle.com/cloud/free/ → **Start for free**.
2. Datos de la cuenta:
   - **Country/Territory:** Uruguay.
   - **Cloud Account Name:** algo sin datos personales, por ejemplo `smartopsdemo` (es parte de
     la URL de login; no se puede cambiar).
   - **Home Region:** **Brazil East (São Paulo)**. Si no aparece o da error de capacidad al
     registrarte, **Chile Central (Santiago)**.

   > ⚠️ **La región de origen no se puede cambiar nunca** y los recursos Always Free solo se
   > crean ahí. Revisala dos veces antes de seguir.

3. Verificación con tarjeta: Oracle pide una tarjeta para verificar identidad. Puede aparecer
   una **retención temporal** que se libera sola; no es un cobro.
4. Esperá el mail "Your account is ready" (puede tardar de minutos a horas).

**Verificá:** al entrar a la consola, arriba a la derecha dice **Brazil East (Sao Paulo)**
(o Chile Central si fuiste por el plan B).

**No toques:** el banner de "Upgrade" ni la prueba de servicios pagos.

---

## Paso 2 — Presupuesto de USD 1 con alertas

El presupuesto **no frena nada**: solo te manda un mail si aparece cualquier gasto. Es la
alarma temprana de que algo no era Always Free.

1. Menú ☰ → **Billing & Cost Management** → **Budgets** → **Create Budget**.
2. Valores:
   - **Name:** `smartops-cero-gasto`
   - **Target:** _Compartment_ → el compartimento **raíz** (el que tiene el nombre de tu cuenta).
   - **Schedule:** _Monthly_.
   - **Budgeted amount:** `1` (USD).
3. **Budget alert rule** (primera regla):
   - **Threshold metric:** _Actual Spend_
   - **Threshold type:** _Percentage of Budget_ → `1` (%, o sea USD 0,01)
   - **Email recipients:** tu mail.
   - **Message:** `SmartOps: apareció un gasto en Oracle Cloud. Revisar Cost Analysis.`
4. Guardá y agregá una **segunda regla** igual pero con **Threshold metric: Forecast Spend**.

**Verificá:** Budgets muestra `smartops-cero-gasto` con 2 alert rules. El presupuesto se evalúa
cada 24 h, así que no esperes un mail enseguida.

---

## Paso 3 — Compartimento (orden, sin costo)

1. Menú ☰ → **Identity & Security** → **Compartments** → **Create Compartment**.
2. **Name:** `smartops` · **Description:** `Demo publica SmartOps` · **Parent:** la raíz.

A partir de acá, **todo se crea en el compartimento `smartops`** (hay un selector de
compartimento a la izquierda en cada pantalla).

---

## Paso 4 — Red (VCN, gateway de internet, subred y reglas)

Vamos a crear la red **a mano** (no con el asistente "VCN with Internet Connectivity", que
agrega un NAT gateway y otras piezas que no necesitamos).

### 4.1 VCN

1. Menú ☰ → **Networking** → **Virtual Cloud Networks** → **Create VCN**.
2. **Name:** `smartops-vcn` · **Compartment:** `smartops` · **IPv4 CIDR block:** `10.0.0.0/16`.
   Dejá desmarcado IPv6. **Create VCN**.

### 4.2 Internet Gateway

1. Dentro de `smartops-vcn` → **Gateways** (o _Internet Gateways_) → **Create Internet Gateway**.
2. **Name:** `smartops-igw`. **Create**.

### 4.3 Ruta a internet

1. Dentro de la VCN → **Route Tables** → **Default Route Table for smartops-vcn**.
2. **Add Route Rules**:
   - **Target Type:** _Internet Gateway_
   - **Destination CIDR Block:** `0.0.0.0/0`
   - **Target Internet Gateway:** `smartops-igw`

### 4.4 Reglas de entrada (security list)

1. Dentro de la VCN → **Security Lists** → **Default Security List for smartops-vcn**.
2. **Ingress Rules**: vas a ver una regla de **TCP 22 desde `0.0.0.0/0`**. **Borrala** (el SSH
   nunca queda abierto a internet). Dejá las de ICMP que vienen por defecto.
3. **Add Ingress Rules** (tres reglas, _Stateless_ desmarcado, _IP Protocol: TCP_):

   | Source CIDR   | Destination Port | Para qué                                          |
   | ------------- | ---------------- | ------------------------------------------------- |
   | `0.0.0.0/0`   | `80`             | HTTP (Caddy lo redirige a HTTPS)                  |
   | `0.0.0.0/0`   | `443`            | HTTPS de la demo                                  |
   | `10.0.0.0/24` | `22`             | SSH **solo desde adentro de la subred** (Bastion) |

4. **Egress Rules:** dejá la que viene (todo el tráfico de salida permitido).

**Verificá:** las reglas de entrada son exactamente ICMP (las de fábrica), `80` y `443` desde
`0.0.0.0/0`, y `22` **solo** desde `10.0.0.0/24`.

### 4.5 Subred pública

1. Dentro de la VCN → **Subnets** → **Create Subnet**.
2. Valores:
   - **Name:** `smartops-public`
   - **Subnet Type:** _Regional_
   - **IPv4 CIDR Block:** `10.0.0.0/24`
   - **Route Table:** _Default Route Table for smartops-vcn_
   - **Subnet Access:** _Public Subnet_
   - **Security List:** _Default Security List for smartops-vcn_
3. **Create Subnet**.

**No toques:** NAT gateway, Service gateway, DRG, VPN, Load Balancer.

---

## Paso 5 — IP pública reservada

Una IP **reservada** no cambia aunque borres y vuelvas a crear la VM (así DuckDNS se configura
una sola vez).

1. Menú ☰ → **Networking** → **IP Management** → **Reserved Public IPs** → **Reserve Public IP
   Address**.
2. **Name:** `smartops-demo-ip` · **Compartment:** `smartops` · _Create new_ (no "from IP pool").

**Verificá:** aparece `smartops-demo-ip` con una dirección `x.x.x.x` y estado _Available_. Anotá
la IP.

> 💲 Oracle anunció las IP públicas reservadas **sin costo**; no lo pude confirmar en una página
> de precios oficial. El presupuesto del paso 2 avisaría ante cualquier gasto, y en el paso 9
> lo revisamos en _Cost Analysis_.

---

## Paso 6 — La VM (1 OCPU / 3 GB, Ubuntu 24.04 ARM)

1. Menú ☰ → **Compute** → **Instances** → **Create Instance**.
2. **Name:** `smartops-demo` · **Compartment:** `smartops`.
3. **Placement:** dejá el _Availability Domain_ que viene (São Paulo tiene uno solo).
4. **Image and shape** → **Edit**:
   - **Image:** _Change image_ → **Canonical Ubuntu** → **24.04** (la común, **no** la
     "Minimal"). Tiene que decir _Always Free-eligible_.
   - **Shape:** _Change shape_ → **Ampere** → **VM.Standard.A1.Flex** (_Always Free-eligible_).
     - **Number of OCPUs:** `1`
     - **Amount of memory (GB):** `3`

     > Por qué 3 GB y no más: Oracle puede reclamar una VM Always Free si en 7 días CPU, red
     > **y memoria** están debajo del 20 %. La demo usa ≈ 0,7 GB; con 3 GB el umbral es 0,6 GB.
     > Se puede agrandar después sin reinstalar.
5. **Networking** → **Edit**:
   - _Select existing virtual cloud network_ → `smartops-vcn`
   - _Select existing subnet_ → `smartops-public`
   - **Public IPv4 address:** _Do not assign_ (en el paso 6.1 le asignamos la reservada).
6. **Add SSH keys:** _Upload public key files (.pub)_ → `smartops_oci.pub` (la **pública**).
7. **Boot volume:** dejá el tamaño por defecto (50 GB). **No** marques "Use in-transit
   encryption" si pide cambiar la forma, ni otras opciones avanzadas.
8. **Create**.

**Si aparece "Out of capacity for shape VM.Standard.A1.Flex"**: es falta temporal de máquinas
ARM en la región, no un error tuyo. Reintentá en otro horario (temprano de mañana o de
madrugada suele andar mejor), durante unos días. **No** cambies a Pay As You Go ni a una forma
sin la etiqueta Always Free. Si después de varios días no hay caso, lo decidimos juntos.

**Verificá:** la instancia queda **RUNNING**, _Shape_ `VM.Standard.A1.Flex`, _OCPU count_ 1,
_Memory_ 3 GB. En **Primary VNIC** anotá la **Private IPv4 address** (ej. `10.0.0.23`).

### 6.1 Asignarle la IP reservada

1. En la instancia → **Attached VNICs** (o _Networking_) → la VNIC primaria → **IPv4
   Addresses**.
2. En la IP privada primaria → ⋮ → **Edit** → **Public IP type:** _Reserved public IP_ →
   _Select existing_ → `smartops-demo-ip` → **Update**.

**Verificá:** la instancia muestra como _Public IPv4 address_ la IP reservada del paso 5.

### 6.2 Activar el plugin de Bastion (por las dudas)

En la instancia → **Oracle Cloud Agent** → activá **Bastion** si aparece desactivado. (La sesión
de _port forwarding_ del paso 7 no lo necesita, pero no molesta.)

---

## Paso 7 — Acceso SSH por Bastion (y plan B)

El puerto 22 no está abierto a internet. Entramos a través del servicio **Bastion** de Oracle
(gratis): crea un túnel temporal (máximo 3 h) hacia la VM.

### 7.1 Crear el bastion

1. Menú ☰ → **Identity & Security** → **Bastion** → **Create bastion**.
2. Valores:
   - **Name:** `smartopsbastion` (solo letras y números)
   - **Target virtual cloud network:** `smartops-vcn`
   - **Target subnet:** `smartops-public`
   - **CIDR block allowlist:** tu IP del paso 0.2 con `/32` (ej. `190.64.x.y/32`). Si tu IP cambia
     seguido, podés poner `0.0.0.0/0`: igual hace falta tu clave privada para entrar.
3. **Create bastion** y esperá a que quede **Active**.

### 7.2 Crear una sesión

1. En el bastion → **Create session**.
2. Valores:
   - **Session type:** _SSH port forwarding session_
   - **Session name:** `smartops-ssh`
   - **Connect to the target host by using:** _IP address_ → la **IP privada** de la VM (paso 6)
   - **Port:** `22`
   - **SSH key:** _Choose SSH key file_ → `smartops_oci.pub`
   - **Maximum session time-to-live:** 180 minutos (lo máximo)
3. **Create session** y esperá **Active**.
4. En la sesión → ⋮ → **Copy SSH command**. Es algo así (el tuyo va a tener otros valores):

   ```text
   ssh -i <privateKey> -N -L <localPort>:10.0.0.23:22 -p 22 ocid1.bastionsession.oc1.sa-saopaulo-1.xxxx@host.bastion.sa-saopaulo-1.oci.oraclecloud.com
   ```

### 7.3 Probar (dos terminales de PowerShell)

Terminal 1 (el túnel; queda "colgada", es normal):

```powershell
ssh -i $HOME\.ssh\smartops_oci -N -L 2222:10.0.0.23:22 -p 22 ocid1.bastionsession....@host.bastion.sa-saopaulo-1.oci.oraclecloud.com
```

(reemplazá `<privateKey>` por tu clave y `<localPort>` por `2222`; el resto, tal cual lo copiaste.)

Terminal 2 (entrar a la VM por el túnel):

```powershell
ssh -i $HOME\.ssh\smartops_oci -p 2222 ubuntu@localhost
```

La primera vez pregunta si confiás en la huella del servidor: respondé `yes`.

**Verificá, ya adentro de la VM:**

```bash
uname -m           # aarch64
free -h            # Mem total ≈ 2,8 Gi
lsb_release -d     # Ubuntu 24.04…
curl -s ifconfig.me; echo    # la IP reservada del paso 5
exit
```

Si todo eso sale bien: **Bastion funciona** y es el camino definitivo. Anotá "entré".

### 7.4 Plan B (solo si 7.3 falla)

Si no pudiste entrar (anotá el mensaje de error exacto para mandármelo):

1. **Security List** (paso 4.4) → **Add Ingress Rule**: _Source CIDR_ = tu IP del paso 0.2 con
   `/32`, _TCP_, _Destination Port_ `22`.
2. Entrá directo: `ssh -i $HOME\.ssh\smartops_oci ubuntu@<IP reservada>`.
3. Si tu IP de casa cambia, vas a tener que actualizar esa regla (ifconfig.me te dice la nueva).

**No hagas:** abrir el 22 a `0.0.0.0/0`.

---

## Paso 8 — Nombre gratis en DuckDNS

1. Entrá a https://www.duckdns.org y logueate (GitHub o Google).
2. En **sub domain** escribí el nombre (sin datos personales), por ejemplo `smartops-demo`,
   → **add domain**.
3. En la fila del dominio, en **current ip**, borrá lo que haya, pegá la **IP reservada** del
   paso 5 → **update ip**.
4. El **token** que muestra la página es como una contraseña: guardalo en tu gestor de
   contraseñas. **Nunca va a la VM ni al repo** (la IP no cambia, así que no hace falta
   actualizarla desde el servidor).

**Verificá** (en PowerShell, puede tardar unos minutos):

```powershell
Resolve-DnsName smartops-demo.duckdns.org -Type A
```

Tiene que devolver la IP reservada. (La página todavía no carga nada: la demo se instala en M3.)

---

## Paso 9 — Verificar el "cero gasto" (a las 24–48 h)

1. Menú ☰ → **Billing & Cost Management** → **Cost Analysis**: el total del mes tiene que ser
   **0,00**. Si aparece algo, mirá qué servicio es y avisame.
2. **Subscriptions** (o _Upgrade and Manage Payment_): la cuenta sigue en **Free Tier** (o _Free
   Trial_ los primeros 30 días), **sin** "Pay As You Go".
3. Menú ☰ → **Governance & Administration** → **Limits, Quotas and Usage**: filtrá _Compute_ →
   el uso de _Standard.A1 cores_ es 1 de 2 y la memoria 3 de 12 GB.

---

## Qué me mandás al terminar

- Región, IP reservada, IP privada, nombre DuckDNS y forma de la VM (tabla del principio).
- Resultado de Bastion (paso 7.3) o del plan B, con el mensaje de error si hubo uno.
- Cualquier pantalla donde algo no coincidió con la guía (sin claves ni tokens).

Con eso te paso el M2: endurecer la VM con `deploy/bin/host-setup.sh` (SSH, firewall,
actualizaciones automáticas, Docker) — lo corrés vos, yo no tengo acceso a la VM.
