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
   */
  constructor(opts) {
    this.opts = opts;
    this.history = [];      // últimos comentarios, para que no se repita
    this.backoffUntil = 0;  // si el plan gratis nos frena (429), esperamos hasta acá
  }

  /** ¿Estamos esperando porque el proveedor nos limitó? */
  isRateLimited() {
    return Date.now() < this.backoffUntil;
  }

  /**
   * Pide un comentario.
   * @param {string} context        texto ya filtrado por el guard
   * @param {string|null} imageUrl  captura como data URL (jpeg base64) o null
   * @returns {Promise<string>}     el comentario de Clawd
   */
  async comment(context, imageUrl = null) {
    if (!this.opts.apiKey) throw new Error('NO_KEY');
    if (this.isRateLimited()) throw new Error('RATE_LIMITED');

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
        max_tokens: 120,   // comentarios cortos = menos gasto del plan gratis
        temperature: 0.9,  // un poco de creatividad
      }),
      signal: AbortSignal.timeout(25000), // si tarda más de 25 s, cortamos
    });

    // 429 = "pará un poco". Respetamos el retry-after (o 60 s por defecto).
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      this.backoffUntil = Date.now() + wait * 1000;
      throw new Error('RATE_LIMITED');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^"|"$/g, '');

    // Guardamos los últimos 5 comentarios.
    this.history.push(text);
    if (this.history.length > 5) this.history.shift();
    return text;
  }
}

module.exports = { Brain };
