/* =========================================================
   article1.js
   IMPACT REPLAY MAP
   ---------------------------------------------------------
   CLEAN VERSION
   - all strike locations stay on the map
   - no projectile animation
   - no localStorage
   - fixed regional view over the Middle East / Gulf
   - zoom follow is OFF by default
   - events flash / glow / explode at event time
   ========================================================= */

document.body.setAttribute("data-js-version", "impact-static-targets-fixed-region");

const DATA_URL = "data/article1-map-data.json";

/* =========================
   TIMING YOU CAN TWEAK
   ========================= */
const TIMING = {
  impactLeadIn: 1100,
  pauseBetweenEvents: 5200,
  replayRestartDelay: 900,
  labelHoldNormal: 3400,
  labelHoldSlow: 5000,
  popupHoldBuffer: 700,
  zoomDuration: 0.85,
  popupOpenDelay: 140
};

/* =========================
   FIXED REGIONAL VIEW
   Tweak these if you want the map
   framed a little wider or tighter
   ========================= */
const REGION_VIEW = {
  center: [26.5, 53.0],
  zoom: 4.6
};

/* =========================
   MAP
   ========================= */
const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true,
  zoomAnimation: true,
  fadeAnimation: true,
  markerZoomAnimation: true
}).setView(REGION_VIEW.center, REGION_VIEW.zoom);

L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO"
  }
).addTo(map);

const targetLayer = L.layerGroup().addTo(map);
const pulseLayer = L.layerGroup().addTo(map);
const impactLayer = L.layerGroup().addTo(map);
const staticPinsLayer = L.layerGroup().addTo(map);

/* =========================
   CONTROLS
   ========================= */
const playPauseBtn =
  document.getElementById("btnPlayPause") ||
  document.getElementById("btnPausePlay");

const restartBtn =
  document.getElementById("btnRestart") ||
  document.getElementById("btnReplay");

const toggleLabelsBtn = document.getElementById("btnToggleLabels");
const toggleZoomBtn = document.getElementById("btnToggleZoom");
const speedSelect = document.getElementById("speedSelect");

const feedEl = document.getElementById("eventFeed");
const mapPanel = document.querySelector(".map-panel");
const totalEventsEl = document.getElementById("eventCount");

/* =========================
   STATE
   ========================= */
const state = {
  strikeEvents: [],
  staticPins: [],
  markersById: new Map(),

  activeTimers: [],
  activeIntervals: [],
  activeLabelClosers: [],

  playing: true,
  paused: false,
  labelsVisible: true,
  autoZoomToEvent: false, // OFF by default
  loopEnabled: true,

  replayToken: 0,
  currentIndex: 0,
  speedKey: "normal"
};

/* =========================
   SPEEDS
   ========================= */
const SPEEDS = {
  slow: { multiplier: 0.7, labelMode: "on" },
  normal: { multiplier: 1, labelMode: "on" },
  fast: { multiplier: 1.6, labelMode: "off" },
  faster: { multiplier: 2.25, labelMode: "off" }
};

function getSpeedProfile() {
  return SPEEDS[state.speedKey] || SPEEDS.normal;
}

function getSpeedMultiplier() {
  return getSpeedProfile().multiplier;
}

function labelsAllowedForCurrentSpeed() {
  return getSpeedProfile().labelMode === "on" && state.labelsVisible;
}

function getLabelHoldMs(ev = null) {
  if (!labelsAllowedForCurrentSpeed()) return 0;

  if (ev && Number.isFinite(Number(ev.labelHoldMs))) {
    const perEvent = Number(ev.labelHoldMs);
    return state.speedKey === "slow" ? Math.round(perEvent * 1.35) : perEvent;
  }

  return state.speedKey === "slow"
    ? TIMING.labelHoldSlow
    : TIMING.labelHoldNormal;
}

/* =========================
   HELPERS
   ========================= */
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sleep(ms, token) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(token === state.replayToken);
    }, Math.max(0, ms));
    state.activeTimers.push(timer);
  });
}

function showLoadError(err) {
  console.error("Map data failed to load:", err);
  if (!mapPanel) return;

  const box = document.createElement("div");
  box.className = "data-box";
  box.innerHTML = `
    <h3>Map Data Error</h3>
    <p>Could not load <code>${DATA_URL}</code>. Check the file path and run this page from a local server.</p>
  `;
  mapPanel.appendChild(box);
}

async function loadMapData() {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();

  state.strikeEvents = Array.isArray(data.strikeEvents)
    ? data.strikeEvents
    : Array.isArray(data.strikeLocations)
      ? data.strikeLocations
      : [];

  state.staticPins = Array.isArray(data.staticPins) ? data.staticPins : [];
}

function normalizeEvent(ev, idx) {
  const lat = Number(ev.lat);
  const lng = Number(ev.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    id: ev.id || `event-${idx + 1}`,
    stamp: ev.stamp || `Event ${idx + 1}`,
    name: ev.name || `Strike ${idx + 1}`,
    category: ev.category || "Strike",
    detail: ev.detail || "Reported strike activity",
    source: ev.source || "Source note",
    lat,
    lng,
    originName: ev.originName || "",
    pinColor: ev.pinColor || "#ff00b8",
    zoom: Number.isFinite(Number(ev.zoom)) ? Number(ev.zoom) : 7,
    order: Number.isFinite(Number(ev.delay)) ? Number(ev.delay) : idx * 1000,
    labelHoldMs: Number.isFinite(Number(ev.labelHoldMs))
      ? Number(ev.labelHoldMs)
      : null
  };
}

function buildPopupHtml(ev) {
  const fromLine = ev.originName
    ? `<small>Context: ${escapeHtml(ev.originName)}</small><br>`
    : "";

  return `
    <div class="popup-wrap">
      <strong>${escapeHtml(ev.name)}</strong><br>
      <span class="popup-cat">${escapeHtml(ev.category)}</span><br>
      ${fromLine}
      ${escapeHtml(ev.detail)}<br>
      <small>${escapeHtml(ev.stamp)}</small><br>
      <small>${escapeHtml(ev.source)}</small>
    </div>
  `;
}

function setRegionalView() {
  map.setView(REGION_VIEW.center, REGION_VIEW.zoom, { animate: false });
}

/* =========================
   MARKERS
   All strike locations stay on map
   ========================= */
function addStaticTargets() {
  targetLayer.clearLayers();
  state.markersById.clear();

  const events = state.strikeEvents
    .map(normalizeEvent)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);

  state.strikeEvents = events;

  for (const ev of events) {
    const marker = L.circleMarker([ev.lat, ev.lng], {
      radius: 7,
      color: "#fff3fb",
      weight: 1.5,
      fillColor: ev.pinColor,
      fillOpacity: 0.88,
      opacity: 0.95,
      className: "strike-target-marker"
    })
      .bindPopup(buildPopupHtml(ev), {
        className: "impact-popup",
        autoClose: true
      })
      .addTo(targetLayer);

    state.markersById.set(ev.id, marker);
  }
}

function addStaticPins() {
  staticPinsLayer.clearLayers();

  for (const pin of state.staticPins) {
    const lat = Number(pin.lat);
    const lng = Number(pin.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const marker = L.circleMarker([lat, lng], {
      radius: 5,
      color: "rgba(255,255,255,.85)",
      weight: 1.2,
      fillColor: pin.pinColor || "#42e0ff",
      fillOpacity: 0.88
    }).addTo(staticPinsLayer);

    if (pin.detail || pin.name) {
      marker.bindPopup(
        `<strong>${escapeHtml(pin.name || "Map pin")}</strong><br>${escapeHtml(pin.detail || "")}`,
        { className: "impact-popup" }
      );
    }
  }
}

/* =========================
   FEED
   ========================= */
function setFeedEmpty() {
  if (!feedEl) return;

  feedEl.innerHTML = `
    <div class="feed-empty">
      <div class="feed-empty-kicker">Live Event Feed</div>
      <p>The sequence replays automatically. Use the controls to pause, restart, change speed, hide labels, or toggle zoom-follow.</p>
    </div>
  `;
}

function appendFeedEvent(ev) {
  if (!feedEl) return;

  const row = document.createElement("button");
  row.type = "button";
  row.className = "feed-item animate__animated animate__fadeInUp";

  const subLine = ev.originName
    ? `<div class="feed-source">Context: ${escapeHtml(ev.originName)}</div>`
    : "";

  row.innerHTML = `
    <span class="feed-accent" style="background:${escapeHtml(ev.pinColor)}"></span>
    <div class="feed-main">
      <div class="feed-topline">
        <span class="feed-stamp">${escapeHtml(ev.stamp)}</span>
        <span class="feed-cat">${escapeHtml(ev.category)}</span>
      </div>
      <div class="feed-title">${escapeHtml(ev.name)}</div>
      <div class="feed-detail">${escapeHtml(ev.detail)}</div>
      ${subLine}
      <div class="feed-source">${escapeHtml(ev.source)}</div>
    </div>
  `;

  row.addEventListener("click", () => focusEvent(ev.id));
  feedEl.prepend(row);
}

function focusEvent(id) {
  const marker = state.markersById.get(id);
  if (!marker) return;

  const ll = marker.getLatLng();

  if (state.autoZoomToEvent) {
    map.flyTo(ll, Math.max(map.getZoom(), 7), {
      duration: TIMING.zoomDuration
    });

    const timer = setTimeout(() => marker.openPopup(), TIMING.popupOpenDelay);
    state.activeTimers.push(timer);
  } else {
    marker.openPopup();
  }
}

/* =========================
   CLEANUP
   ========================= */
function clearReplayTimers() {
  for (const timer of state.activeTimers) clearTimeout(timer);
  state.activeTimers = [];
}

function clearIntervals() {
  for (const id of state.activeIntervals) clearInterval(id);
  state.activeIntervals = [];
}

function resetMarkerStyles() {
  for (const [id, marker] of state.markersById.entries()) {
    const ev = state.strikeEvents.find(x => x.id === id);
    const fill = ev?.pinColor || "#ff00b8";

    marker.setStyle({
      radius: 7,
      color: "#fff3fb",
      weight: 1.5,
      fillColor: fill,
      fillOpacity: 0.88,
      opacity: 0.95
    });
  }
}

function clearEffects() {
  pulseLayer.clearLayers();
  impactLayer.clearLayers();
  resetMarkerStyles();
}

function clearOpenPopupsAndLabels() {
  map.closePopup();

  for (const closer of state.activeLabelClosers) {
    clearTimeout(closer);
  }
  state.activeLabelClosers = [];

  for (const marker of state.markersById.values()) {
    try {
      marker.closeTooltip();
    } catch (_) {}
  }
}

function hardStopReplayVisuals() {
  clearReplayTimers();
  clearIntervals();
  clearEffects();
  clearOpenPopupsAndLabels();
}

/* =========================
   LABELS
   ========================= */
function showEventLabel(ev, holdMs) {
  if (!labelsAllowedForCurrentSpeed() || holdMs <= 0) return;

  const marker = state.markersById.get(ev.id);
  if (!marker) return;

  marker.bindTooltip(
    `${escapeHtml(ev.name)}`,
    {
      permanent: false,
      direction: "top",
      className: "city-label",
      offset: [0, -8]
    }
  );

  marker.openTooltip();

  const timer = setTimeout(() => {
    try {
      marker.closeTooltip();
    } catch (_) {}
  }, holdMs);

  state.activeLabelClosers.push(timer);
}

/* =========================
   IMPACT FLASH
   Marker already exists.
   We just animate it.
   ========================= */
function animateImpactOnlyEvent(ev, token) {
  return new Promise((resolve) => {
    const marker = state.markersById.get(ev.id);
    if (!marker) {
      resolve(false);
      return;
    }

    const ll = [ev.lat, ev.lng];

    if (state.autoZoomToEvent) {
      map.flyTo(ll, ev.zoom, {
        duration: TIMING.zoomDuration,
        animate: true
      });
    }

    const pulse1 = L.circle(ll, {
      radius: 2500,
      color: ev.pinColor,
      weight: 2.5,
      fillColor: ev.pinColor,
      fillOpacity: 0.12,
      opacity: 0.9
    }).addTo(pulseLayer);

    const pulse2 = L.circle(ll, {
      radius: 800,
      color: "#ffd6f3",
      weight: 1.5,
      fillColor: ev.pinColor,
      fillOpacity: 0.18,
      opacity: 0.95
    }).addTo(pulseLayer);

    let ticks = 0;
    let radius1 = 2500;
    let radius2 = 800;
    let opacity1 = 0.9;
    let opacity2 = 0.95;

    const pulseTimer = setInterval(() => {
      if (token !== state.replayToken || !state.playing) {
        clearInterval(pulseTimer);
        resolve(false);
        return;
      }

      ticks += 1;
      radius1 += 2600;
      radius2 += 1600;
      opacity1 -= 0.08;
      opacity2 -= 0.09;

      pulse1.setRadius(radius1);
      pulse2.setRadius(radius2);

      pulse1.setStyle({
        opacity: Math.max(0, opacity1),
        fillOpacity: Math.max(0, opacity1 * 0.18)
      });

      pulse2.setStyle({
        opacity: Math.max(0, opacity2),
        fillOpacity: Math.max(0, opacity2 * 0.22)
      });

      const flashPhase = ticks % 2 === 0;
      marker.setStyle({
        radius: flashPhase ? 11 : 8,
        color: "#ffffff",
        weight: flashPhase ? 2.5 : 1.8,
        fillColor: ev.pinColor,
        fillOpacity: flashPhase ? 1 : 0.9,
        opacity: 1
      });

      if (ticks >= 9) {
        clearInterval(pulseTimer);
        pulseLayer.removeLayer(pulse1);
        pulseLayer.removeLayer(pulse2);

        marker.setStyle({
          radius: 7,
          color: "#fff3fb",
          weight: 1.5,
          fillColor: ev.pinColor,
          fillOpacity: 0.88,
          opacity: 0.95
        });

        triggerImpact(ev);
        resolve(true);
      }
    }, Math.max(50, TIMING.impactLeadIn / 9));

    state.activeIntervals.push(pulseTimer);
  });
}

/* =========================
   IMPACT
   ========================= */
function triggerImpact(ev) {
  const marker = state.markersById.get(ev.id);
  const labelHoldMs = getLabelHoldMs(ev);

  if (marker) {
    marker.openPopup();
    showEventLabel(ev, labelHoldMs);

    const closeTimer = setTimeout(() => {
      try {
        marker.closePopup();
      } catch (_) {}
    }, labelHoldMs + TIMING.popupHoldBuffer);

    state.activeTimers.push(closeTimer);
  }

  appendFeedEvent(ev);

  const iconMarker = L.marker([ev.lat, ev.lng], {
    icon: L.divIcon({
      className: "impact-icon-shell",
      html: `<div class="impact-icon" style="--impact-color:${escapeHtml(ev.pinColor)}">💥</div>`,
      iconSize: [60, 60],
      iconAnchor: [30, 30]
    }),
    interactive: false,
    keyboard: false
  }).addTo(impactLayer);

  const ring = L.circle([ev.lat, ev.lng], {
    radius: 9000,
    color: ev.pinColor,
    weight: 3.2,
    fillColor: "#ffe84a",
    fillOpacity: 0.26,
    opacity: 0.96
  }).addTo(impactLayer);

  const ring2 = L.circle([ev.lat, ev.lng], {
    radius: 3500,
    color: "#fff4c2",
    weight: 2,
    fillOpacity: 0,
    opacity: 0.95
  }).addTo(impactLayer);

  let radius1 = 9000;
  let radius2 = 3500;
  let opacity = 0.96;
  let fillOpacity = 0.26;

  const timer = setInterval(() => {
    radius1 += 7000;
    radius2 += 5200;
    opacity -= 0.045;
    fillOpacity -= 0.012;

    ring.setRadius(radius1);
    ring2.setRadius(radius2);
    ring.setStyle({
      opacity: Math.max(0, opacity),
      fillOpacity: Math.max(0, fillOpacity)
    });
    ring2.setStyle({
      opacity: Math.max(0, opacity)
    });

    if (opacity <= 0) {
      clearInterval(timer);
      impactLayer.removeLayer(ring);
      impactLayer.removeLayer(ring2);
      impactLayer.removeLayer(iconMarker);
    }
  }, 70);

  state.activeIntervals.push(timer);
}

/* =========================
   REPLAY
   ========================= */
async function runReplaySequence(token) {
  setFeedEmpty();
  clearEffects();
  clearOpenPopupsAndLabels();

  for (let i = 0; i < state.strikeEvents.length; i++) {
    if (!state.playing || token !== state.replayToken) return;

    state.currentIndex = i;
    const ev = state.strikeEvents[i];

    const completed = await animateImpactOnlyEvent(ev, token);
    if (!completed || token !== state.replayToken || !state.playing) return;

    const waitMs = TIMING.pauseBetweenEvents / getSpeedMultiplier();
    const stillValid = await sleep(waitMs, token);
    if (!stillValid || token !== state.replayToken || !state.playing) return;
  }

  if (!state.loopEnabled || token !== state.replayToken || !state.playing) return;

  const stillValid = await sleep(
    TIMING.replayRestartDelay / getSpeedMultiplier(),
    token
  );
  if (!stillValid || token !== state.replayToken || !state.playing) return;

  if (token === state.replayToken && state.playing) {
    startReplay();
  }
}

function startReplay() {
  state.replayToken += 1;
  state.playing = true;
  state.paused = false;
  hardStopReplayVisuals();
  setRegionalView();
  updateControls();
  runReplaySequence(state.replayToken);
}

function pauseReplay() {
  state.playing = false;
  state.paused = true;
  state.replayToken += 1;
  hardStopReplayVisuals();
  updateControls();
}

function togglePlayPause() {
  if (state.playing) {
    pauseReplay();
  } else {
    startReplay();
  }
}

/* =========================
   UI TEXT
   ========================= */
function updateControls() {
  if (playPauseBtn) {
    playPauseBtn.textContent = state.playing ? "Pause" : "Play";
  }

  if (toggleLabelsBtn) {
    if (getSpeedProfile().labelMode === "off") {
      toggleLabelsBtn.textContent = "Labels: auto-off on fast speed";
      toggleLabelsBtn.disabled = true;
    } else {
      toggleLabelsBtn.disabled = false;
      toggleLabelsBtn.textContent = state.labelsVisible ? "Hide labels" : "Show labels";
    }
  }

  if (toggleZoomBtn) {
    toggleZoomBtn.textContent = state.autoZoomToEvent
      ? "Zoom follow: on"
      : "Zoom follow: off";
  }

  if (speedSelect) {
    const keyToSelectValue = {
      slow: "0.65",
      normal: "1",
      fast: "1.5",
      faster: "2"
    };

    speedSelect.value = keyToSelectValue[state.speedKey] || "1";
  }
}

/* =========================
   EVENTS
   ========================= */
if (playPauseBtn) {
  playPauseBtn.addEventListener("click", togglePlayPause);
}

if (restartBtn) {
  restartBtn.addEventListener("click", () => {
    startReplay();

    if (mapPanel) {
      mapPanel.classList.remove("animate__animated", "animate__pulse");
      void mapPanel.offsetWidth;
      mapPanel.classList.add("animate__animated", "animate__pulse");
    }
  });
}

if (toggleLabelsBtn) {
  toggleLabelsBtn.addEventListener("click", () => {
    if (getSpeedProfile().labelMode === "off") return;
    state.labelsVisible = !state.labelsVisible;
    clearOpenPopupsAndLabels();
    updateControls();
  });
}

if (toggleZoomBtn) {
  toggleZoomBtn.addEventListener("click", () => {
    state.autoZoomToEvent = !state.autoZoomToEvent;
    updateControls();
  });
}

if (speedSelect) {
  speedSelect.addEventListener("change", (e) => {
    const value = e.target.value;
    const mapValueToKey = {
      "0.65": "slow",
      "1": "normal",
      "1.5": "fast",
      "2": "faster",
      slow: "slow",
      normal: "normal",
      fast: "fast",
      faster: "faster"
    };

    const next = mapValueToKey[value];
    if (!next || !SPEEDS[next]) return;

    state.speedKey = next;

    if (getSpeedProfile().labelMode === "off") {
      clearOpenPopupsAndLabels();
    }

    updateControls();
    startReplay();
  });
}

/* =========================
   INIT
   ========================= */
(async function init() {
  try {
    await loadMapData();
    addStaticTargets();
    addStaticPins();
    setRegionalView();
    setFeedEmpty();

    if (totalEventsEl) {
      totalEventsEl.textContent = String(state.strikeEvents.length);
    }

    updateControls();
    startReplay();
  } catch (err) {
    showLoadError(err);
  }
})();