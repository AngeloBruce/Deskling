// =============================================================================
// brain.js — El "cerebro" de Clawd.
//
// Habla con cualquier API compatible con OpenAI (Groq o NVIDIA, las dos tienen
// plan gratis). Recibe un texto con el contexto (qué app usás, qué música suena,
// notificaciones recientes) y, opcionalmente, una captura; devuelve un
// comentario corto con la personalidad de Clawd.
//
// IMPORTANTE: acá llega TODO ya filtrado por guard.js. Este archivo no filtra
// nada por su cuenta; si agregás una fuente nueva de datos, pasala por el guard
// antes de mandarla acá.
// =============================================================================

class Brain {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL     ej: https://api.groq.com/openai/v1
   * @param {string} opts.apiKey      la key del proveedor (sale del .env)
   * @param {string} opts.model       modelo de texto
   * @param {string} opts.visionModel modelo que acepta imágenes (para capturas)
   * @param {string} opts.personality instrucciones de personalidad (system prompt)
   * @param {object} [opts.extra]     campos extra para la API (de config.json → providers.X.extra)
   * @param {object} [opts.visionExtra] lo mismo pero para el modelo de visión
   */
  constructor(opts) {
    this.opts = opts;
    this.history = [];      // últimos comentarios, para que no se repita
    this.backoffUntil = 0;  // si el plan gratis nos frena (429), esperamos hasta acá
    this.visionBrokenUntil = 0; // si la visión falla, la pausamos un rato (ver comment)
    this.lastVisionError = null;
  }

  /** ¿Estamos esperando porque el proveedor nos limitó? */
  isRateLimited() {
    return Date.now() < this.backoffUntil;
  }

  /**
   * Pide un comentario.
   * @param {string} context        texto ya filtrado por el guard
   * @param {string|null} imageUrl  captura como data URL (jpeg base64) o null
   * @param {string} [textContext]  contexto para el respaldo sin imagen (si no, usa `context`)
   * @returns {Promise<string>}     el comentario de Clawd
   */
  async comment(context, imageUrl = null, textContext = context) {
    if (!this.opts.apiKey) throw new Error('NO_KEY');
    if (this.isRateLimited()) throw new Error('RATE_LIMITED');

    // Si el modelo de visión falló hace poco, ni lo intentamos: vamos sin imagen.
    if (imageUrl && Date.now() < this.visionBrokenUntil) imageUrl = null;

    if (imageUrl) {
      try {
        const text = await this.request(context, imageUrl);
        if (text) return text;
        throw new Error('EMPTY'); // respuesta vacía (ej: se le acabaron los tokens pensando)
      } catch (e) {
        if (e.message === 'RATE_LIMITED') throw e;
        // Respaldo: la imagen falló (modelo no disponible, timeout…). Apagamos la
        // visión 30 min y comentamos igual con el texto solo.
        this.lastVisionError = e.message;
        this.visionBrokenUntil = Date.now() + 30 * 60 * 1000;
      }
    }
    return this.request(textContext, null);
  }

  /** Hace la llamada a la API (con o sin imagen). */
  async request(context, imageUrl) {
    // Le recordamos lo último que dijo para que varíe.
    const recent = this.history.length
      ? `\n\nTus últimos comentarios (no los repitas): ${this.history.map((h) => `"${h}"`).join(' | ')}`
      : '';

    // Con imagen, el contenido va como lista [texto, imagen] (formato OpenAI).
    const userContent = imageUrl
      ? [{ type: 'text', text: context + recent }, { type: 'image_url', image_url: { url: imageUrl } }]
      : context + recent;

    const res = await fetch(`${this.opts.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: imageUrl ? this.opts.visionModel : this.opts.model,
        messages: [
          { role: 'system', content: this.opts.personality },
          { role: 'user', content: userContent },
        ],
        // los modelos que "piensan" (gpt-oss) gastan tokens razonando antes de
        // responder; 400 alcanza para pensar poquito + una frase corta
        max_tokens: 400,
        temperature: 0.9,  // un poco de creatividad
        // opciones propias del proveedor: `extra` para el modelo de texto (ej: reasoning_effort)
        // y `visionExtra` para el de imágenes (ej: apagar el "pensamiento" de Nemotron)
        ...(imageUrl ? this.opts.visionExtra || {} : this.opts.extra || {}),
      }),
      signal: AbortSignal.timeout(25000), // si tarda más de 25 s, cortamos
    });

    // 429 = "pará un poco". Respetamos el retry-after (o 60 s por defecto).
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      this.backoffUntil = Date.now() + wait * 1000;
      throw new Error('RATE_LIMITED');
    }
    if (!res.ok) {
      // Errores con nombre, para que main.js muestre el mensaje correcto:
      //   BAD_KEY → la key está mal   ·   NO_MODEL → el modelo no existe o se retiró
      if (res.status === 401 || res.status === 403) throw new Error('BAD_KEY');
      if (res.status === 404 || res.status === 410) throw new Error('NO_MODEL');
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^"|"$/g, '');

    // Guardamos los últimos 8 comentarios.
    if (text) this.history.push(text);
    if (this.history.length > 8) this.history.shift();
    return text;
  }
}

module.exports = { Brain };
