/**
 * Model Registry - Merged from DesignArena registry + Agon models
 *
 * Two invocation paths:
 *   1. Agon testing endpoint (34 models) - EXACT invocation
 *   2. Tournament system (all 456+ models) - pool-based with forcedModelId hint
 */
const https = require('https');
const HOST = 'www.designarena.ai';

function getJSON(path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: HOST, path, timeout: 30000 }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

class ModelRegistry {
  constructor() {
    this.models = [];
    this.agonModels = [];
    this.registryData = {};
    this.modelMap = new Map();
    this.aliasMap = new Map();
    this.modelCategories = new Map(); // modelId -> [{arena, category}]
    this.lastRefresh = null;
    this.timer = null;
  }

  async refresh() {
    const [registry, agon] = await Promise.allSettled([
      getJSON('/api/registry'),
      getJSON('/api/agon/api/models')
    ]);

    if (registry.status === 'fulfilled') this.registryData = registry.value;
    if (agon.status === 'fulfilled') this.agonModels = agon.value.models || [];

    this._buildUnifiedList();
    this.lastRefresh = new Date();
    return this.models;
  }

  _buildUnifiedList() {
    this.models = [];
    this.modelMap.clear();
    this.aliasMap.clear();
    this.modelCategories.clear();
    const seen = new Set();

    // 1. Agon-compatible models (exact invocation)
    for (const m of this.agonModels) {
      const id = m.model_id;
      const info = {
        id, object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider || 'designarena',
        display_name: m.display_name,
        context_window: m.context_window,
        pricing: { input_per_1k: m.input_cost_per_1k, output_per_1k: m.output_cost_per_1k },
        agon_compatible: true,
        invocation_path: 'agon_testing'
      };
      this.models.push(info);
      this.modelMap.set(id, info);
      seen.add(id);
    }

    // 2. Registry models (tournament-based invocation)
    const regModels = this.registryData.models || {};
    for (const [id, m] of Object.entries(regModels)) {
      if (seen.has(id)) continue;

      // Collect categories
      const categories = [];
      const arenas = m.arenas || {};
      for (const [arena, cats] of Object.entries(arenas)) {
        if (Array.isArray(cats)) {
          for (const cat of cats) {
            categories.push({ arena, category: cat });
          }
        }
      }

      const info = {
        id, object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider || 'designarena',
        display_name: m.displayName || m.name || id,
        context_window: m.contextWindow || 0,
        active: m.active !== false,
        open_source: m.openSource || false,
        categories,
        invocation_path: 'tournament',
        agon_compatible: false
      };

      this.models.push(info);
      this.modelMap.set(id, info);
      this.modelCategories.set(id, categories);
      seen.add(id);
    }

    // Build aliases
    for (const m of this.models) {
      const add = (alias) => { if (alias && !this.aliasMap.has(alias)) this.aliasMap.set(alias, m.id); };
      add(m.id.toLowerCase());
      add(m.display_name.toLowerCase());
      add(m.id.toLowerCase().replace(/[.-]/g, ''));
      add(m.id.toLowerCase().replace(/[.-]/g, ' '));
    }

    console.log('Models: ' + this.agonModels.length + ' Agon + ' +
                (this.models.length - this.agonModels.length) + ' tournament = ' +
                this.models.length + ' total');
  }

  resolveModelId(input) {
    if (!input) return null;
    const key = String(input).trim().toLowerCase();
    if (this.modelMap.has(key)) return key;
    if (this.aliasMap.has(key)) return this.aliasMap.get(key);
    for (const [alias, id] of this.aliasMap) {
      if (alias.includes(key) || key.includes(alias)) return id;
    }
    for (const m of this.models) {
      if (m.id.toLowerCase().includes(key)) return m.id;
    }
    return null;
  }

  getModelInfo(modelId) { return this.modelMap.get(modelId) || null; }

  getBestCategory(modelId) {
    const cats = this.modelCategories.get(modelId) || [];
    if (cats.length === 0) return { arena: 'models', category: 'website' };

    // Prefer text-oriented categories
    const textCats = ['website', 'uicomponent', 'agon_webapps'];
    for (const pref of textCats) {
      const match = cats.find(c => c.category === pref);
      if (match) return match;
    }

    // Prefer models arena over agents/builders
    const modelsCat = cats.find(c => c.arena === 'models');
    if (modelsCat) return modelsCat;

    return cats[0];
  }

  getOpenAIList() {
    return {
      object: 'list',
      data: this.models.filter(m => m.agon_compatible).map(m => ({
        id: m.id, object: 'model', created: m.created,
        owned_by: m.owned_by, display_name: m.display_name,
        ...(m.context_window ? { context_window: m.context_window } : {}),
        ...(m.pricing ? { pricing: m.pricing } : {}),
        invocation_path: m.invocation_path || 'tournament',
        agon_compatible: m.agon_compatible || false
      }))
    };
  }

  startAutoRefresh(sec) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh().catch(() => {}), (sec || 300) * 1000);
    return this.refresh();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

module.exports = ModelRegistry;
