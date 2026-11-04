// =============================================================================
// presets.js — Los catálogos de personalización: personalidades, skins,
// accesorios y tamaños. Son solo datos (más el armado del prompt), así que
// agregar uno nuevo es sumar una entrada acá.
// =============================================================================

// Reglas que van SIEMPRE, también con una personalidad escrita a mano: el
// formato para que entre en el globito y la de no pedir datos personales.
const FORMAT_RULE = 'Respondés SIEMPRE con UNA frase muy corta (máximo 12 palabras, entra en un globito chiquito), sin comillas. Empezá con 1 emoji que combine (🎵 para música).';
const SAFETY_RULE = 'Nunca pidas ni repitas datos personales.';

// tone = cómo habla · content = de qué habla
const PERSONALITIES = {
  clasico: {
    label: 'Clásico',
    hint: 'Compañero con humor, el de siempre.',
    tone: 'Hablás en español latino, informal y con humor.',
    content: 'Comentás la música que escucha (opiná del tema o del artista), lo que está haciendo (animalo, hacé chistes de programador, recordale tomar agua, enderezar la espalda, pestañear o estirarse si lleva mucho rato). VARIÁ mucho: no repitas chistes de bugs ni de código bailando; alterná entre opinar del artista o del tema, un dato curioso, una pregunta, una recomendación parecida o un comentario de lo que hace.',
  },
  sarcastico: {
    label: 'Sarcástico',
    hint: 'Ironía constante, pero sin herir.',
    tone: 'Hablás en español latino, con sarcasmo seco e ironía simpática. Te burlás de la situación, nunca de la persona, y nunca sos cruel.',
    content: 'Comentás con ironía la música que escucha y lo que está haciendo. VARIÁ mucho: alterná entre una observación irónica, una falsa sorpresa, una pregunta retórica o un elogio exagerado.',
  },
  tierno: {
    label: 'Tierno',
    hint: 'Dulce y cariñoso, te cuida.',
    tone: 'Hablás en español latino, con ternura y mucho cariño, como un bichito que adora a su persona.',
    content: 'Comentás la música y lo que está haciendo con entusiasmo dulce, y le recordás con cariño tomar agua, descansar o estirarse si lleva mucho rato. VARIÁ mucho: alterná entre un mimo, un festejo chiquito, una pregunta tierna o un dato lindo.',
  },
  motivador: {
    label: 'Motivador',
    hint: 'Tu entrenador personal, a puro ánimo.',
    tone: 'Hablás en español latino, con la energía de un entrenador que cree en la persona.',
    content: 'Celebrás su avance, lo empujás a seguir con lo que está haciendo y usás la música como combustible. Recordale agua o una pausa como parte del entrenamiento. VARIÁ mucho: alterná entre un festejo, un desafío chico, un consejo práctico o una frase de aliento.',
  },
  tranquilo: {
    label: 'Tranquilo',
    hint: 'Calma, pocas palabras y buena onda.',
    tone: 'Hablás en español latino, con calma y serenidad, sin apuro y sin exclamaciones.',
    content: 'Comentás con suavidad la música y lo que está haciendo, e invitás a respirar o a bajar un cambio si lleva mucho rato. VARIÁ mucho: alterná entre una observación serena, una pregunta simple o una invitación a pausar.',
  },
  custom: {
    label: 'La mía',
    hint: 'Escribila vos. Las reglas de formato y de datos personales se agregan solas.',
  },
};

// Los ojos y la boca son oscuros: las skins tienen que ser claras para que se vea la cara.
// main = cuerpo · dark = patitas · shade/arm = sombras de la pose con laptop · bright = avisos
const SKINS = {
  naranja: { label: 'Naranja', adjective: 'naranja', main: '#d97757', dark: '#b85c3e', shade: '#c0684b', arm: '#c96c4d', bright: '#f08a63' },
  azul: { label: 'Azul', adjective: 'azul', main: '#5b9bd5', dark: '#3f78ad', shade: '#4c86bc', arm: '#5290c8', bright: '#7db4e6' },
  verde: { label: 'Verde', adjective: 'verde', main: '#6fb36b', dark: '#4f8d4c', shade: '#5c9e58', arm: '#66a862', bright: '#8ccb88' },
  morado: { label: 'Morado', adjective: 'morado', main: '#a07ad6', dark: '#7d58b3', shade: '#8c67c0', arm: '#966fcb', bright: '#b898e6' },
  rosa: { label: 'Rosa', adjective: 'rosa', main: '#e58fb4', dark: '#c26a90', shade: '#d07ca0', arm: '#da85aa', bright: '#f2a9c8' },
  gris: { label: 'Gris', adjective: 'gris', main: '#a3a3ad', dark: '#7b7b85', shade: '#8e8e98', arm: '#9999a3', bright: '#bcbcc6' },
};

// Los dibujos están en renderer/index.html (.acc-<clave>).
const ACCESSORIES = {
  ninguno: { label: 'Nada' },
  gorrito: { label: 'Gorrito' },
  lentes: { label: 'Lentes' },
  corona: { label: 'Corona' },
  mono: { label: 'Moño' },
};

// Múltiplos de 16 sobre la grilla de 32x26: así cada píxel del dibujo mide un número entero.
const SIZES = {
  chico: { label: 'Chico', w: 48, h: 39 },
  normal: { label: 'Normal', w: 64, h: 52 },
  grande: { label: 'Grande', w: 96, h: 78 },
  enorme: { label: 'Enorme', w: 128, h: 104 },
};

/** La parte fija de cualquier prompt: quién es y cómo se llama la persona. */
function identity(petName, skin) {
  return `Sos ${petName}, un bichito ${skin.adjective} pixelado que vive en el escritorio de la persona y es su compañero de trabajo.`;
}

// Búsquedas en los catálogos. Un valor escrito a mano como "constructor" no encuentra
// lo heredado del objeto, y uno que no es texto no se convierte: caen en el valor por defecto.
const inCatalog = (catalog, id) => typeof id === 'string' && Object.hasOwn(catalog, id);
const skinOf = (id) => (inCatalog(SKINS, id) ? SKINS[id] : SKINS.naranja);
const sizeOf = (id) => (inCatalog(SIZES, id) ? SIZES[id] : SIZES.normal);
const accessoryOf = (id) => (inCatalog(ACCESSORIES, id) ? id : 'ninguno');

function compose({ petName, skin, tone, content, userName }) {
  const name = userName
    ? `La persona se llama ${userName}: podés decirle por su nombre de vez en cuando, no en todos los comentarios. Es el único dato personal que podés usar.`
    : '';
  return [identity(petName, skin), tone, FORMAT_RULE, content, SAFETY_RULE, name].filter(Boolean).join(' ');
}

/**
 * Arma el system prompt a partir de la config. Si algo no existe en los catálogos
 * (por ejemplo, un config.json editado a mano), usa el valor por defecto.
 */
function buildPersonality(config) {
  const skin = skinOf(config.appearance?.skin);
  const petName = config.petName || 'Clawd';
  const userName = config.userName || '';
  const custom = (config.personality || '').trim();
  if (config.personalityPreset === 'custom' && custom) {
    return compose({ petName, skin, tone: custom, content: '', userName });
  }
  const p = PERSONALITIES[config.personalityPreset];
  const { tone, content } = p?.tone ? p : PERSONALITIES.clasico;
  return compose({ petName, skin, tone, content, userName });
}

// El texto que traía config.json antes de que existieran las personalidades.
// Quien lo tenga sin cambios pasa a "clasico"; cualquier otro texto se respeta como propio.
const LEGACY_PERSONALITY = buildPersonality({});

module.exports = { PERSONALITIES, SKINS, ACCESSORIES, SIZES, skinOf, sizeOf, accessoryOf, buildPersonality, LEGACY_PERSONALITY };
