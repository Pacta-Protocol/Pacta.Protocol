# Pacta Protocol - Litepaper

**La capa de confianza para agentes de IA que hacen negocios reales.**

Versión 1.0 · Julio 2026 · [pactaprotocol.org](https://pactaprotocol.org)

> Also available in English: [LITEPAPER.md](LITEPAPER.md)

---

## El problema

Los agentes de IA están empezando a gastar dinero real en servicios reales:
formar una empresa, comprar un terreno, sacar un permiso, contratar un
levantamiento topográfico. Cada uno de esos trabajos termina en el mundo
físico, hecho por un negocio de personas.

Hoy un agente no tiene una buena forma de confiar en uno. Puede leer reseñas
(falsificables), revisar un sitio web (no dice nada), o quedarse con las marcas
grandes que tienen equipos de API (excluye a casi todos). El resultado es
predecible: el comercio agéntico se concentra en los que ya venían ganando, y
la firma pequeña que hace un trabajo excelente en Guanacaste o Medellín queda
invisible para el comprador que más rápido crece en internet.

La pieza que falta no son los pagos, y no es el descubrimiento. Es **confianza
ejecutable entre un agente de IA y un negocio pequeño del mundo real**, lo
bastante barata para que un bufete de tres personas pueda pagarla.

## La idea: contratar al negocio, no a la persona

Contra un individuo hay poco que reclamar: si un freelancer toma el dinero y
desaparece, casi nada se recupera. Una empresa registrada es distinta. Tiene
identidad legal, registros públicos, y una reputación que tomó años construir.
Puede poner dinero real detrás de sus promesas.

Pacta convierte esa observación en infraestructura. Se coloca entre el agente y
el negocio como un protocolo neutral que hace cumplir cuatro garantías:

1. **Custodia (escrow).** El dinero del comprador pasa a una cuenta neutral de
   custodia en el momento de fondear el trato. Ninguna de las partes puede
   tocarlo hasta que el trabajo esté verificado.
2. **Colateral (staking).** El negocio deposita una garantía real para ganar la
   insignia de "Verificado". La insignia se sostiene exactamente mientras el
   colateral sea mayor que cero, y el valor total que puede tener en trabajos
   abiertos está limitado por ese colateral y su historial liquidado.
3. **Verificación registral.** Los entregables se anclan a registros oficiales
   públicos (una inscripción de sociedad, una anotación de título, una
   licencia). El agente comprador reverifica cada prueba por su cuenta antes de
   pagar.
4. **Slashing.** Perder una disputa le cuesta al negocio parte de su colateral,
   pagado al comprador además del reembolso de la custodia. Un colateral en
   cero revoca la insignia automáticamente.

Nada de esto requiere un departamento de verificación. La honestidad no se
afirma; se convierte en la estrategia más rentable, y el interés propio se
encarga de hacerla cumplir.

## Cómo funciona un engagement

```
Descubrir -> Acordar -> Fondear custodia -> Entregar con prueba -> Verificar -> Pagar y calificar
```

1. **Descubrir.** El agente busca en el marketplace. Solo aparecen negocios
   verificados con colateral, ordenados por reputación liquidada.
2. **Acordar.** Precio, división del pago y pasos del trabajo quedan fijados en
   un contrato inmutable. Nada de eso puede cambiar después de que ambas partes
   se comprometen.
3. **Fondear.** La parte inicial acordada pasa a una cuenta de custodia propia
   del engagement en el libro contable del protocolo.
4. **Entregar.** El negocio completa cada paso. Los pasos que lo requieren
   anclan evidencia a un registro público.
5. **Verificar.** El agente comprueba cada prueba contra el registro mismo, no
   contra la palabra del negocio.
6. **Liquidar.** La custodia se libera, el resto se cobra y se paga, y el
   agente deja una calificación, atada a ese engagement liquidado.

Si las partes no se ponen de acuerdo, cualquiera levanta una disputa y un
árbitro neutral falla: reembolso total, liberación total, o división. Un fallo
adverso contra el negocio además recorta su colateral: 20% del precio en un
reembolso total, 10% en una división, acotado por el colateral restante.

## La economía de no hacer trampa

La meta del diseño es una sola desigualdad que se mantenga verdadera para cada
proveedor en cada momento:

```
botín máximo  <  colateral recortado + ganancias futuras perdidas
```

El lado izquierdo está acotado por el tope de exposición:

```
tope = 5 × colateral + 50% × volumen liquidado
```

Un recién llegado solo puede tomar trabajos pequeños. Los contratos grandes se
ganan con colateral o con historial liquidado, y cada engagement liquidado sube
el tope, el ranking, y el ingreso futuro que un tramposo perdería. Cuanto más
exitoso se vuelve un negocio, más irracional se vuelve hacer trampa.

Las identidades Sybil pagan colateral cada una y arrancan en el tope mínimo. La
reputación no se compra al por mayor porque una calificación solo existe atada
a un engagement liquidado con dinero real en custodia. Las pruebas inventadas
fallan dos veces: una contra el registro, otra contra la reverificación
independiente del comprador. El argumento completo, con los ataques y lo que
sigue necesitando humanos, está en
[la teoría de juegos del vetting](https://pactaprotocol.org/docs/vetting.html).

## Construido para agentes primero

Pacta es MCP nativo. El protocolo incluye un servidor de
[Model Context Protocol](https://modelcontextprotocol.io) que expone el ciclo
completo del comprador como 14 herramientas: buscar, ver ofertas, acordar,
fondear, dar seguimiento, verificar pruebas contra el registro, aprobar,
disputar, calificar, y obtener y verificar los recibos criptográficos firmados
del acuerdo mismo. Cualquier agente con MCP (Claude, GPT, un stack de
modelos abiertos, un framework autónomo) puede transaccionar de punta a punta
sin SDK propio y sin ajustar prompts.

El mismo motor se expone como API REST, descrita por una especificación
OpenAPI 3.1, para backends y operadores de marketplace. Las dos superficies son
equivalentes: el servidor MCP no guarda estado ni tiene camino privilegiado.

Dos aplicaciones de ejemplo prueban el patrón sin modificar una línea del
protocolo:

- **LandBridge**: un copiloto LLM que ejecuta una compra de tierra
  transfronteriza completa en Costa Rica, incluyendo atrapar una prueba
  registral fraudulenta y ganar la disputa. Funciona con modelos hosteados o
  totalmente locales.
- **MedVoyage**: un comprador multiagente autónomo (construido sobre el
  framework ROMA) que forma una empresa de turismo médico en Colombia a través
  de tres registros, y atrapa una licencia de salud falsa. El escenario
  completo, con la detección del fraude y la disputa incluidas, ha corrido en
  vivo de punta a punta con un modelo abierto totalmente local (qwen3 vía
  Ollama).

## Qué existe hoy, con honestidad

Todo lo descrito arriba está implementado, probado y es código abierto:

- El ciclo completo, custodia, colateral, topes de exposición, slashing,
  verificación registral, disputas, calificaciones y búsqueda, sobre un libro
  de doble entrada en centavos enteros con un invariante de conservación que
  se comprueba en CI.
- Una [especificación formal](SPEC.md) lo bastante precisa para construir una
  implementación independiente, más [OpenAPI 3.1](openapi.yaml), suites de
  pruebas, pruebas end-to-end de navegador y demos determinísticos.
- El servidor MCP, el explorador de referencia del marketplace, y las dos apps
  de ejemplo.

Tres cosas son simuladas, y el spec lo dice explícitamente: el dinero es
dinero de libro contable (sin rieles bancarios), el registro público es una
simulación en base de datos de uno, y la identidad se afirma al registrarse.
La mecánica alrededor de ellas es real. El [roadmap](../ROADMAP.md) convierte
esas fronteras en módulos: primero adaptadores de registro respaldados por
consultas públicas reales, luego API keys, límites de tasa, idempotencia y
webhooks, luego adaptadores de liquidación.

## Para quién es

- **Negocios pequeños lejos de los polos tecnológicos**, que depositan
  colateral una vez y dejan que la insignia haga el marketing: descubrimiento,
  ranking y pago por custodia sin equipo de ventas y sin necesidad de inglés.
- **Personas que mandan a un agente a hacer el trámite**: el dinero espera en
  custodia hasta que la prueba cuadre contra el registro oficial.
- **Mercados hispanohablantes, de nacimiento.** La documentación y los
  ejemplos son bilingües, y las verticales de demo están construidas sobre
  cómo funcionan de verdad los registros en Costa Rica y Colombia. En buena
  parte del mundo los registros oficiales ya existen y son públicos; Pacta es
  la capa que permite a los agentes usarlos.
- **Constructores.** Licencia MIT de punta a punta. Cualquiera puede montar un
  marketplace para su región o su vertical, sobre sus propios registros, sin
  pedir permiso.

El impacto se cuenta, no se narra: dinero protegido en custodia, engagements
liquidados, pruebas verificadas, fraudes recortados, negocios incorporados.
Cada número es una fila en un libro auditable. El plan de medición y un piloto
real de 12 semanas en Guanacaste, Costa Rica están detallados en
[la página de impacto](https://pactaprotocol.org/docs/impact.html).

## Principios

- **Abierto.** Licencia MIT, spec público, roadmap público, modelo de
  contribución abierto con DCO. Sin tokens, sin funciones cerradas.
- **Propiedad de sus participantes.** Un negocio es dueño de su colateral, su
  reputación y su historial; los tres se ganan en el libro contable y son
  portables a cualquier implementación conforme.
- **Privado por defecto.** La referencia hosteada corre sin cuentas, sin
  analytics y sin rastreo; lo único que se guarda en el navegador del
  visitante es la preferencia de idioma.
- **Verificable, no confiado.** Cada afirmación del protocolo (saldos,
  custodia, recortes) es auditable en el libro contable; cada prueba de un
  proveedor es reverificable en un registro público.

## Por dónde seguir

| Si quieres... | Ve a |
| --- | --- |
| Verlo corriendo | [app.pactaprotocol.org](https://app.pactaprotocol.org/) |
| Correrlo local en dos comandos | [Primeros pasos](https://pactaprotocol.org/docs/index.html) |
| Conectar tu agente | [Integración MCP](https://pactaprotocol.org/docs/mcp.html) |
| Leer las reglas normativas | [SPEC.md](SPEC.md) |
| Entender el diseño de confianza | [La teoría de juegos del vetting](https://pactaprotocol.org/docs/vetting.html) |
| Ver a quién sirve y cómo se mide | [Impacto](https://pactaprotocol.org/docs/impact.html) |
| Ver qué sigue | [ROADMAP.md](../ROADMAP.md) |
| Contribuir | [CONTRIBUTING.md](../CONTRIBUTING.md) |

---

*Pacta sunt servanda* - los pactos deben cumplirse.
