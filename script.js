/* ==========================================================================
   Jewel Stage — configurateur de bijoux
   --------------------------------------------------------------------------
   Vanilla JS, aucune dépendance. Souris + tactile via les Pointer Events.

   Trois étapes visibles en même temps :
     1. la chaîne   (un produit d'une collection)
     2. le support  (les variantes de la chaîne choisie : bracelet, collier…)
     3. les charms  (produits d'une collection), glissés librement sur la scène

   Les données produits sont lues UNIQUEMENT depuis le HTML (attributs data-*) :
     Chaîne   [data-jewel-chain]    data-id, data-title
     Variante [data-jewel-variant]  data-chain-id, data-id, data-title, data-image, data-price,
                                    data-stage-cm (largeur réelle représentée par l'image)
     Charm    [data-jewel-charm]    data-id, data-variant-id, data-title, data-image, data-price,
                                    data-width-cm (largeur réelle de l'image du charm),
                                    data-tags (balises Shopify séparées par des virgules, pour le filtre)
                                    Sur Shopify : une vignette par variante (couleur…) d'un même produit.
   data-price est en centimes, comme les prix Shopify ; le prix affiché est déjà formaté dans le HTML.
   Sur Shopify, ce HTML est généré par la section shopify/sections/jewel-stage.liquid.

   Échelle : un charm de 1,6 cm sur une scène qui représente 9 cm occupe 1,6 / 9 de
   la largeur. Changer de support remet donc les charms à la bonne taille.

   Zoom de l'aperçu (de 50 % à 250 %, voir CONFIG) : seule la vue (l'image du support)
   est agrandie en CSS, le fond de scène reste fixe ; les charms gardent leurs
   coordonnées de scène (0–100 %) et sont affichés à travers la vue. Le zoom ne
   change donc rien à la composition.

   Plusieurs configurateurs par page possibles. Dans l'éditeur de thème Shopify, une
   section est (re)montée sur shopify:section:load et démontée sur shopify:section:unload.

   API console (dernier configurateur monté) :
     JewelStage.getComposition(), .selectChain(id), .selectVariant(id), .addCharm(id),
     .removeCharm(uid), .clearCharms(), .filterCharms('balise, autre balise'), .setZoom(zoom)
   ========================================================================== */
(() => {
  'use strict';

  // Le script peut être inclus par plusieurs sections de la même page : une seule exécution suffit.
  if (window.JewelStageLoaded) return;
  window.JewelStageLoaded = true;

  /* ---------- Configuration (comportement uniquement, aucune donnée produit) */

  const CONFIG = {
    selectors: {
      app: '[data-jewel-app]',
      stage: '[data-jewel-stage]',
      chainList: '[data-jewel-chains]',
      chain: '[data-jewel-chain]',
      variantList: '[data-jewel-variants]',
      variant: '[data-jewel-variant]',
      charmList: '[data-jewel-charms]',
      charm: '[data-jewel-charm]',
      charmFilter: '[data-jewel-charm-filter]',
      charmEmpty: '[data-jewel-charm-empty]',
      summary: '[data-jewel-summary]',
      live: '[data-jewel-live]',
      info: '[data-jewel-info]',
      zoom: '[data-jewel-zoom]',
    },
    defaultStageCm: 18,      // si une variante n'a pas de data-stage-cm
    defaultCharmCm: 1.5,     // si un charm n'a pas de data-width-cm
    minScale: 0.3,           // agrandissement/réduction manuelle autour de la taille réelle
    maxScale: 4,
    dragThreshold: 6,        // px de mouvement avant de démarrer un glisser depuis la liste
    touchGhostOffset: 48,    // px : au doigt, le fantôme est décalé vers le haut pour rester visible
    tapTolerance: 8,         // px de mouvement max pour qu'un appui compte comme un clic/tap
    doubleTapDelay: 350,     // ms entre deux taps pour un double-tap / double-clic
    rotateSnap: 15,          // pas de rotation (degrés) avec Maj enfoncée
    wheelZoomSpeed: 0.0015,
    pinchZoomSpeed: 0.01,    // pincement trackpad (molette + Ctrl)
    wheelRotateSpeed: 0.1,   // degrés par pixel de molette
    keyMoveStep: 1,          // % par flèche (×5 avec Maj)
    keyRotateStep: 15,       // degrés (touche R, Maj+R en sens inverse)
    keyScaleFactor: 1.05,
    minZoom: 0.5,            // zoom de l'aperçu : 1 = scène entière ; en dessous, la scène est centrée
    maxZoom: 2.5,            // zoom maximal de l'aperçu (250 %)
    zoomStep: 0.25,          // boutons − / + (50, 75, 100, 125… 250 %)
    viewWheelZoomSpeed: 0.01, // Ctrl + molette ou pincement trackpad, hors d'un charm
    viewWheelMaxDelta: 30,   // px : borne un cran de molette souris, sinon le zoom saute d'un coup
    zoomAnimationMs: 250,    // un peu plus que la transition CSS (.is-zoom-animating)
  };

  const PLACED_SELECTOR = '.placed';

  const ICONS = {
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.35-5.65"/><path d="M20 4v5h-5"/></svg>',
    resize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 11v6h-6M7 13V7h6"/></svg>',
  };

  const HANDLE_LABELS = {
    delete: 'Retirer',
    rotate: 'Faire pivoter',
    resize: 'Redimensionner',
  };

  /* ---------- Utilitaires ---------- */

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round = (value, decimals = 2) => Math.round(value * 10 ** decimals) / 10 ** decimals;
  const normalizeAngle = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const pointFromEvent = (e) => ({ x: e.clientX, y: e.clientY });
  const distanceBetween = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const angleBetween = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const positiveNumber = (value, fallback) => { const n = parseFloat(value); return n > 0 ? n : fallback; };
  const priceCents = (value) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null; };
  const radioOf = (el) => el.querySelector('input[type="radio"]');
  const snapshot = (item) => ({ x: item.x, y: item.y, scale: item.scale, rotation: item.rotation });

  /** Liste sur une ligne : la molette verticale d'une souris la fait défiler à l'horizontale. */
  function enableHorizontalWheel(list) {
    list.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lignes → pixels
      const max = list.scrollWidth - list.clientWidth;
      if ((delta < 0 && list.scrollLeft <= 0) || (delta > 0 && list.scrollLeft >= max - 1)) return; // aux extrémités, la page défile
      e.preventDefault();
      list.scrollLeft += delta;
    }, { passive: false });
  }

  /** Molette normalisée en pixels. */
  function wheelDelta(e) {
    let delta = e.deltaY || e.deltaX; // Maj + molette arrive souvent en deltaX
    if (e.deltaMode === 1) delta *= 33;        // lignes → pixels
    else if (e.deltaMode === 2) delta *= 400;  // pages → pixels
    return delta;
  }

  // « Argenté », « argente », « ARGENTÉ » → même tag
  const normalizeTag = (tag) => tag.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const tagsOf = (el) => (el.dataset.tags || '').split(',').map(normalizeTag).filter(Boolean);

  /* ======================================================================
     Un configurateur : tout ce qui suit dépend d'un élément [data-jewel-app]
     ====================================================================== */

  function mount(app) {
    const stage = app.querySelector(CONFIG.selectors.stage);
    if (!stage) {
      console.warn(`[JewelStage] Aucune scène trouvée (${CONFIG.selectors.stage}).`);
      return null;
    }

    const chainList = app.querySelector(CONFIG.selectors.chainList);
    const variantList = app.querySelector(CONFIG.selectors.variantList);
    const charmList = app.querySelector(CONFIG.selectors.charmList);
    const charmFilter = app.querySelector(CONFIG.selectors.charmFilter);
    const charmEmpty = app.querySelector(CONFIG.selectors.charmEmpty);
    const zoomControls = app.querySelector(CONFIG.selectors.zoom);
    const live = app.querySelector(CONFIG.selectors.live);

    const chainEls = chainList ? [...chainList.querySelectorAll(CONFIG.selectors.chain)] : [];
    const variantEls = variantList ? [...variantList.querySelectorAll(CONFIG.selectors.variant)] : [];

    // Écouteurs posés sur document : retirés au démontage (éditeur de thème Shopify).
    const listeners = new AbortController();
    const { signal } = listeners;

    /* ---------- État (en mémoire uniquement) ---------- */

    /**
     * @typedef {Object} PlacedCharm
     * @property {string} uid        identifiant de cette instance sur la scène
     * @property {string} productId  data-id du charm
     * @property {string} variantId  data-variant-id du charm (pour le panier)
     * @property {string} title
     * @property {string} image
     * @property {number|null} price prix en centimes
     * @property {number} widthCm    largeur réelle de l'image du charm
     * @property {number} scale      agrandissement manuel (1 = taille réelle)
     * @property {number} x          centre, en % de la largeur de la scène (hors zoom)
     * @property {number} y          centre, en % de la hauteur de la scène (hors zoom)
     * @property {number} rotation   en degrés
     * @property {number} z          ordre de superposition
     * @property {HTMLElement} el
     */

    /** @type {Map<string, PlacedCharm>} */
    const placed = new Map();
    const selection = { chain: null, variant: null };
    /** Vue de l'aperçu : zoom (1 = scène entière) et point de la scène au centre du cadre, en %. */
    const view = { zoom: 1, cx: 50, cy: 50 };
    let viewLayer = null;
    let supportImg = null;
    let stageLabel = null;
    let uidCounter = 0;
    let zTop = 0;
    let selectedUid = null;
    let charmDrag = null;     // glisser en cours depuis la liste des charms
    let gesture = null;       // manipulation en cours sur la scène (un charm, ou la vue si uid === null)
    let lastTap = { uid: null, time: 0 };
    let zoomAnimationTimer = 0;

    /* ---------- Coordonnées : écran ↔ cadre (ce qu'on voit) ↔ scène (hors zoom) ---------- */

    function isOverStage(x, y) {
      const r = stage.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    /** Point écran → position dans le cadre de la scène, en %. */
    function framePercent(point, rect = stage.getBoundingClientRect()) {
      return {
        x: ((point.x - rect.left) / rect.width) * 100,
        y: ((point.y - rect.top) / rect.height) * 100,
      };
    }

    const toFrame = (p) => ({ x: (p.x - view.cx) * view.zoom + 50, y: (p.y - view.cy) * view.zoom + 50 });
    const fromFrame = (f) => ({ x: (f.x - 50) / view.zoom + view.cx, y: (f.y - 50) / view.zoom + view.cy });

    /** Coordonnées écran → position sur la scène, en %. */
    const stagePointFromClient = (x, y) => fromFrame(framePercent({ x, y }));

    /** Position sur la scène (%) → coordonnées écran. */
    function clientPointFromStage(p, rect) {
      const f = toFrame(p);
      return { x: rect.left + (f.x / 100) * rect.width, y: rect.top + (f.y / 100) * rect.height };
    }

    /* ======================================================================
       1. Lecture des données (le seul endroit qui connaît le format data-*)
       ====================================================================== */

    function readOptionData(el) {
      const { id = '', title = '', image = '', chainId = '', stageCm, price } = el.dataset;
      return { id, title, image, chainId, stageCm: positiveNumber(stageCm, CONFIG.defaultStageCm), price: priceCents(price) };
    }

    function readCharmData(el) {
      const { id = '', variantId = '', title = '', image = '', widthCm, price } = el.dataset;
      const thumbnail = el.querySelector('img');
      return {
        id,
        variantId,
        title,
        image: image || (thumbnail ? thumbnail.currentSrc || thumbnail.src : ''),
        widthCm: positiveNumber(widthCm, CONFIG.defaultCharmCm),
        price: priceCents(price),
      };
    }

    /* ======================================================================
       2. Étapes 1 et 2 : chaîne, puis support (variantes de cette chaîne)
       ====================================================================== */

    const variantsOf = (chainId) => variantEls.filter((el) => el.dataset.chainId === chainId);

    function selectChain(chainId, { silent = false } = {}) {
      const chainEl = chainEls.find((el) => el.dataset.id === String(chainId));
      if (!chainEl) return;
      selection.chain = readOptionData(chainEl);
      const radio = radioOf(chainEl);
      if (radio) radio.checked = true;

      const options = variantsOf(selection.chain.id);
      variantEls.forEach((el) => { el.hidden = el.dataset.chainId !== selection.chain.id; });

      // On garde le même support si la nouvelle chaîne le propose (ex. « Collier » → « Collier »).
      const previousTitle = selection.variant ? selection.variant.title : null;
      const next = options.find((el) => previousTitle && el.dataset.title === previousTitle)
        || options.find((el) => radioOf(el) && radioOf(el).checked)
        || options[0];

      if (next) {
        selectVariant(next.dataset.id, { silent: true });
      } else {
        selection.variant = null;
        renderSupport();
        updateSummaries();
      }
      if (!silent) announceSelection();
    }

    function selectVariant(variantId, { silent = false } = {}) {
      const variantEl = variantEls.find((el) => el.dataset.id === String(variantId));
      if (!variantEl) return;
      // Une variante d'une autre chaîne → on bascule d'abord sur cette chaîne.
      if (!selection.chain || variantEl.dataset.chainId !== selection.chain.id) {
        selection.variant = readOptionData(variantEl);
        selectChain(variantEl.dataset.chainId, { silent });
        return;
      }
      selection.variant = readOptionData(variantEl);
      const radio = radioOf(variantEl);
      if (radio) radio.checked = true;
      renderSupport();
      renderAllCharms(); // nouvelle échelle de scène
      updateSummaries();
      if (!silent) announceSelection();
    }

    function onChainChange(e) {
      const el = e.target.closest(CONFIG.selectors.chain);
      if (el) selectChain(el.dataset.id);
    }

    function onVariantChange(e) {
      const el = e.target.closest(CONFIG.selectors.variant);
      if (el) selectVariant(el.dataset.id);
    }

    const currentStageCm = () => (selection.variant ? selection.variant.stageCm : CONFIG.defaultStageCm);

    function announceSelection() {
      const parts = [selection.chain && selection.chain.title, selection.variant && selection.variant.title].filter(Boolean);
      announce(`${parts.join(', ')} sélectionné.`);
    }

    /* ======================================================================
       3. Rendu
       ====================================================================== */

    function renderSupport() {
      const variant = selection.variant;
      if (!variant || !variant.image) {
        supportImg.hidden = true;
      } else {
        supportImg.hidden = false;
        if (supportImg.getAttribute('src') !== variant.image) {
          supportImg.classList.add('is-loading');
          supportImg.src = variant.image;
        }
        supportImg.alt = `${selection.chain.title} — ${variant.title}`;
      }
      stageLabel.textContent = [selection.chain && selection.chain.title, variant && variant.title].filter(Boolean).join(' · ');
    }

    function setSummary(name, text) {
      const el = [...app.querySelectorAll(CONFIG.selectors.summary)].find((s) => s.dataset.jewelSummary === name);
      if (el) el.textContent = text;
    }

    function updateSummaries() {
      setSummary('chain', selection.chain ? selection.chain.title : '');
      setSummary('variant', selection.variant ? selection.variant.title : '');
      const n = placed.size;
      setSummary('charms', n === 0 ? 'Aucun pour l’instant' : `${n} charm${n > 1 ? 's' : ''}`);
    }

    function createCharmElement(item) {
      const el = document.createElement('div');
      el.className = 'placed';
      el.dataset.uid = item.uid;
      el.tabIndex = 0;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', item.title);

      const img = document.createElement('img');
      img.className = 'placed__img';
      img.src = item.image;
      img.alt = item.title;
      img.draggable = false;
      el.append(img);

      for (const handle of ['delete', 'rotate', 'resize']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `placed__handle placed__handle--${handle}`;
        button.dataset.handle = handle;
        button.tabIndex = handle === 'delete' ? 0 : -1; // rotation/taille ont des raccourcis clavier
        button.setAttribute('aria-label', `${HANDLE_LABELS[handle]} : ${item.title}`);
        button.innerHTML = ICONS[handle];
        el.append(button);
      }
      return el;
    }

    /** Largeur d'un charm, en % de la scène (hors zoom), selon l'échelle du support choisi. */
    const widthPercent = (item) => (item.widthCm / currentStageCm()) * 100 * item.scale;

    /** Le charm est affiché à travers la vue : position et largeur suivent le zoom, les poignées gardent leur taille. */
    function render(item) {
      const { style } = item.el;
      const { x, y } = toFrame(item);
      style.left = `${x}%`;
      style.top = `${y}%`;
      style.width = `${widthPercent(item) * view.zoom}%`;
      style.zIndex = String(item.z);
      style.transform = `translate(-50%, -50%) rotate(${item.rotation}deg)`;
    }

    function renderAllCharms() {
      for (const item of placed.values()) render(item);
    }

    function updateStageState() {
      updateSummaries();
    }

    function announce(message) {
      if (live) live.textContent = message;
    }

    /* ======================================================================
       4. Zoom de l'aperçu
       ====================================================================== */

    const zoomLabel = () => `${Math.round(view.zoom * 100)} %`;

    /** Zoomé, la vue ne sort pas de la scène ; à 100 % et en dessous, la scène reste centrée. */
    function clampView() {
      view.zoom = clamp(view.zoom, CONFIG.minZoom, CONFIG.maxZoom);
      const half = Math.min(50, 50 / view.zoom);
      view.cx = clamp(view.cx, half, 100 - half);
      view.cy = clamp(view.cy, half, 100 - half);
    }

    function renderView() {
      const { zoom, cx, cy } = view;
      viewLayer.style.transform = `translate(${50 - cx * zoom}%, ${50 - cy * zoom}%) scale(${zoom})`;
      stage.classList.toggle('is-zoomed', zoom > 1);
      renderAllCharms();
      renderZoomControls();
    }

    function renderZoomControls() {
      if (!zoomControls) return;
      const atLimit = {
        out: view.zoom <= CONFIG.minZoom,
        reset: Math.abs(view.zoom - 1) < 1e-3,
        in: view.zoom >= CONFIG.maxZoom,
      };
      zoomControls.querySelectorAll('[data-zoom]').forEach((button) => {
        button.setAttribute('aria-disabled', String(Boolean(atLimit[button.dataset.zoom])));
      });
      const level = zoomControls.querySelector('[data-zoom="reset"]');
      if (level) level.textContent = zoomLabel();
    }

    /**
     * Change le zoom en gardant immobile le point de la scène affiché sous `anchor`
     * (en % du cadre ; par défaut le centre).
     */
    function setZoom(zoom, anchor = { x: 50, y: 50 }) {
      const target = fromFrame(anchor);
      view.zoom = clamp(zoom, CONFIG.minZoom, CONFIG.maxZoom);
      view.cx = target.x - (anchor.x - 50) / view.zoom;
      view.cy = target.y - (anchor.y - 50) / view.zoom;
      clampView();
      renderView();
    }

    function stopZoomAnimation() {
      clearTimeout(zoomAnimationTimer);
      stage.classList.remove('is-zoom-animating');
    }

    /** Boutons − / 100 % / + : par paliers ronds (un zoom au pincement de 137 % passe à 150 % ou 125 %). */
    function onZoomClick(e) {
      const button = e.target.closest('[data-zoom]');
      if (!button || button.getAttribute('aria-disabled') === 'true') return;
      const steps = view.zoom / CONFIG.zoomStep;
      const next = {
        in: (Math.floor(steps + 1e-6) + 1) * CONFIG.zoomStep,
        out: (Math.ceil(steps - 1e-6) - 1) * CONFIG.zoomStep,
        reset: 1,
      }[button.dataset.zoom];
      if (next === undefined) return;

      stage.classList.add('is-zoom-animating');
      clearTimeout(zoomAnimationTimer);
      zoomAnimationTimer = setTimeout(stopZoomAnimation, CONFIG.zoomAnimationMs);
      setZoom(next);
      announce(`Zoom ${zoomLabel()}.`);
    }

    /* ======================================================================
       5. Actions sur les charms
       ====================================================================== */

    function addCharm(data, position) {
      const item = {
        uid: `charm-${++uidCounter}`,
        productId: data.id,
        variantId: data.variantId,
        title: data.title,
        image: data.image,
        price: data.price,
        widthCm: data.widthCm,
        scale: 1,
        x: clamp(position.x, 0, 100),
        y: clamp(position.y, 0, 100),
        rotation: 0,
        z: ++zTop,
        el: null,
      };
      item.el = createCharmElement(item);
      placed.set(item.uid, item);
      render(item);
      stage.append(item.el);
      select(item.uid);
      updateStageState();
      announce(`${item.title} ajouté.`);
      return item;
    }

    /** Ajout par simple clic/tap/clavier : au centre de la vue, légèrement décalé à chaque ajout. */
    function addCharmAtCenter(data) {
      const offset = ((placed.size % 5) * 4 - 8) / view.zoom;
      return addCharm(data, { x: view.cx + offset, y: view.cy + offset });
    }

    /** id de variante (vignette précise) ou de produit (sa première vignette). */
    function addCharmById(id) {
      if (!charmList) return null;
      const cards = [...charmList.querySelectorAll(CONFIG.selectors.charm)];
      const el = cards.find((c) => c.dataset.variantId === String(id))
        || cards.find((c) => c.dataset.id === String(id));
      return el ? addCharmAtCenter(readCharmData(el)).uid : null;
    }

    function removeCharm(uid) {
      const item = placed.get(uid);
      if (!item) return;
      if (gesture && gesture.uid === uid) endGesture();
      item.el.remove();
      placed.delete(uid);
      if (selectedUid === uid) selectedUid = null;
      updateStageState();
      announce(`${item.title} retiré.`);
    }

    function clearCharms() {
      endGesture();
      for (const item of placed.values()) item.el.remove();
      placed.clear();
      selectedUid = null;
      updateStageState();
      announce('Tous les charms ont été retirés.');
    }

    function select(uid, { focus = true } = {}) {
      const previous = selectedUid ? placed.get(selectedUid) : null;
      if (previous && previous.uid !== uid) previous.el.classList.remove('is-selected');

      const item = uid ? placed.get(uid) : null;
      selectedUid = item ? item.uid : null;
      if (!item) return;

      item.el.classList.add('is-selected');
      if (focus && document.activeElement !== item.el) item.el.focus({ preventScroll: true });
    }

    function bringToFront(item) {
      if (item.z === zTop) return;
      item.z = ++zTop;
      item.el.style.zIndex = String(item.z);
    }

    /** État exportable (ex. futur ajout au panier Shopify : variante de la chaîne + variantes des charms). */
    function getComposition() {
      const charms = [...placed.values()]
        .sort((a, b) => a.z - b.z)
        .map((item, index) => ({
          productId: item.productId,
          variantId: item.variantId,
          title: item.title,
          price: item.price,
          x: round(item.x),
          y: round(item.y),
          scale: round(item.scale),
          widthPercent: round(widthPercent(item)),
          rotation: round(item.rotation, 1),
          layer: index + 1,
        }));
      return {
        chain: selection.chain && {
          productId: selection.chain.id,
          title: selection.chain.title,
          variantId: selection.variant ? selection.variant.id : null,
          variantTitle: selection.variant ? selection.variant.title : null,
          variantPrice: selection.variant ? selection.variant.price : null,
          stageCm: currentStageCm(),
        },
        charms,
      };
    }

    /* ======================================================================
       6. Filtre des charms (tags Shopify)
       ====================================================================== */

    /**
     * Affiche les charms portant l'une de ces balises (séparées par des virgules) ; vide = tous.
     * Les charms déjà posés ne sont pas touchés.
     */
    function filterCharms(tags = '') {
      if (!charmList) return;
      const wanted = tags.split(',').map(normalizeTag).filter(Boolean);
      let visible = 0;
      charmList.querySelectorAll(CONFIG.selectors.charm).forEach((card) => {
        const show = wanted.length === 0 || tagsOf(card).some((tag) => wanted.includes(tag));
        card.hidden = !show;
        if (show) visible++;
      });
      if (charmEmpty) charmEmpty.hidden = visible > 0;
      charmList.scrollTop = 0;
      charmList.scrollLeft = 0;
    }

    function onCharmFilterChange(e) {
      if (!e.target.matches('input[type="radio"]')) return;
      filterCharms(e.target.value);
      const label = e.target.closest('label');
      announce(`Filtre : ${label ? label.textContent.trim() : 'tous'}.`);
    }

    /* ======================================================================
       7. Glisser un charm de la liste vers la scène
       ====================================================================== */

    function prepareCharmCard(card) {
      const { title } = readCharmData(card);
      if (!card.hasAttribute('tabindex')) card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Ajouter ${title}`);
      if (!card.hasAttribute('title')) card.title = title; // le nom est tronqué sur une ligne dans la grille
      card.querySelectorAll('img').forEach((img) => { img.draggable = false; });
    }

    function onCharmPointerDown(e) {
      const card = e.target.closest(CONFIG.selectors.charm);
      if (!card || charmDrag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      charmDrag = {
        card,
        pointerId: e.pointerId,
        start: pointFromEvent(e),
        offsetY: e.pointerType === 'mouse' ? 0 : -CONFIG.touchGhostOffset,
        data: readCharmData(card),
        ghost: null,
        active: false,
      };
      try { card.setPointerCapture(e.pointerId); } catch (_) { /* pointeur déjà relâché */ }
    }

    function onCharmPointerMove(e) {
      const drag = charmDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;

      if (!drag.active) {
        if (distanceBetween(drag.start, pointFromEvent(e)) < CONFIG.dragThreshold) return;
        startDragGhost(drag);
      }
      e.preventDefault();
      moveDragGhost(drag, e.clientX, e.clientY + drag.offsetY);
    }

    function onCharmPointerUp(e) {
      const drag = charmDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;

      if (drag.active) {
        const x = e.clientX;
        const y = e.clientY + drag.offsetY;
        if (isOverStage(x, y)) addCharm(drag.data, stagePointFromClient(x, y));
      } else {
        addCharmAtCenter(drag.data); // simple clic / tap sur la carte
      }
      endCharmDrag();
    }

    function onCharmKeyDown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest(CONFIG.selectors.charm);
      if (!card) return;
      e.preventDefault();
      addCharmAtCenter(readCharmData(card));
    }

    function startDragGhost(drag) {
      const ghost = document.createElement('div');
      ghost.className = 'jewel-drag-ghost';
      // Le fantôme a la taille qu'aura le charm une fois déposé (à l'échelle du support et du zoom).
      ghost.style.width = `${stage.getBoundingClientRect().width * (drag.data.widthCm / currentStageCm()) * view.zoom}px`;

      const img = document.createElement('img');
      img.src = drag.data.image;
      img.alt = '';
      img.draggable = false;
      ghost.append(img);
      document.body.append(ghost);

      drag.ghost = ghost;
      drag.active = true;
      drag.card.classList.add('is-source');
      document.body.classList.add('jewel-is-dragging');
    }

    function moveDragGhost(drag, x, y) {
      drag.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      stage.classList.toggle('is-drop-target', isOverStage(x, y));
    }

    function endCharmDrag() {
      const drag = charmDrag;
      if (!drag) return;
      if (drag.ghost) drag.ghost.remove();
      drag.card.classList.remove('is-source');
      if (drag.card.hasPointerCapture(drag.pointerId)) drag.card.releasePointerCapture(drag.pointerId);
      stage.classList.remove('is-drop-target');
      document.body.classList.remove('jewel-is-dragging');
      charmDrag = null;
    }

    /* ======================================================================
       8. Manipulation sur la scène : déplacer, redimensionner, tourner, pincer,
          et dans le vide : déplacer la vue zoomée, zoomer à deux doigts
       ====================================================================== */

    function capturePointer(pointerId) {
      try { stage.setPointerCapture(pointerId); } catch (_) { /* pointeur déjà relâché */ }
    }

    function releasePointer(pointerId) {
      if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    }

    function onStagePointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      const handle = e.target.closest('[data-handle]');
      if (handle && handle.dataset.handle === 'delete') return; // géré par l'événement click

      // Un 2e doigt pendant une manipulation → pincement (n'importe où sur la scène) :
      // du charm, ou de la vue si le 1er doigt est arrivé dans le vide.
      if (gesture) {
        if (gesture.pointers.size === 1 && e.pointerType === gesture.pointerType && e.pointerType !== 'mouse') {
          e.preventDefault();
          capturePointer(e.pointerId);
          gesture.pointers.set(e.pointerId, pointFromEvent(e));
          if (gesture.uid) beginPinch();
          else beginViewPinch();
        }
        return;
      }

      stopZoomAnimation();
      const el = e.target.closest(PLACED_SELECTOR);
      const item = el ? placed.get(el.dataset.uid) : null;
      if (!item) {
        select(null); // clic dans le vide : désélection…
        beginPan(e);  // …puis déplacement de la vue zoomée, ou zoom si un 2e doigt arrive
        return;
      }

      e.preventDefault();
      select(item.uid);
      bringToFront(item);
      capturePointer(e.pointerId);

      const point = pointFromEvent(e);
      const rect = stage.getBoundingClientRect();
      const center = clientPointFromStage(item, rect);

      gesture = {
        uid: item.uid,
        mode: handle ? handle.dataset.handle : 'move', // 'move' | 'resize' | 'rotate' | 'pinch'
        pointerType: e.pointerType,
        pointers: new Map([[e.pointerId, point]]),
        rect,
        start: snapshot(item),
        startPoint: point,
        center,
        startAngle: angleBetween(center, point),
        startDistance: Math.max(1, distanceBetween(center, point)),
        moved: false,
      };
      item.el.classList.add('is-active');
    }

    function beginPinch() {
      const item = placed.get(gesture.uid);
      const [a, b] = [...gesture.pointers.values()];
      gesture.mode = 'pinch';
      gesture.rect = stage.getBoundingClientRect();
      gesture.start = snapshot(item);
      gesture.startMid = midpoint(a, b);
      gesture.startAngle = angleBetween(a, b);
      gesture.startDistance = Math.max(1, distanceBetween(a, b));
      gesture.moved = true;
    }

    function beginPan(e) {
      capturePointer(e.pointerId);
      const point = pointFromEvent(e);
      gesture = {
        uid: null,
        mode: 'pan', // 'pan' | 'zoom'
        pointerType: e.pointerType,
        pointers: new Map([[e.pointerId, point]]),
        rect: stage.getBoundingClientRect(),
        startView: { ...view },
        startPoint: point,
        moved: false,
      };
      if (view.zoom > 1) stage.classList.add('is-panning');
    }

    function beginViewPinch() {
      const [a, b] = [...gesture.pointers.values()];
      gesture.mode = 'zoom';
      gesture.rect = stage.getBoundingClientRect();
      gesture.startView = { ...view };
      gesture.startMid = midpoint(a, b);
      gesture.startDistance = Math.max(1, distanceBetween(a, b));
      gesture.moved = true;
    }

    /** Vue : déplacement (souris / un doigt) ou zoom (deux doigts, le point pincé reste sous les doigts). */
    function moveView() {
      const { startView, rect } = gesture;
      Object.assign(view, startView);
      if (gesture.mode === 'zoom') {
        const [a, b] = [...gesture.pointers.values()];
        const target = fromFrame(framePercent(gesture.startMid, rect));
        const mid = framePercent(midpoint(a, b), rect);
        view.zoom = clamp(startView.zoom * (distanceBetween(a, b) / gesture.startDistance), CONFIG.minZoom, CONFIG.maxZoom);
        view.cx = target.x - (mid.x - 50) / view.zoom;
        view.cy = target.y - (mid.y - 50) / view.zoom;
      } else {
        const [point] = gesture.pointers.values();
        view.cx -= ((point.x - gesture.startPoint.x) / rect.width) * 100 / view.zoom;
        view.cy -= ((point.y - gesture.startPoint.y) / rect.height) * 100 / view.zoom;
      }
      clampView();
      renderView();
    }

    function onStagePointerMove(e) {
      if (!gesture || !gesture.pointers.has(e.pointerId)) return;

      const point = pointFromEvent(e);
      gesture.pointers.set(e.pointerId, point);
      if (!gesture.moved && distanceBetween(point, gesture.startPoint) > CONFIG.tapTolerance) {
        gesture.moved = true;
      }

      if (!gesture.uid) {
        moveView();
        return;
      }

      const item = placed.get(gesture.uid);
      if (!item) {
        endGesture();
        return;
      }

      // Déplacements écran → scène : divisés par le zoom (rapports et angles n'en dépendent pas).
      const { start, rect } = gesture;
      const { zoom } = view;
      switch (gesture.mode) {
        case 'move':
          item.x = clamp(start.x + ((point.x - gesture.startPoint.x) / rect.width) * 100 / zoom, 0, 100);
          item.y = clamp(start.y + ((point.y - gesture.startPoint.y) / rect.height) * 100 / zoom, 0, 100);
          break;

        case 'resize': {
          // Mise à l'échelle depuis le centre : le coin suit le pointeur, quelle que soit la rotation.
          const ratio = distanceBetween(gesture.center, point) / gesture.startDistance;
          item.scale = clamp(start.scale * ratio, CONFIG.minScale, CONFIG.maxScale);
          break;
        }

        case 'rotate': {
          let rotation = start.rotation + angleBetween(gesture.center, point) - gesture.startAngle;
          if (e.shiftKey) rotation = Math.round(rotation / CONFIG.rotateSnap) * CONFIG.rotateSnap;
          item.rotation = normalizeAngle(rotation);
          break;
        }

        case 'pinch': {
          const [a, b] = [...gesture.pointers.values()];
          const mid = midpoint(a, b);
          item.scale = clamp(start.scale * (distanceBetween(a, b) / gesture.startDistance), CONFIG.minScale, CONFIG.maxScale);
          item.rotation = normalizeAngle(start.rotation + angleBetween(a, b) - gesture.startAngle);
          item.x = clamp(start.x + ((mid.x - gesture.startMid.x) / rect.width) * 100 / zoom, 0, 100);
          item.y = clamp(start.y + ((mid.y - gesture.startMid.y) / rect.height) * 100 / zoom, 0, 100);
          break;
        }
      }
      render(item);
    }

    function onStagePointerUp(e) {
      if (!gesture || !gesture.pointers.has(e.pointerId)) return;
      gesture.pointers.delete(e.pointerId);
      releasePointer(e.pointerId);

      if (gesture.pointers.size > 0) {
        // Il reste un doigt : on repasse en simple déplacement depuis sa position actuelle.
        const [point] = gesture.pointers.values();
        gesture.rect = stage.getBoundingClientRect();
        gesture.startPoint = point;
        if (!gesture.uid) {
          gesture.mode = 'pan';
          gesture.startView = { ...view };
          return;
        }
        const item = placed.get(gesture.uid);
        if (!item) {
          endGesture();
          return;
        }
        gesture.mode = 'move';
        gesture.start = snapshot(item);
        return;
      }

      const { uid, mode, moved } = gesture;
      endGesture();
      if (e.type === 'pointerup' && uid && mode === 'move' && !moved) {
        registerTap(uid);
      } else {
        lastTap = { uid: null, time: 0 };
      }
    }

    function endGesture() {
      if (!gesture) return;
      for (const pointerId of gesture.pointers.keys()) releasePointer(pointerId);
      const item = gesture.uid ? placed.get(gesture.uid) : null;
      if (item) item.el.classList.remove('is-active');
      stage.classList.remove('is-panning');
      gesture = null;
    }

    /**
     * Double-clic / double-tap détecté à la main : avec la capture de pointeur,
     * l'événement natif dblclick ne cible plus le charm, et il est peu fiable au doigt.
     */
    function registerTap(uid) {
      const now = performance.now();
      if (lastTap.uid === uid && now - lastTap.time <= CONFIG.doubleTapDelay) {
        lastTap = { uid: null, time: 0 };
        removeCharm(uid);
      } else {
        lastTap = { uid, time: now };
      }
    }

    function onStageClick(e) {
      const button = e.target.closest('[data-handle="delete"]');
      if (!button) return;
      const el = button.closest(PLACED_SELECTOR);
      if (el) removeCharm(el.dataset.uid);
    }

    function onStageFocusIn(e) {
      const el = e.target.closest(PLACED_SELECTOR);
      if (el && el.dataset.uid !== selectedUid) select(el.dataset.uid, { focus: false });
    }

    /**
     * Sur un charm — molette : taille ; Maj + molette : rotation ; pincement trackpad (Ctrl + molette) : taille.
     * Dans le vide — Ctrl + molette ou pincement trackpad : zoom de l'aperçu ; la molette seule fait défiler la page.
     */
    function onStageWheel(e) {
      const el = e.target.closest(PLACED_SELECTOR);
      const item = el ? placed.get(el.dataset.uid) : null;
      const delta = wheelDelta(e);

      if (!item) {
        if (!e.ctrlKey) return;
        e.preventDefault(); // sinon le navigateur zoome toute la page
        stopZoomAnimation();
        const step = clamp(delta, -CONFIG.viewWheelMaxDelta, CONFIG.viewWheelMaxDelta);
        setZoom(view.zoom * Math.exp(-step * CONFIG.viewWheelZoomSpeed), framePercent(pointFromEvent(e)));
        return;
      }
      e.preventDefault();

      if (e.shiftKey) {
        item.rotation = normalizeAngle(item.rotation + delta * CONFIG.wheelRotateSpeed);
      } else {
        const speed = e.ctrlKey ? CONFIG.pinchZoomSpeed : CONFIG.wheelZoomSpeed;
        item.scale = clamp(item.scale * Math.exp(-delta * speed), CONFIG.minScale, CONFIG.maxScale);
      }
      select(item.uid);
      render(item);
    }

    /* ======================================================================
       9. Clavier
       ====================================================================== */

    function onKeyDown(e) {
      if (e.key === 'Escape' && charmDrag) {
        endCharmDrag();
        return;
      }

      const item = selectedUid ? placed.get(selectedUid) : null;
      if (!item || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;

      // N'agit que si le focus est sur la scène (ou nulle part), pas dans les étapes ou un bouton.
      const active = document.activeElement;
      if (active && active !== document.body && !stage.contains(active)) return;
      if (active && active.matches('[data-handle]') && (e.key === 'Enter' || e.key === ' ')) return;

      // Un pas de flèche fait la même distance à l'écran, quel que soit le zoom.
      const step = (e.shiftKey ? CONFIG.keyMoveStep * 5 : CONFIG.keyMoveStep) / view.zoom;
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          removeCharm(item.uid);
          break;
        case 'Escape':
          select(null);
          item.el.blur();
          break;
        case 'ArrowLeft':  item.x = clamp(item.x - step, 0, 100); break;
        case 'ArrowRight': item.x = clamp(item.x + step, 0, 100); break;
        case 'ArrowUp':    item.y = clamp(item.y - step, 0, 100); break;
        case 'ArrowDown':  item.y = clamp(item.y + step, 0, 100); break;
        case '+':
        case '=':
          item.scale = clamp(item.scale * CONFIG.keyScaleFactor, CONFIG.minScale, CONFIG.maxScale);
          break;
        case '-':
        case '_':
          item.scale = clamp(item.scale / CONFIG.keyScaleFactor, CONFIG.minScale, CONFIG.maxScale);
          break;
        case 'r':
          item.rotation = normalizeAngle(item.rotation + CONFIG.keyRotateStep);
          break;
        case 'R':
          item.rotation = normalizeAngle(item.rotation - CONFIG.keyRotateStep);
          break;
        default:
          return;
      }
      e.preventDefault();
      if (placed.has(item.uid)) render(item);
    }

    /* ======================================================================
       10. Aide (bouton « ? ») : le survol est géré en CSS, le clic / toucher / clavier ici
       ====================================================================== */

    function setupInfo() {
      const info = app.querySelector(CONFIG.selectors.info);
      const button = info && info.querySelector('button');
      if (!button) return;
      const setOpen = (open) => {
        info.classList.toggle('is-open', open);
        button.setAttribute('aria-expanded', String(open));
      };
      button.addEventListener('click', () => setOpen(!info.classList.contains('is-open')));
      document.addEventListener('pointerdown', (e) => { if (!info.contains(e.target)) setOpen(false); }, { signal });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); }, { signal });
    }

    /* ======================================================================
       11. Initialisation
       ====================================================================== */

    function init() {
      // Éléments de la scène gérés par le JS : la vue zoomable (le support), puis l'étiquette.
      // Les charms sont ajoutés après, par-dessus la vue (voir render).
      viewLayer = document.createElement('div');
      viewLayer.className = 'stage__view';

      supportImg = document.createElement('img');
      supportImg.className = 'stage__support';
      supportImg.alt = '';
      supportImg.draggable = false;
      supportImg.addEventListener('load', () => supportImg.classList.remove('is-loading'));
      supportImg.addEventListener('error', () => supportImg.classList.remove('is-loading'));
      viewLayer.append(supportImg);
      stage.prepend(viewLayer);

      stageLabel = document.createElement('p');
      stageLabel.className = 'stage__label';
      stage.append(stageLabel);

      // Étapes 1 et 2
      if (chainList) chainList.addEventListener('change', onChainChange);
      if (variantList) {
        variantList.addEventListener('change', onVariantChange);
        enableHorizontalWheel(variantList);
      }
      const initialChain = chainEls.find((el) => radioOf(el) && radioOf(el).checked) || chainEls[0];
      if (initialChain) selectChain(initialChain.dataset.id, { silent: true });
      else renderSupport();

      // Étape 3
      if (charmList) {
        charmList.querySelectorAll(CONFIG.selectors.charm).forEach(prepareCharmCard);
        charmList.addEventListener('pointerdown', onCharmPointerDown);
        charmList.addEventListener('pointermove', onCharmPointerMove);
        charmList.addEventListener('pointerup', onCharmPointerUp);
        charmList.addEventListener('pointercancel', endCharmDrag); // ex. le navigateur reprend la main pour défiler
        charmList.addEventListener('keydown', onCharmKeyDown);
      }
      if (charmFilter) {
        charmFilter.addEventListener('change', onCharmFilterChange);
        const checked = charmFilter.querySelector('input[type="radio"]:checked');
        filterCharms(checked ? checked.value : '');
      }

      // Scène
      stage.addEventListener('pointerdown', onStagePointerDown);
      stage.addEventListener('pointermove', onStagePointerMove);
      stage.addEventListener('pointerup', onStagePointerUp);
      stage.addEventListener('pointercancel', onStagePointerUp);
      stage.addEventListener('wheel', onStageWheel, { passive: false });
      stage.addEventListener('click', onStageClick);
      stage.addEventListener('focusin', onStageFocusIn);
      if (zoomControls) zoomControls.addEventListener('click', onZoomClick);

      document.addEventListener('keydown', onKeyDown, { signal });
      setupInfo();
      app.addEventListener('dragstart', (e) => e.preventDefault()); // pas de drag natif des images

      renderView();
      updateStageState();
    }

    init();

    return {
      api: Object.freeze({
        getComposition,
        selectChain,
        selectVariant,
        addCharm: addCharmById,
        removeCharm,
        clearCharms,
        filterCharms,
        setZoom: (zoom) => setZoom(zoom),
      }),
      destroy() {
        endCharmDrag();
        endGesture();
        stopZoomAnimation();
        listeners.abort();
      },
    };
  }

  /* ======================================================================
     Montage : au chargement, puis à chaque (re)rendu d'une section dans
     l'éditeur de thème Shopify (le HTML est remplacé sans recharger la page)
     ====================================================================== */

  /** @type {Map<HTMLElement, {api: Object, destroy: Function}>} */
  const instances = new Map();

  function mountAll(root) {
    root.querySelectorAll(CONFIG.selectors.app).forEach((app) => {
      if (instances.has(app)) return;
      const instance = mount(app);
      if (!instance) return;
      instances.set(app, instance);
      window.JewelStage = instance.api;
    });
  }

  function unmountAll(root) {
    for (const [app, instance] of instances) {
      if (!root.contains(app)) continue;
      instance.destroy();
      instances.delete(app);
      if (window.JewelStage === instance.api) delete window.JewelStage;
    }
  }

  mountAll(document);
  document.addEventListener('shopify:section:load', (e) => mountAll(e.target));
  document.addEventListener('shopify:section:unload', (e) => unmountAll(e.target));
})();
