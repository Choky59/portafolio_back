# Excavación

La tercera pista de Copa Construcción utiliza el concepto simplificado de 900 m. La línea central suavizada mide 900.00024 m. El asfalto conserva 14 m y dos carriles salvo en el puente, donde se ensancha a cuatro carriles de 7 m (28 m en total). Tiene una S técnica y un puente corto de 18 m, con accesos de 12 m y transiciones suaves de 18 m hacia el ancho normal. Los materiales del patio se colocan a mano; se retira la antigua aplanadora y los edificios repartidos al azar.

## Excavadora activable

La placa amarilla con borde cyan está en el carril exterior, 20 m antes del cucharón. Un coche vivo que entre apoyado en ella activa el mecanismo. Hay un aviso de 1.25 s, un barrido del carril exterior de 0.95 s y un regreso de 0.7 s. Después recarga 7 s. Estar detenido sobre la placa no vuelve a activarla: hay que salir y entrar de nuevo.

El cucharón empuja hacia el interior de la excavación con un impulso de 45 m/s y 1 s del efecto existente de deslizamiento por choque. Se compara con los círculos reales del vehículo y solo golpea una vez por coche y barrido. El carril interior queda disponible. Saltar evita el contacto; casco y escudo protegen del empujón.

## Puente frágil

Cada uno de los cuatro carriles tiene una plataforma y un estado independientes. El servidor guarda el carril por el que empieza a entrar el coche y muestra luz ámbar y grietas en ese carril. Espera a que termine de cruzar por el extremo opuesto, incluida la parte trasera de su hitbox. En ese instante cae únicamente el carril de entrada. No hay un temporizador de rotura desde la entrada.

El cálculo incluye los círculos y su radio físico, e interpola el instante de entrada entre dos ticks para identificar el carril inicial. Ese carril queda fijado durante todo el cruce aunque el conductor cambie de carril una o varias veces. La salida completa también se comprueba entre ticks. Detenerse, regresar por donde entró, entrar lateralmente o aparecer en medio no cuentan como completar el cruce. Saltar todo el puente sin apoyarse tampoco lo consume. Un cruce completo de regreso sí cuenta y también conserva su carril de entrada.

La plataforma cae en 0.55 s, permanece abierta 4 s y su aparejo de grúa la repone durante 1.5 s. El suelo vuelve al terminar la reposición y el siguiente cruce puede romperla otra vez. Los cuatro carriles pueden romperse de forma independiente, sin reservar uno como indestructible. Los barandales se colocan en los extremos del nuevo ancho.

El hueco se añade a los barrancos temporales de esa sala. La regla existente elimina a un coche apoyado en él; un vehículo que salta por encima sigue las reglas de aterrizaje existentes. La excavación central también permite provocar caídas empujando a un rival fuera de la pista.

## Sincronización y alcance

Los inicios de ambas activaciones usan el reloj de simulación del servidor. Se envían en el campo opcional `ex` de cada instantánea: `pala`, un inicio de rotura por carril en el arreglo `puente`, y la máscara `pasando` de carriles que se están cruzando. El cliente reconstruye las fases, los huecos y la animación a partir de esos mismos tiempos. La placa no necesita un botón ni mensajes nuevos desde el jugador. Las demás pistas omiten este estado.

Los bots tienen en cuenta el ancho local y pueden escoger un carril exterior si los centrales están ocupados o rotos. Los andamios de los espectadores también se alinean a los cuatro carriles cuando se apunta al puente. Las rondas restauran las plataformas, limpian las activaciones y evitan colocar la parrilla sobre ambas zonas. Cada sala tiene sus propios huecos; nunca se mutan los polígonos estáticos del circuito.

Los parámetros se encuentran en `content/juego/circuitos/excavacion.json`, bajo `excavacion`. La lógica compartida está en `src/juego/compartido/excavacion.ts` y el control autoritativo en `src/juego/servidor/excavacion.ts`. En crash_game se dibujan en `src/juego/render3d/excavacion.js`. Tras modificar datos o lógica compartida, ejecutar `npm run juego:sync` desde crash_game.

No cambian los vehículos, sus estadísticas, la cámara ni los otros mapas. Los nuevos efectos físicos pertenecen exclusivamente a los mecanismos de Excavación.

Validación: `npm test -- --runTestsByPath test/juego.excavacion.test.ts test/juego.copas.test.ts test/juego.circuitos.test.ts` y las suites existentes del juego. En crash_game: `npm run juego:check`, `npm run juego:curvas:test` y `npm run build`.
