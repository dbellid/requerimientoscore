# Levantamiento de requerimientos · Nuevo Core — COOPECAJA R.L.

Herramienta web centralizada para capturar, ajustar y exportar los requerimientos del levantamiento por macroproceso.
Esta versión se despliega en **Netlify**: sitio estático, **Netlify Functions** como API, **Netlify Blobs** como almacenamiento
y una **Edge Function** para la IA, que es opcional.

## Contenido

```
public/                      Aplicación (index.html y librerías de exportación en public/lib)
netlify/functions/api.mjs    API: ingreso, datos, sincronización, eliminaciones con clave y bitácora
netlify/edge-functions/ai.mjs  IA (Anthropic) con respuesta en streaming
netlify/shared/auth.mjs      Usuarios desde variables de entorno y sesiones firmadas
netlify.toml                 Configuración y encabezados de seguridad
.env.example                 Plantilla de variables de entorno
```

## Despliegue

> **Importante:** si arrastra la carpeta al panel de Netlify (*drag & drop*), solo se publica la parte estática: **las funciones no se despliegan** y la aplicación no funciona.
> Use una de estas dos opciones.

**Opción A: repositorio Git (recomendada)**
1. Suba esta carpeta a un repositorio privado de GitHub, GitLab o Bitbucket.
2. En Netlify: *Add new site → Import an existing project* y elija el repositorio. Netlify toma la configuración de `netlify.toml`, así que no hace falta definir comandos de compilación.
3. Configure las variables de entorno (siguiente sección) y vuelva a desplegar.

**Opción B: Netlify CLI**
```bash
npm install
npx netlify-cli login
npx netlify-cli init            # o: npx netlify-cli link   (si el sitio ya existe)
npx netlify-cli deploy --prod
```

No hay que crear ni aprovisionar ninguna base de datos: Netlify Blobs se habilita sola en el sitio. Los datos quedan en el almacén `levantamiento`.

## Variables de entorno

Se configuran en *Site configuration → Environment variables*. **Después de agregar o cambiar una variable hay que volver a desplegar** (*Deploys → Trigger deploy*): las funciones solo leen los valores vigentes al momento del despliegue.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ADMIN_NAME1`, `ADMIN_PASSWORD1` | Sí | Usuario y clave. Agregue más con `ADMIN_NAME2`/`ADMIN_PASSWORD2`, `ADMIN_NAME3`/`ADMIN_PASSWORD3`, … (hasta 200; se admiten huecos en la numeración). El usuario no distingue mayúsculas; la clave sí. |
| `SESSION_SECRET` | Recomendada | Cadena aleatoria de 32 caracteres o más para firmar las sesiones. Si no se define, se deriva de las credenciales, y cambiar cualquier clave cierra todas las sesiones. |
| `SESSION_HOURS` | No | Duración de la sesión en horas (1 a 72; por defecto 10). |
| `ANTHROPIC_API_KEY` | No | Activa las funciones de IA. Sin esta variable los botones de IA aparecen deshabilitados. |
| `ANTHROPIC_MODEL` | No | Modelo de IA. Por defecto `claude-sonnet-4-5`; cámbielo si su cuenta usa otro. |
| `ANTHROPIC_MAX_TOKENS` | No | Límite de salida por análisis (por defecto 16000). |

Para generar `SESSION_SECRET` puede usar: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

- **Dar de baja a un usuario:** elimine su par de variables y vuelva a desplegar. Su sesión deja de ser válida en la siguiente solicitud.
- **Cambiar una clave:** modifique la variable y vuelva a desplegar.

## Seguridad implementada

- **Ingreso:** pantalla de usuario y clave. La clave se compara en tiempo constante.
- **Bloqueo:** 5 intentos fallidos bloquean al usuario durante 10 minutos.
- **Sesión:** cookie `HttpOnly`, `Secure`, `SameSite=Strict`, firmada con HMAC-SHA256.
- **Eliminaciones con clave:** eliminar macroprocesos, subprocesos, actividades, riesgos y requerimientos pide la clave del usuario. **El servidor lo verifica**, no solo la pantalla. Restaurar un respaldo JSON también pide la clave.
- **Códigos no reutilizables:** el código de un requerimiento eliminado no se vuelve a asignar.
- **Encabezados de seguridad:** CSP restrictiva, `X-Frame-Options: DENY` y `nosniff`.
- **Bitácora del lado del servidor:** registra ingresos, salidas, intentos fallidos, claves incorrectas, creaciones, modificaciones (con valor anterior y nuevo), eliminaciones y restauraciones. Las ediciones consecutivas de una persona sobre un mismo registro, con menos de 3 minutos entre ellas, se agrupan en una línea. Se consulta y exporta a Excel en la pestaña **Bitácora**.

**Limitaciones que conviene conocer:**
- Las claves quedan en texto plano dentro de las variables de entorno de Netlify. Cualquier persona con acceso de administración al sitio en Netlify puede verlas, igual que los datos de Blobs. Restrinja ese acceso.
- No hay roles: todos los usuarios configurados pueden editar y eliminar (con su clave).
- La bitácora no se puede editar desde la aplicación, pero un administrador del sitio en Netlify sí tiene acceso al almacenamiento. No equivale a un registro inmutable certificado.
- Usar la IA envía el texto (transcripciones, requerimientos) a la API de Anthropic. Valide con Cumplimiento y Seguridad de la Información que esto se ajuste a las políticas de COOPECAJA y a la normativa de tercerización y gestión de datos de SUGEF/CONASSIF antes de habilitarla. No pegue datos personales de asociados.

## Funcionamiento

- **Sincronización:** cada navegador consulta los cambios cada 8 segundos (y al volver a la pestaña). Cada guardado fusiona solo los campos cambiados, con escrituras condicionales de Blobs, así que dos personas pueden editar campos distintos de un mismo formulario sin pisarse.
- **Reglas por requerimiento:** cada requerimiento tiene una sección «Reglas» para registrar campos obligatorios o condicionales, alertas, validaciones, cálculos, valores por defecto, restricciones, aprobaciones o notificaciones (elemento, tipo, condición, comportamiento esperado y motivo). Eliminar una regla pide la clave.
- **Revisiones de IA guardadas:** cada revisión (en lote desde el catálogo o individual desde el requerimiento) se guarda en el requerimiento, con fecha, autor, severidad, hallazgos, cambios y reglas sugeridas, y la decisión tomada (aplicada, parcial, descartada). Se conservan las 10 más recientes por requerimiento y se muestran al final de su ficha.
- **Exportar:** un solo botón con selección de formato: Excel, Word, PDF o respaldo JSON. Excel incluye hojas de Reglas y Revisiones IA.
- **Migrar desde la versión en claude.ai:** en el artefacto, exporte → «Respaldo JSON». Aquí, «Importar» → elija el archivo `.json` y confirme con su clave.
- **Importación de formularios Word:** igual que en la versión anterior. Solo completa campos vacíos, salvo que marque «Sobrescribir».

## Respaldo recomendado

Netlify Blobs no tiene versiones ni papelera. Programe una descarga periódica del «Respaldo JSON», por ejemplo semanal o antes de cada taller, y de la bitácora en Excel.
