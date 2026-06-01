'use strict';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

// ──────────────────────────────────────────────────────
//  CONSTANTS & CONFIG
// ──────────────────────────────────────────────────────

/* Feedback email — replace with your address (FormSubmit.co) */
const FEEDBACK_EMAIL = 'taint.calculator@gmail.com';

/* AQI API token — free demo token; get your own at aqicn.org/api/ */
const WAQI_TOKEN = 'demo';

/* Default Chennai fuel prices (₹) — fallback if live fetch fails */
const DEFAULT_PRICES = { petrol:104.99, diesel:91.47, cng:79.50, electric:7.50 };

/* Mutable prices object — updated by fetchLivePrices() */
let PRICES = { ...DEFAULT_PRICES };

/* Supabase connection state */
let sbConnected = false;

/* Calculator state */
let currentCat   = 'two';    // two | four | shared | transit
let currentFuel  = 'petrol'; // petrol | diesel | cng | electric | hybrid | rail
let currentHtype = 'mild';   // mild | strong | phev (hybrid only)

/* Feedback star rating */
let starRating = 0;

/* Cost render memoisation */
let lastVeh = null, lastFuel = null;

const REQUEST_TIMEOUT_MS = 12000;
const WRITE_QUEUE_LIMIT = 4;
const appWriteQueue = [];
let activeWrites = 0;

function notify(message, type='warn', title='TAINT') {
  const region = document.getElementById('toastRegion');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<strong>${escapeHTML(title)}</strong>${escapeHTML(message)}`;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), type === 'error' ? 7000 : 4200);
}

const GLOBAL_ERROR_SILENCE = [
  'AbortError',
  'Failed to fetch',
  'NetworkError',
  'Load failed',
  'Script error',
  'ResizeObserver loop',
  'The user aborted a request',
  'A listener indicated an asynchronous response'
];
const appErrorSeen = new Map();

function shouldSilenceGlobalError(message, detail={}) {
  if (detail?.source === 'resource.error') return true;
  return GLOBAL_ERROR_SILENCE.some(pattern => message.includes(pattern));
}

function appError(error, userMessage='Something went wrong.', detail={}, options={}) {
  const message = error?.message || String(error || userMessage);
  console.warn('TAINT handled error:', message, detail);
  const key = `${detail?.source || 'app'}:${message}`;
  const now = Date.now();
  const recentlySeen = now - (appErrorSeen.get(key) || 0) < 5000;
  appErrorSeen.set(key, now);
  const shouldToast = options.toast !== false && !recentlySeen && !shouldSilenceGlobalError(message, detail);
  if (shouldToast) notify(userMessage, 'error', options.title || 'Could not complete that');
  try {
    if (typeof sbLogProcess === 'function') sbLogProcess('client_error', 'failed', detail, null, message);
  } catch {}
}

window.addEventListener('error', e => {
  const target = e.target;
  if (target && target !== window) {
    appError(target.src || target.href || target.tagName || 'resource failed',
      'A resource failed to load, but the app is still usable.',
      { source:'resource.error', tag:target.tagName || null },
      { toast:false });
    return;
  }
  appError(e.error || e.message,
    'A feature hit a recoverable error. Please try that action again.',
    { source:'window.error', filename:e.filename, line:e.lineno, col:e.colno },
    { toast:false });
});
window.addEventListener('unhandledrejection', e => {
  e.preventDefault?.();
  appError(e.reason,
    'A background task failed. Your page is still usable.',
    { source:'unhandledrejection' },
    { toast:false });
});

const AUTH_USERNAME_RE = /^[A-Za-z][A-Za-z0-9 ._-]{1,59}$/;
const AUTH_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const AUTH_PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,72}$/;

function isValidEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && AUTH_EMAIL_RE.test(email) && !email.includes('..');
}

function validateUsernameValue(value) {
  const username = String(value || '').trim().replace(/\s+/g, ' ');
  if (!AUTH_USERNAME_RE.test(username)) {
    return { ok:false, value:username, message:'Username must start with a letter and use 2-60 letters, numbers, spaces, dots, underscores, or hyphens.' };
  }
  return { ok:true, value:username };
}

function validateEmailValue(value) {
  const email = normalizeAuthEmail(value);
  if (!isValidEmail(email)) return { ok:false, value:email, message:'Email must be a valid address, for example name@example.com.' };
  return { ok:true, value:email };
}

function validatePasswordValue(value, { strong=false, label='Password' }={}) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 72) return { ok:false, message:`${label} must be 8-72 characters.` };
  if (/[\u0000-\u001f\u007f]/.test(password)) return { ok:false, message:`${label} cannot contain control characters.` };
  if (strong && !AUTH_PASSWORD_RE.test(password)) {
    return { ok:false, message:`${label} must include uppercase, lowercase, number, and symbol characters.` };
  }
  return { ok:true };
}

function collectFormFields(scopeSelector) {
  const scope = document.querySelector(scopeSelector);
  if (!scope) return {};
  const data = {};
  scope.querySelectorAll('input[id], select[id], textarea[id]').forEach(el => {
    if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') return;
    if (el.type === 'checkbox') data[el.id] = !!el.checked;
    else if (el.type === 'radio') { if (el.checked) data[el.name || el.id] = el.value; }
    else data[el.id] = el.value;
  });
  return data;
}

function setFieldInvalid(el, message='') {
  if (!el) return false;
  el.classList.toggle('invalid', !!message);
  el.setAttribute('aria-invalid', message ? 'true' : 'false');
  let msg = el.parentElement?.querySelector?.('.field-error');
  if (!msg && el.parentElement) {
    msg = document.createElement('div');
    msg.className = 'field-error';
    el.parentElement.appendChild(msg);
  }
  if (msg) msg.textContent = message;
  return !message;
}

function validateNumberField(id, { min=0, max=Number.MAX_SAFE_INTEGER, label='Value' }={}) {
  const el = document.getElementById(id);
  const value = Number(el?.value);
  if (!el || !Number.isFinite(value)) return { ok:false, value:0, message:`${label} must be a number.` };
  if (value < min || value > max) return { ok:false, value, message:`${label} must be between ${min} and ${max}.` };
  setFieldInvalid(el, '');
  return { ok:true, value };
}

function failField(id, message) {
  const el = document.getElementById(id);
  setFieldInvalid(el, message);
  el?.focus?.();
  notify(message, 'warn', 'Check your input');
  return false;
}

function withTimeout(ms=REQUEST_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal:ctl.signal, done:() => clearTimeout(timer) };
}

async function appFetch(url, options={}, { timeout=REQUEST_TIMEOUT_MS, label='request', retries=0 }={}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutCtl = withTimeout(timeout);
    try {
      const res = await fetch(url, { ...options, signal:timeoutCtl.signal });
      timeoutCtl.done();
      if (!res.ok) throw new Error(`${label} failed with ${res.status}`);
      return res;
    } catch (e) {
      timeoutCtl.done();
      lastError = e;
      if (attempt >= retries || e.name === 'AbortError') break;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function enqueueWrite(work) {
  return new Promise(resolve => {
    appWriteQueue.push({ work, resolve });
    drainWriteQueue();
  });
}

function drainWriteQueue() {
  while (activeWrites < WRITE_QUEUE_LIMIT && appWriteQueue.length) {
    const item = appWriteQueue.shift();
    activeWrites++;
    Promise.resolve()
      .then(item.work)
      .catch(e => {
        console.warn('TAINT queued write skipped:', e.message);
        return null;
      })
      .then(item.resolve)
      .finally(() => {
        activeWrites--;
        drainWriteQueue();
      });
  }
}

// ──────────────────────────────────────────────────────
//  VEHICLE DATA
//  gPerKm   : g CO₂ per km (journal-referenced values)
//  fuelPerKm: fuel consumed per km (L, kg, or kWh)
//             — used with PRICES to compute cost dynamically
// ──────────────────────────────────────────────────────
const VD = {
  two: {
    petrol: [
      { label:'Petrol Scooter / Moped (BS6)',      value:'scooter',   gPerKm:47,  fuelPerKm:0.0200 },
      { label:'Petrol Motorbike 100–150cc (BS6)',  value:'bike_100',  gPerKm:57,  fuelPerKm:0.0222 },
      { label:'Petrol Bike 150cc+ (BS6)',          value:'bike_150',  gPerKm:78,  fuelPerKm:0.0263 }
    ],
    cng: [
      { label:'CNG Motorbike (Bajaj Freedom 125)', value:'cng_bike',  gPerKm:35,  fuelPerKm:0.0143 }
    ],
    electric: [
      { label:'E-bicycle / EV Cycle',               value:'ev_cycle',  kwhPerKm:0.015, fuelPerKm:0.015 },
      { label:'EV Scooter (Ola S1, Ather 450)',     value:'ev_scoot',  kwhPerKm:0.033, fuelPerKm:0.033 },
      { label:'EV Motorbike (Revolt, Ultraviolette)',value:'ev_moto',   kwhPerKm:0.038, fuelPerKm:0.038 }
    ],
    hybrid: {
      mild:   [{ label:'Mild Hybrid Scooter (MHEV)',  value:'mhev_scoot', gPerKm:34, fuelPerKm:0.0192 }],
      strong: [{ label:'Strong Hybrid Scooter (HEV)', value:'hev_scoot',  gPerKm:26, fuelPerKm:0.0161 }],
      phev:   []
    }
  },
  four: {
    petrol: [
      { label:'Petrol Hatchback (Swift, i20)',       value:'pet_htch', gPerKm:104, fuelPerKm:0.0588 },
      { label:'Petrol Sedan (City, Verna)',          value:'pet_sed',  gPerKm:121, fuelPerKm:0.0714 },
      { label:'Petrol SUV / MUV (Creta, XUV)',      value:'pet_suv',  gPerKm:155, fuelPerKm:0.0909 }
    ],
    diesel: [
      { label:'Diesel Sedan',                        value:'die_sed',  gPerKm:98,  fuelPerKm:0.0556 },
      { label:'Diesel SUV / MUV (Fortuner)',         value:'die_suv',  gPerKm:138, fuelPerKm:0.0714 }
    ],
    cng: [
      { label:'CNG Hatchback (WagonR CNG)',          value:'cng_htch', gPerKm:90,  fuelPerKm:0.0370 },
      { label:'CNG Sedan',                           value:'cng_sed',  gPerKm:110, fuelPerKm:0.0455 },
      { label:'CNG SUV / MPV (Ertiga CNG)',          value:'cng_suv',  gPerKm:128, fuelPerKm:0.0625 }
    ],
    electric: [
      { label:'EV Hatchback (Tata Tiago / Nexon)',   value:'ev_htch',  kwhPerKm:0.140, fuelPerKm:0.140 },
      { label:'EV Sedan / SUV (Tata Punch, MG ZS)',  value:'ev_suv',   kwhPerKm:0.165, fuelPerKm:0.165 }
    ],
    hybrid: {
      mild:   [{ label:'Mild Hybrid / MHEV sedan',              value:'mhev_sed', gPerKm:88, fuelPerKm:0.0625 }],
      strong: [
        { label:'Strong Hybrid / HEV sedan (Honda City HEV)',   value:'hev_sed',  gPerKm:70, fuelPerKm:0.0455 },
        { label:'Strong Hybrid / HEV SUV (Hyryder, HyCross)',   value:'hev_suv',  gPerKm:90, fuelPerKm:0.0625 }
      ],
      phev: [
        { label:'Plug-in Hybrid / PHEV sedan',                  value:'phev_sed', gPerKm:55, fuelPerKm:0.0333 },
        { label:'Plug-in Hybrid / PHEV SUV',                    value:'phev_suv', gPerKm:73, fuelPerKm:0.0476 }
      ]
    }
  },
  shared: {
    petrol: [
      { label:'Petrol Taxi — hatchback (Ola/Uber Micro)',   value:'taxi_htch', gPerKm:130, fuelPerKm:0.0769 },
      { label:'Petrol Taxi — sedan (Ola Prime, Uber Go)',   value:'taxi_sed',  gPerKm:148, fuelPerKm:0.0909 },
      { label:'Petrol Taxi — SUV (Ola SUV, Innova taxi)',   value:'taxi_suv',  gPerKm:168, fuelPerKm:0.1111 },
      { label:'Petrol Maxi-cab / Shared taxi (6–8 seat)',   value:'maxicab',   gPerKm:175, fuelPerKm:null,   avgOccupancy:6 },
      { label:'Petrol Mini-bus (school / office)',           value:'minibus',   gPerKm:280, fuelPerKm:null,   avgOccupancy:18 }
    ],
    cng: [
      { label:'Auto-rickshaw (CNG)',  value:'auto',       gPerKm:55,  fuelPerKm:0.0357 },
      { label:'Share Auto (CNG)',     value:'share_auto', gPerKm:55,  fuelPerKm:0.0357, avgOccupancy:4 },
      { label:'CNG City Bus',         value:'cng_bus',    gPerKm:520, fuelPerKm:null,    avgOccupancy:40 }
    ],
    diesel: [
      { label:'MTC City Bus (diesel)',value:'bus',        gPerKm:640, fuelPerKm:null,    avgOccupancy:40 }
    ],
    electric: [
      { label:'Electric Auto / E-rickshaw', value:'e_auto', kwhPerKm:0.020, fuelPerKm:0.020 },
      { label:'Electric Bus (city)',         value:'e_bus',  kwhPerKm:0.300, fuelPerKm:null, avgOccupancy:40 }
    ]
  },
  /* ── TRANSIT: Train, Metro, Suburban Rail ── */
  transit: {
    rail: [] // populated dynamically per city in populateVehicles()
  }
};

/* Build transit rail options dynamically for the current city */
function buildTransitOptions() {
  const g = city().grid; // kg CO₂/kWh
  const opts = [];
  // Metro (city-specific name, kWhPerKm based on UITP metro efficiency)
  opts.push({ label: city().metro,                      value:'metro',    kwhPerKm:0.060, fuelPerKm:null });
  // Suburban / Local
  opts.push({ label: city().suburban,                   value:'suburban', kwhPerKm: city().suburbanKwhPerKm || 0.025, fuelPerKm:null });
  // Monorail (Mumbai only)
  if (city().hasMonorail)
    opts.push({ label:'Mumbai Monorail',                value:'monorail', kwhPerKm:0.055, fuelPerKm:null });
  // Indian Railways intercity
  opts.push({ label:'Indian Railways — Express / Mail',  value:'express',  kwhPerKm:0.014, fuelPerKm:null });
  opts.push({ label:'Vande Bharat / Rajdhani / Shatabdi',value:'rajdhani', kwhPerKm:0.008, fuelPerKm:null });
  // Resolve gPerKm from city grid
  opts.forEach(o => { o.gPerKm = Math.round(o.kwhPerKm * g * 1000); });
  VD.transit.rail = opts;
}

/* Fuel types available per category */
const CAT_FUELS = {
  two:     ['petrol','cng','electric','hybrid'],
  four:    ['petrol','diesel','cng','electric','hybrid'],
  shared:  ['petrol','cng','diesel','electric'],
  transit: ['rail']
};

/* UI metadata per fuel type */
const FUEL_META = {
  petrol:  { label:'Petrol',      icon:'⛽', cls:'petrol'   },
  diesel:  { label:'Diesel',      icon:'🛢️', cls:'diesel'   },
  cng:     { label:'CNG',         icon:'💨', cls:'cng'      },
  electric:{ label:'Electric',    icon:'⚡', cls:'electric' },
  hybrid:  { label:'Hybrid',      icon:'🔋', cls:'hybrid'   },
  rail:    { label:'Rail / Metro',icon:'🚆', cls:'electric' }
};

/* For cost calculation: hybrid vehicles use petrol price as their base */
const PRICE_KEY = { petrol:'petrol',diesel:'diesel',cng:'cng',electric:'electric',hybrid:'petrol' };

/* Reference petrol g/km per category — used for % savings comparison */
const PETROL_BASE = { two:57, four:121, shared:640, transit:0 }; // transit: no petrol baseline

const PUC_STATUS_MULT = {
  valid_clean  : 0.98,
  valid_average: 1.00,
  near_limit   : 1.08,
  expired      : 1.15,
  failed       : 1.25,
  unknown      : 1.00
};
const PUC_STATUS_LABEL = {
  valid_clean  : 'Valid clean PUC',
  valid_average: 'Valid average PUC',
  near_limit   : 'Valid PUC near limit',
  expired      : 'Expired or unavailable PUC',
  failed       : 'Failed PUC',
  unknown      : 'PUC unknown'
};

function getPucAdjustment(fuel=currentFuel) {
  if (fuel === 'electric' || fuel === 'rail' || currentCat === 'transit') {
    return { status:'not_applicable', multiplier:1, label:'No tailpipe PUC correction for electric or rail mode.' };
  }
  const status = document.getElementById('pucStatus')?.value || 'unknown';
  let multiplier = PUC_STATUS_MULT[status] || 1;
  const coRaw = document.getElementById('pucCo')?.value;
  const smokeRaw = document.getElementById('pucSmoke')?.value;
  const co = coRaw === '' ? null : Number(coRaw);
  const smoke = smokeRaw === '' ? null : Number(smokeRaw);

  if (fuel === 'diesel' && Number.isFinite(smoke)) {
    if (smoke > 65) multiplier = Math.max(multiplier, 1.22);
    else if (smoke > 45) multiplier = Math.max(multiplier, 1.10);
    else if (smoke > 0) multiplier = Math.max(multiplier, 1.00);
  } else if (Number.isFinite(co)) {
    if (co > 3) multiplier = Math.max(multiplier, 1.25);
    else if (co > 1) multiplier = Math.max(multiplier, 1.12);
    else if (co > 0.5) multiplier = Math.max(multiplier, 1.06);
    else if (co >= 0) multiplier = Math.min(multiplier, 1.00);
  }

  return {
    status,
    co:Number.isFinite(co) ? co : null,
    smoke:Number.isFinite(smoke) ? smoke : null,
    multiplier:+multiplier.toFixed(3),
    label:PUC_STATUS_LABEL[status] || 'PUC unknown'
  };
}

function updatePucUI() {
  const isDiesel = currentFuel === 'diesel';
  const isTailpipe = currentFuel !== 'electric' && currentFuel !== 'rail' && currentCat !== 'transit';
  const coField = document.getElementById('pucCoField');
  const smokeField = document.getElementById('pucSmokeField');
  const note = document.getElementById('pucNote');
  if (coField) coField.style.display = isTailpipe && !isDiesel ? '' : 'none';
  if (smokeField) smokeField.style.display = isTailpipe && isDiesel ? '' : 'none';
  if (note) {
    const puc = getPucAdjustment(currentFuel);
    if (!isTailpipe) {
      note.innerHTML = '<strong>PUC not applied.</strong> This mode has no tailpipe certificate value; the calculator uses city electricity grid intensity where relevant.';
    } else {
      const measured = isDiesel && puc.smoke != null
        ? ` · smoke opacity ${puc.smoke.toFixed(1)}%`
        : puc.co != null ? ` · CO ${puc.co.toFixed(2)}%` : '';
      note.innerHTML = `<strong>${puc.label}</strong>${measured} · footprint multiplier ${puc.multiplier.toFixed(2)}×.`;
    }
  }
}

function getVehicleList() {
  if (currentCat === 'transit') buildTransitOptions();
  const cat = VD[currentCat]; if (!cat) return [];
  const fd  = cat[currentFuel]; if (!fd) return [];
  const raw = currentFuel === 'hybrid' ? (fd[currentHtype] || []) : fd;
  // Resolve dynamic gPerKm for EVs with kwhPerKm
  return raw.map(v => {
    if (v.kwhPerKm != null && !('gPerKm' in v && v.gPerKm > 0)) {
      return { ...v, gPerKm: Math.round(v.kwhPerKm * city().grid * 1000) };
    }
    if (v.kwhPerKm != null) {
      // Always recompute for EV/rail so city grid is always current
      return { ...v, gPerKm: Math.round(v.kwhPerKm * city().grid * 1000) };
    }
    return v;
  });
}

/* Flat vehicle list for cost comparison table (rebuilt when prices change) */
const COST_VEHICLES = [
  { label:'EV Cycle',       fuel:'electric', fuelPerKm:0.025 },
  { label:'EV Scooter',     fuel:'electric', fuelPerKm:0.040 },
  { label:'EV Motorbike',   fuel:'electric', fuelPerKm:0.045 },
  { label:'EV Hatchback',   fuel:'electric', fuelPerKm:0.150 },
  { label:'EV Sedan/SUV',   fuel:'electric', fuelPerKm:0.200 },
  { label:'CNG Bike',       fuel:'cng',      fuelPerKm:0.0143},
  { label:'CNG Hatchback',  fuel:'cng',      fuelPerKm:0.0370},
  { label:'CNG Sedan',      fuel:'cng',      fuelPerKm:0.0455},
  { label:'CNG SUV',        fuel:'cng',      fuelPerKm:0.0625},
  { label:'PHEV Sedan',     fuel:'hybrid',   fuelPerKm:0.0333},
  { label:'HEV Sedan',      fuel:'hybrid',   fuelPerKm:0.0455},
  { label:'HEV SUV',        fuel:'hybrid',   fuelPerKm:0.0625},
  { label:'MHEV Sedan',     fuel:'hybrid',   fuelPerKm:0.0625},
  { label:'Petrol Scooter', fuel:'petrol',   fuelPerKm:0.0200},
  { label:'Petrol Hatch',   fuel:'petrol',   fuelPerKm:0.0588},
  { label:'Diesel Sedan',   fuel:'diesel',   fuelPerKm:0.0556},
  { label:'Petrol Sedan',   fuel:'petrol',   fuelPerKm:0.0714},
  { label:'Diesel SUV',     fuel:'diesel',   fuelPerKm:0.0714},
  { label:'Petrol SUV',     fuel:'petrol',   fuelPerKm:0.0909}
];

/* Tips indexed by vehicle value */
const TIPS = {
  scooter:   'BS6 petrol scooters emit ~47 g CO₂/km (ICCT 2021). An <strong>EV scooter</strong> cuts this to 24 g/km on Tamil Nadu\'s grid.',
  bike_100:  '100–150cc BS6 bikes emit ~57 g/km. An <strong>EV motorbike</strong> saves ~53% on Tamil Nadu\'s current grid.',
  bike_150:  '150cc+ bikes are the highest-emitting 2Ws (~78 g/km). The <strong>Bajaj CNG bike or an EV</strong> reduces this significantly.',
  cng_bike:  'The Bajaj Freedom 125 CNG emits ~35 g/km — <strong>25% less than a petrol scooter</strong>. Methane slip adds ~2–5 g CO₂eq/km (ICCT).',
  ev_cycle:  'EV cycles emit just ~11 g/km on Tamil Nadu\'s grid — the <strong>lowest-carbon motorised option</strong> for short Chennai commutes.',
  ev_scoot:  'EV scooters emit ~24 g/km (TN grid 0.716 kg CO₂/kWh) — <strong>49% less than a petrol scooter</strong>.',
  ev_moto:   'EV motorbikes emit ~27 g/km — <strong>53% lower</strong> than a 100–150cc petrol bike on Tamil Nadu\'s electricity mix.',
  mhev_scoot:'Mild hybrids cut petrol use ~15–25% via regen braking. <strong>Going full EV</strong> reduces emissions by ~65% further.',
  hev_scoot: 'Strong hybrid scooters (~26 g/km) rival EV scooters in emissions — both excellent low-carbon daily options.',
  pet_htch:  'Petrol hatchbacks emit ~104 g/km (MoRTH fleet avg). A <strong>CNG hatchback</strong> saves ~13%; a <strong>strong HEV sedan</strong> saves 33%.',
  pet_sed:   'Petrol sedan fleet avg: 120.6 g/km (ICCT 2021). A <strong>Honda City HEV</strong> cuts this to ~70 g/km — a 42% reduction.',
  pet_suv:   'Petrol SUVs (~155 g/km) are the highest 4W emitters. A <strong>strong hybrid SUV</strong> (Hyryder/HyCross) cuts this to ~90 g/km.',
  die_sed:   'Diesel sedans emit ~98 g/km. Lower CO₂ than petrol but higher NOₓ. A <strong>HEV or PHEV</strong> reduces both.',
  die_suv:   'Diesel SUVs emit ~138 g/km. A <strong>PHEV or EV SUV</strong> would reduce this by 50–80% over time.',
  cng_htch:  'CNG hatchbacks emit ~90 g/km — <strong>13% less than petrol</strong>. Note: methane slip adds ~2–30 g CO₂eq/km extra (ICCT Bieker 2021).',
  cng_sed:   'CNG sedans emit ~110 g/km. Lower tailpipe CO₂ than petrol but <strong>lifecycle methane slip</strong> must be accounted for.',
  cng_suv:   'CNG SUV/MPVs (e.g. Ertiga CNG) emit ~128 g/km — <strong>18% lower than petrol SUV</strong>. Strong hybrids cut deeper.',
  ev_htch:   'EV hatchbacks emit ~91 g/km on TN\'s grid (0.716 kg CO₂/kWh). This will <strong>improve as renewables grow</strong>.',
  ev_suv:    'EV sedans/SUVs emit ~105 g/km on TN\'s current grid. Grid improvements will <strong>cut this over the vehicle\'s lifetime</strong>.',
  mhev_sed:  'Mild hybrids reduce fuel use ~15–25%. For deeper cuts consider a <strong>Honda City HEV or Maruti Hyryder</strong>.',
  hev_sed:   'Strong hybrid sedans (City HEV, Camry) emit ~70 g/km — <strong>42% less than petrol sedan</strong> (ICCT LCA India 2025).',
  hev_suv:   'Hybrid SUVs (Hyryder, Innova HyCross) emit ~90 g/km — <strong>42% less than a petrol SUV</strong>.',
  phev_sed:  'PHEVs emit ~55 g/km (40% electric / 60% petrol avg). <strong>Charge overnight</strong> to maximise electric-only city trips.',
  phev_suv:  'PHEV SUVs emit ~73 g/km. On short daily trips fully in EV mode, <strong>effective emissions drop near-zero</strong>.',
  taxi_htch: 'Petrol taxis emit ~130 g/km in urban stop-go — more than a private car due to frequent starts. <strong>EV taxis</strong> cut this by ~85%.',
  taxi_sed:  'Petrol sedan taxis emit ~148 g/km. CNG taxis offer ~14% savings; <strong>EV taxis are the cleanest</strong> option for ride-hailing.',
  taxi_suv:  'Petrol SUV taxis (~168 g/km) are the highest-emitting taxi option. Consider carpooling to reduce your per-person share.',
  maxicab:   'Maxi-cabs (6–8 passengers) emit ~175 g/km total. With full occupancy the <strong>per-person share drops dramatically</strong>.',
  minibus:   'Petrol mini-buses emit ~280 g/km. A full 18-seat load gives very <strong>low per-person emissions</strong>.',
  auto:      'CNG autos emit ~55 g/km (Mahesh et al. 2022) — one of Chennai\'s <strong>cleanest and most affordable</strong> short-hop options.',
  share_auto:'Share autos split the ~55 g/km across riders — a <strong>very low per-person</strong> choice for short distances.',
  cng_bus:   'CNG buses emit ~520 g/km total — <strong>19% less than diesel</strong>; electric buses cut this by ~60% further.',
  bus:       'MTC diesel buses emit ~640 g/km total, but <strong>divided across 40+ passengers</strong>, per-person emissions are very low.',
  e_auto:    'Electric autos emit only ~14 g/km on TN\'s grid — <strong>75% less than CNG autos</strong>.',
  e_bus:     'Electric buses (~195 g/km, TN grid). With ~40 passengers, <strong>per-person share is among the lowest</strong> of any motorised transport.',
  metro:     'CMRL Metro emits ~35 g/km (TN grid) divided across 50+ passengers — <strong>Chennai\'s cleanest mass transit</strong>.'
};

// ──────────────────────────────────────────────────────
//  LIVE CLOCK
// ──────────────────────────────────────────────────────
const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function tickClock() {
  const n = new Date();
  const hh = String(n.getHours()).padStart(2,'0');
  const mm = String(n.getMinutes()).padStart(2,'0');
  const ss = String(n.getSeconds()).padStart(2,'0');
  document.getElementById('cTime').textContent = `${hh}:${mm}:${ss}`;
  document.getElementById('cDay').textContent  = DAYS[n.getDay()];
  document.getElementById('cDate').textContent = `${n.getDate()} ${MONTHS[n.getMonth()]} ${n.getFullYear()}`;
}

// ──────────────────────────────────────────────────────
//  THEME TOGGLE
// ──────────────────────────────────────────────────────
function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
  document.getElementById('themeBtn').textContent = light ? '🌙 Dark' : '☀️ Light';
  document.getElementById('themeMeta').content = light ? '#f4f6f8' : '#090b0d';
  try { localStorage.setItem('taint_theme', light ? 'light' : 'dark'); } catch(e){}
}

document.getElementById('themeBtn').addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('light'));
});

// ──────────────────────────────────────────────────────
//  AQI — WAQI API (free demo token works for Chennai)
// ──────────────────────────────────────────────────────
const AQI_LEVELS = [
  { max:50,       emoji:'🟢', label:'Good',                  cls:'aqi-good'     },
  { max:100,      emoji:'🟡', label:'Moderate',              cls:'aqi-moderate' },
  { max:150,      emoji:'🟠', label:'Unhealthy (Sensitive)', cls:'aqi-usg'      },
  { max:200,      emoji:'🔴', label:'Unhealthy',             cls:'aqi-unhealthy'},
  { max:300,      emoji:'🟣', label:'Very Unhealthy',        cls:'aqi-very'     },
  { max:Infinity, emoji:'⚫', label:'Hazardous',             cls:'aqi-hazardous'}
];
function aqiLevel(v) { return AQI_LEVELS.find(l => v <= l.max) || AQI_LEVELS.at(-1); }

async function fetchAQI() {
  try {
    const r = await fetch(`https://api.waqi.info/feed/${city().aqiSlug}/?token=${WAQI_TOKEN}`, { signal:AbortSignal.timeout(8000) });
    const d = await r.json();
    if (d.status !== 'ok') throw new Error('bad status');
    const aqi = d.data.aqi;
    const lv  = aqiLevel(aqi);
    /* Update topbar chip */
    const chip = document.getElementById('aqiChip');
    chip.className = `aqi-chip ${lv.cls}`;
    document.getElementById('aqiEmoji').textContent = lv.emoji;
    document.getElementById('aqiVal').textContent   = aqi;
    document.getElementById('aqiLbl').textContent   = lv.label;
    chip.title = `${city().name} AQI ${aqi} — ${lv.label} · WAQI/CPCB`;
    /* Update header badge */
    document.getElementById('aqiBadge').textContent = `${lv.emoji} AQI ${aqi} · ${lv.label}`;
  } catch(e) {
    document.getElementById('aqiBadge').textContent = '🌫️ AQI unavailable';
  }
}

// ──────────────────────────────────────────────────────
//  LIVE WEATHER — Open-Meteo API (free, no key required)
//  Chennai coordinates: 13.0827°N, 80.2707°E
//  Fetches current temperature, apparent temp, weather code
//  Refreshes every 10 minutes
// ──────────────────────────────────────────────────────

/* WMO weather interpretation codes → emoji + short label */
const WMO_CODES = {
  0:'☀️ Clear', 1:'🌤️ Mostly clear', 2:'⛅ Partly cloudy', 3:'☁️ Overcast',
  45:'🌫️ Fog', 48:'🌫️ Icy fog',
  51:'🌦️ Light drizzle', 53:'🌦️ Drizzle', 55:'🌧️ Heavy drizzle',
  61:'🌧️ Light rain', 63:'🌧️ Rain', 65:'🌧️ Heavy rain',
  71:'🌨️ Light snow', 73:'🌨️ Snow', 75:'❄️ Heavy snow',
  80:'🌦️ Light showers', 81:'🌧️ Showers', 82:'⛈️ Heavy showers',
  95:'⛈️ Thunderstorm', 96:'⛈️ Thunderstorm', 99:'⛈️ Thunderstorm'
};

async function fetchWeather() {
  try {
    /* Open-Meteo free endpoint — no API key needed */
    const url = 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${city().lat}&longitude=${city().lon}` +
      '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m' +
      '&timezone=Asia%2FKolkata&forecast_days=1';

    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const cur  = data.current;

    const temp     = Math.round(cur.temperature_2m);
    const feels    = Math.round(cur.apparent_temperature);
    const humidity = cur.relative_humidity_2m;
    const wmo      = cur.weather_code;
    const desc     = WMO_CODES[wmo] || '🌡️';
    const descShort = desc.split(' ').slice(1).join(' '); // drop emoji for chip

    /* Classify heat level */
    const heatCls = temp >= 38 ? 'hot' : temp >= 30 ? 'warm' : 'mild';

    /* Update topbar temperature chip */
    const chip = document.getElementById('tempChip');
    chip.className = `temp-chip ${heatCls}`;
    chip.title     = `Chennai · ${temp}°C (feels ${feels}°C) · Humidity ${humidity}% · ${desc}`;
    document.getElementById('tempVal').textContent  = temp;
    document.getElementById('tempDesc').textContent = descShort;

    /* Update header badge */
    const badge = document.getElementById('tempBadge');
    if (badge) {
      badge.textContent = `🌡️ ${temp}°C · ${desc} · Feels ${feels}°C · ${humidity}% humidity`;
    }

  } catch (e) {
    /* Silently fail — chips stay showing "—" */
    const badge = document.getElementById('tempBadge');
    if (badge) badge.textContent = '🌡️ Weather unavailable';
  }
}
//  Strategy: try multiple CORS proxies × multiple sources
//  Cache in localStorage (refreshes once after 06:00 IST)
// ──────────────────────────────────────────────────────
const PRICE_CACHE_KEY = 'taint_prices_v1';
const PROXIES = [
  /* corsproxy.io removed - third-party CORS proxy risk */
  /* allorigins.win removed - third-party CORS proxy risk */
];
/* Sources per fuel with multiple regex patterns */
const SOURCES = {
  petrol: [
    { url:'https://www.goodreturns.in/petrol-price-in-chennai.html', pats:[
      /<title[^>]*>[^₹]*₹\s*([0-9]{2,3}\.[0-9]{1,2})/i,
      /class="[^"]*price[^"]*"[^>]*>[\s₹]*([0-9]{2,3}\.[0-9]{1,2})/i,
      /([0-9]{2,3}\.[0-9]{1,2})\s*(?:per litre|\/litre|\/L)/i
    ]},
    { url:'https://www.mypetrolprice.com/petrol-price-in-chennai.aspx', pats:[
      /<title[^>]*>[^₹]*₹\s*([0-9]{2,3}\.[0-9]{1,2})/i,
      /([0-9]{2,3}\.[0-9]{1,2})\s*(?:per litre|\/L)/i
    ]}
  ],
  diesel: [
    { url:'https://www.goodreturns.in/diesel-price-in-chennai.html', pats:[
      /<title[^>]*>[^₹]*₹\s*([0-9]{2,3}\.[0-9]{1,2})/i,
      /([0-9]{2,3}\.[0-9]{1,2})\s*(?:per litre|\/litre|\/L)/i
    ]},
    { url:'https://www.mypetrolprice.com/diesel-price-in-chennai.aspx', pats:[
      /<title[^>]*>[^₹]*₹\s*([0-9]{2,3}\.[0-9]{1,2})/i,
      /([0-9]{2,3}\.[0-9]{1,2})\s*(?:per litre|\/L)/i
    ]}
  ],
  cng: [
    { url:'https://www.goodreturns.in/cng-price-in-chennai.html', pats:[
      /<title[^>]*>[^₹]*₹\s*([0-9]{2,3}\.[0-9]{1,2})/i,
      /([0-9]{2,3}\.[0-9]{1,2})\s*(?:per kg|\/kg)/i
    ]}
  ]
};

function istToday() {
  return new Date(Date.now() + 5.5*3600000).toISOString().slice(0,10);
}
function needsFetch() {
  try {
    const c = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY));
    if (!c?.petrol) return true;
    const sixAm = new Date(istToday()+'T00:30:00Z').getTime(); // 06:00 IST = 00:30 UTC
    return !(c.date === istToday() && c.fetchedAt >= sixAm);
  } catch { return true; }
}

async function trySource(src) {
  for (const proxyFn of PROXIES) {
    try {
      const res = await fetch(proxyFn(src.url), { signal:AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      let html;
      if (proxyFn(src.url).includes('allorigins')) {
        const j = await res.json(); html = j.contents||'';
      } else { html = await res.text(); }
      if (html.length < 200) continue;
      for (const pat of src.pats) {
        const m = html.match(pat);
        if (m) { const v = +m[1]; if (v > 30 && v < 250) return v; }
      }
    } catch {}
  }
  return null;
}

function applyPrices(p, source) {
  PRICES = { ...DEFAULT_PRICES, ...p };
  /* Update price pills */
  document.getElementById('ppPetrol').textContent = `₹${PRICES.petrol.toFixed(2)}/L`;
  document.getElementById('ppDiesel').textContent = `₹${PRICES.diesel.toFixed(2)}/L`;
  document.getElementById('ppCng').textContent    = `₹${PRICES.cng.toFixed(2)}/kg`;
  document.getElementById('ppElec').textContent   = `₹${PRICES.electric.toFixed(2)}/kWh`;
  /* Update badge */
  const badge = document.getElementById('priceBadge');
  const MAP = {
    live:     { cls:'live',     txt:'🟢 Live'     },
    cached:   { cls:'cached',   txt:'🔵 Cached'   },
    fallback: { cls:'fallback', txt:'🟡 Fallback' },
    loading:  { cls:'loading',  txt:'⏳ Fetching…'}
  };
  const m = MAP[source]||MAP.fallback;
  badge.className = `pbadge ${m.cls}`;
  badge.textContent = m.txt;
  const src = source==='live' ? '🌐 Live from goodreturns.in'
            : source==='cached' ? `📦 Cached ${p.date||'today'} · refreshes 06:00 IST`
            : '⚠️ Using last known prices';
  document.getElementById('priceUpdated').textContent = src;
  /* Rerender cost table with new prices */
  if (lastVeh) renderCost(lastVeh, lastFuel);
}

async function fetchLivePrices(force=false) {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('spinning');
  applyPrices(PRICES, 'loading');
  /* Serve valid cache first */
  if (!force && !needsFetch()) {
    try {
      const c = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY));
      if (c?.petrol) { btn.classList.remove('spinning'); applyPrices(c,'cached'); return; }
    } catch {}
  }
  /* Fetch all three fuels concurrently */
  try {
    const [petrol,diesel,cng] = await Promise.all([
      trySource(SOURCES.petrol[0]) ?? trySource(SOURCES.petrol[1]),
      trySource(SOURCES.diesel[0]) ?? trySource(SOURCES.diesel[1]),
      trySource(SOURCES.cng[0])
    ]);
    if (petrol) {
      const live = { petrol, diesel:diesel||DEFAULT_PRICES.diesel, cng:cng||DEFAULT_PRICES.cng, electric:DEFAULT_PRICES.electric, date:istToday(), fetchedAt:Date.now() };
      try { localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(live)); } catch {}
      btn.classList.remove('spinning'); applyPrices(live,'live'); return;
    }
  } catch {}
  /* Try stale cache before hardcoded fallback */
  try {
    const stale = JSON.parse(localStorage.getItem(PRICE_CACHE_KEY));
    if (stale?.petrol) { btn.classList.remove('spinning'); applyPrices(stale,'cached'); return; }
  } catch {}
  btn.classList.remove('spinning'); applyPrices(DEFAULT_PRICES,'fallback');
}

document.getElementById('refreshBtn').addEventListener('click', () => fetchLivePrices(true));

// ──────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────
//  ROUTE MAP — Leaflet + Nominatim geocoding + OSRM routing
//  Free, no API key. Map allows click-to-place From/To pins.
// ──────────────────────────────────────────────────────

let routeTimer, acTimers = {};
let routeMap = null, routePolyline = null;
let pinFrom = null, pinTo = null;
let coordFrom = null, coordTo = null;
let routeMapReady = false;
/* Which pin the next map click sets: 'from' → 'to' → 'from' … */
let nextPin = 'from';

function hasLeaflet() {
  return !!(window.L && typeof L.map === 'function' && typeof L.tileLayer === 'function');
}

/* Haversine straight-line distance between two lat/lon points */
function haversine(lat1,lon1,lat2,lon2){
  const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

/* Format seconds to "X hr Y min" or "Y min" */
function fmtTime(sec){
  const m=Math.round(sec/60);
  return m<60?`${m} min`:`${Math.floor(m/60)} hr ${m%60} min`;
}

/* Custom Leaflet divIcon markers */
function makePin(type){
  return L.divIcon({
    className:'',
    html:`<div class="rm-pin rm-pin-${type}">${type==='from'?'A':'B'}</div>`,
    iconSize:[26,26], iconAnchor:[13,13], popupAnchor:[0,-15]
  });
}

/* Initialise the small route-selection map */
function initRouteMap(){
  if(routeMapReady) return;
  if(!hasLeaflet()) {
    const wrap = document.getElementById('routeMapWrap');
    if (wrap) wrap.innerHTML = '<div class="route-err show">Map tools are unavailable. Route text search still works.</div>';
    return;
  }
  routeMapReady = true;

  routeMap = L.map('routeMap',{zoomControl:true,attributionControl:false})
              .setView([city().lat, city().lon], city().zoom);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:19,attribution:'© OpenStreetMap'}).addTo(routeMap);

  /* Attribution tiny bottom-right */
  L.control.attribution({position:'bottomright',prefix:false})
    .addAttribution('© <a href="https://openstreetmap.org">OSM</a>').addTo(routeMap);

  routeMap.on('click', e => {
    const {lat,lng} = e.latlng;
    if(nextPin==='from'){
      placePin('from',lat,lng);
      reverseGeocode(lat,lng,'from');
      nextPin = 'to';
      updateMapHint();
    } else {
      placePin('to',lat,lng);
      reverseGeocode(lat,lng,'to');
      nextPin = 'from';
      updateMapHint();
    }
    if(coordFrom && coordTo) fetchRouteFromCoords();
  });

  routeMap.invalidateSize();
}

function updateMapHint(){
  const h = document.getElementById('routeMapHint');
  if(h) h.textContent = nextPin==='from'
    ? '🖱️ Click map to move From pin'
    : '🖱️ Click map to place To pin';
}

/* Place or move a draggable pin marker */
function placePin(type, lat, lng){
  if(!hasLeaflet() || !routeMap) return;
  if(type==='from'){
    coordFrom = {lat,lon:lng};
    if(pinFrom) pinFrom.setLatLng([lat,lng]);
    else {
      pinFrom = L.marker([lat,lng],{icon:makePin('from'),draggable:true}).addTo(routeMap);
      pinFrom.on('dragend', e => {
        const p=e.target.getLatLng();
        coordFrom={lat:p.lat,lon:p.lng};
        reverseGeocode(p.lat,p.lng,'from');
        autoUpdateCityVisionArea(p.lat,p.lng);
        if(coordTo) fetchRouteFromCoords();
      });
    }
  } else {
    coordTo = {lat,lon:lng};
    if(pinTo) pinTo.setLatLng([lat,lng]);
    else {
      pinTo = L.marker([lat,lng],{icon:makePin('to'),draggable:true}).addTo(routeMap);
      pinTo.on('dragend', e => {
        const p=e.target.getLatLng();
        coordTo={lat:p.lat,lon:p.lng};
        reverseGeocode(p.lat,p.lng,'to');
        if(coordFrom) fetchRouteFromCoords();
      });
    }
  }
}

/* Reverse geocode a lat/lon to fill the text input */
async function reverseGeocode(lat,lon,which){
  try {
    const url=`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const r=await fetch(url,{headers:{'User-Agent':'TAINT-Chennai/1.0'},signal:AbortSignal.timeout(6000)});
    const d=await r.json();
    const name = d.display_name.split(',').slice(0,3).join(', ');
    const inp=document.getElementById(which==='from'?'fromLoc':'toLoc');
    const clr=document.getElementById(which==='from'?'fromClear':'toClear');
    if(inp){ inp.value=name; clr.classList.add('show'); }
  } catch {}
}

/* Draw route polyline on routeMap using OSRM driving geometry */
async function drawRoute(){
  if(!coordFrom||!coordTo||!routeMap) return;
  const profile = getOSRMProfile();
  try {
    const url=`https://router.project-osrm.org/route/v1/${profile}/${coordFrom.lon},${coordFrom.lat};${coordTo.lon},${coordTo.lat}?overview=full&geometries=geojson`;
    const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
    const d=await r.json();
    if(d.code!=='Ok'||!d.routes.length) return;

    const geom = d.routes[0].geometry;
    if(routePolyline) routeMap.removeLayer(routePolyline);
    routePolyline = L.geoJSON(geom,{
      style:{color:'#34d399',weight:4,opacity:.85,lineJoin:'round',lineCap:'round'}
    }).addTo(routeMap);

    /* Fit map to show full route */
    const bounds = routePolyline.getBounds().pad(0.12);
    routeMap.fitBounds(bounds);
  } catch {}
}

/* Determine OSRM profile from currently selected vehicle category */
function getOSRMProfile(){
  const cat = document.querySelector('.cat-btn.active')?.dataset.cat || 'four';
  const fuel = document.querySelector('.fp.active')?.dataset.fuel || 'petrol';
  if(fuel==='cycle'||fuel==='bicycle') return 'cycling';
  if(fuel==='walk'||cat==='walk') return 'foot';
  return 'driving';
}

/* Nominatim geocoding — returns {lat, lon} */
async function geocode(q){
  const url=`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=in`;
  const res=await fetch(url,{headers:{'User-Agent':'TAINT-Chennai/1.0'},signal:AbortSignal.timeout(7000)});
  const data=await res.json();
  if(!data.length) throw new Error('not found');
  return {lat:+data[0].lat,lon:+data[0].lon,name:data[0].display_name};
}

/* Nominatim suggestions for autocomplete */
async function fetchSuggestions(q,which){
  if(q.length<3) return [];
  const url=`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q+' '+city().name)}&format=json&limit=5&countrycodes=in`;
  const r=await fetch(url,{headers:{'User-Agent':'TAINT-Chennai/1.0'},signal:AbortSignal.timeout(5000)});
  const d=await r.json();
  return d.map(x=>({name:x.display_name.split(',').slice(0,3).join(', '),lat:+x.lat,lon:+x.lon}));
}

function showAc(which, items){
  const list=document.getElementById(which==='from'?'fromAc':'toAc');
  if(!items.length){ list.classList.remove('open'); return; }
  list.innerHTML=items.map((it,i)=>
    `<div class="ac-item" data-i="${i}">${escapeHTML(it.name)}</div>`).join('');
  list.classList.add('open');
  list.querySelectorAll('.ac-item').forEach((el,i)=>{
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      selectSuggestion(which, items[i]);
    });
  });
}

function hideAc(which){
  document.getElementById(which==='from'?'fromAc':'toAc').classList.remove('open');
}

function selectSuggestion(which, item){
  const inp=document.getElementById(which==='from'?'fromLoc':'toLoc');
  const clr=document.getElementById(which==='from'?'fromClear':'toClear');
  inp.value=item.name; clr.classList.add('show');
  hideAc(which);
  placePin(which, item.lat, item.lon);
  if(which==='from') coordFrom={lat:item.lat,lon:item.lon};
  else               coordTo  ={lat:item.lat,lon:item.lon};
  if(!routeMapReady) initRouteMap();
  if(which==='from'&&coordTo) fetchRouteFromCoords();
  if(which==='to'  &&coordFrom) fetchRouteFromCoords();
  if(coordFrom&&coordTo) fetchRoute();
}

/* ── Route factors ─────────────────────────────────────
   Each mode has a base distance source and adjustment factor.
   Factor > 1 means the effective route is longer than the
   straight OSRM driving distance (e.g. bus takes indirect roads).
   ────────────────────────────────────────────────────── */
const ROUTE_FACTORS = {
  drive  : { factor: 1.00, label: 'Direct road route',                  src: 'drive' },
  two    : { factor: 1.00, label: 'Two-wheeler road route',             src: 'drive' },
  bus    : { factor: 1.15, label: '+15% indirect bus route',            src: 'drive' },
  shared : { factor: 1.10, label: '+10% shared/auto route variance',    src: 'drive' },
  cycle  : { factor: 1.00, label: 'Cycling path (OSRM cycling profile)',src: 'cycle' },
  walk   : { factor: 1.00, label: 'Walking path (OSRM foot profile)',   src: 'walk'  },
  transit: { factor: 0.95, label: '−5% rail route (direct alignment)',  src: 'drive' },
};

let lastDriveDist = null, lastCycleDist = null, lastWalkDist = null;
let lastStraight  = null;
let lastDriveSec  = null, lastCycleSec  = null, lastWalkSec  = null;
let distLinked    = true;

/* Time-of-day congestion (Chennai peak hours) */
function getCongestFactor(){
  const h = new Date().getHours();
  if((h>=8&&h<10)||(h>=17&&h<20)) return {mult:1.35,label:'🔴 Peak hour (+35%)'};
  if(h>=10&&h<17)                  return {mult:1.12,label:'🟡 Off-peak (+12%)'};
  if((h>=20&&h<23)||(h>=6&&h<8)) return {mult:1.08,label:'🟢 Shoulder (+8%)'};
  return                                  {mult:1.03,label:'🟢 Night / Low (+3%)'};
}

/* Find nearest zone in current city to a GPS coordinate */
function detectZone(lat, lon) {
  const zones = city().zones;
  let nearest = null, minDist = Infinity;
  zones.forEach(z => {
    const d = Math.sqrt((z.lat-lat)**2 + (z.lon-lon)**2);
    if (d < minDist) { minDist = d; nearest = z; }
  });
  /* Only match if within ~30 km of any zone (0.27° ≈ 30 km) */
  return minDist < 0.27 ? nearest?.key : null;
}
function autoUpdateCityVisionArea(lat,lon){
  const zone=detectZone(lat,lon);
  if(!zone) return;
  const sel=document.getElementById('satArea');
  if(sel&&sel.value!==zone){ sel.value=zone; flyToArea(zone); }
}

/* Link badge state */
function setDistLinked(linked){
  distLinked=linked;
  const badge=document.getElementById('distLinkBadge');
  const reset=document.getElementById('distResetBtn');
  if(badge){ badge.textContent=linked?'🔗 linked to route':'✏️ manual'; badge.classList.toggle('manual',!linked); }
  if(reset) reset.style.display=linked?'none':'inline';
}
document.getElementById('distResetBtn')?.addEventListener('click',()=>{ setDistLinked(true); applyEffectiveDist(); });
document.getElementById('distance')?.addEventListener('input',()=>{ if(distLinked) setDistLinked(false); scheduleCalc(); });

function getModeKey(){
  const cat =document.querySelector('.cat-btn.active')?.dataset.cat  ||'four';
  const fuel=document.querySelector('.fp.active')?.dataset.fuel||'petrol';
  if(cat==='transit')                  return 'transit';
  if(fuel==='cycle'||fuel==='bicycle') return 'cycle';
  if(fuel==='walk')                    return 'walk';
  if(cat==='shared')                   return 'shared';
  if(cat==='two')                      return 'two';
  return 'drive';
}

function effectiveDist(){
  const mk=getModeKey(),rf=ROUTE_FACTORS[mk]||ROUTE_FACTORS.drive;
  let base=rf.src==='cycle'?lastCycleDist??lastDriveDist:rf.src==='walk'?lastWalkDist??lastDriveDist:lastDriveDist;
  if(base==null) return null;
  const cg=(mk==='drive'||mk==='two'||mk==='shared'||mk==='bus')?getCongestFactor().mult:1.0;
  return +(base*rf.factor*cg).toFixed(1);
}

function applyEffectiveDist(){
  const eff=effectiveDist(); if(eff==null) return;
  const mk=getModeKey(),rf=ROUTE_FACTORS[mk]||ROUTE_FACTORS.drive;
  const cg=(mk==='drive'||mk==='two'||mk==='shared'||mk==='bus')?getCongestFactor():null;
  const base=rf.src==='cycle'?lastCycleDist:rf.src==='walk'?lastWalkDist:lastDriveDist;
  const effEl=document.getElementById('rrEffective');
  if(effEl) effEl.textContent=eff+' km';
  const fr=document.getElementById('rrFactorRow');
  if(fr&&base!=null){
    const t=[];
    t.push(`<span class="rr-factor-tag base">base ${base.toFixed(1)} km</span>`);
    if(rf.factor!==1.0){ t.push(`<span class="rr-factor-arrow">×</span>`); t.push(`<span class="rr-factor-tag mod">${rf.factor.toFixed(2)} ${rf.label}</span>`); }
    if(cg){ t.push(`<span class="rr-factor-arrow">×</span>`); t.push(`<span class="rr-congestion">${cg.label}</span>`); }
    t.push(`<span class="rr-factor-arrow">=</span>`);
    t.push(`<span class="rr-factor-tag mod">${eff} km effective</span>`);
    fr.innerHTML=t.join(' ');
  }
  if(distLinked){ const d=document.getElementById('distance'); if(d) d.value=eff; scheduleCalc(); }
}

function renderPolyline(geometry,color){
  if(!routeMap||!geometry) return;
  if(routePolyline) routeMap.removeLayer(routePolyline);
  routePolyline=L.geoJSON(geometry,{style:{color,weight:4,opacity:.88,lineJoin:'round',lineCap:'round'}}).addTo(routeMap);
  routeMap.fitBounds(routePolyline.getBounds().pad(0.12));
}

const POLY_COLOR={drive:'#34d399',two:'#34d399',shared:'#fb923c',bus:'#fb923c',
                  cycle:'#60a5fa',walk:'#f472b6',transit:'#a78bfa'};

async function fetchRoute(){
  const from=document.getElementById('fromLoc').value.trim();
  const to  =document.getElementById('toLoc').value.trim();
  if(!from||!to) return;
  const spin=document.getElementById('routeSpin'),res=document.getElementById('routeResult'),err=document.getElementById('routeErr');
  spin.classList.add('show'); res.classList.add('show'); err.classList.remove('show');
  try{
    const [A,B]=await Promise.all([geocode(from),geocode(to)]);
    coordFrom={lat:A.lat,lon:A.lon}; coordTo={lat:B.lat,lon:B.lon};
    if(!routeMapReady) initRouteMap();
    placePin('from',A.lat,A.lon); placePin('to',B.lat,B.lon);
    autoUpdateCityVisionArea(A.lat,A.lon);
    lastStraight=haversine(A.lat,A.lon,B.lat,B.lon);
    async function osrm(profile){
      const r=await fetch(`https://router.project-osrm.org/route/v1/${profile}/${A.lon},${A.lat};${B.lon},${B.lat}?overview=full&geometries=geojson`,{signal:AbortSignal.timeout(10000)});
      const d=await r.json(); if(d.code!=='Ok'||!d.routes.length) throw new Error(); return d.routes[0];
    }
    const [dr,cr,wr]=await Promise.allSettled([osrm('driving'),osrm('cycling'),osrm('foot')]);
    const drive=dr.status==='fulfilled'?dr.value:null;
    const cycle=cr.status==='fulfilled'?cr.value:null;
    const walk =wr.status==='fulfilled'?wr.value:null;
    lastDriveDist=drive?drive.distance/1000:lastStraight*1.30;
    lastCycleDist=cycle?cycle.distance/1000:lastDriveDist*1.05;
    lastWalkDist =walk ?walk.distance /1000:lastDriveDist*1.02;
    lastDriveSec =drive?drive.duration:lastDriveDist/25*3600;
    lastCycleSec =cycle?cycle.duration:lastCycleDist/12*3600;
    lastWalkSec  =walk ?walk.duration :lastWalkDist /5*3600;
    const mk=getModeKey();
    const geom=mk==='cycle'?(cycle?.geometry||drive?.geometry):mk==='walk'?(walk?.geometry||drive?.geometry):drive?.geometry;
    renderPolyline(geom,POLY_COLOR[mk]||'#34d399');
    spin.classList.remove('show');
    document.getElementById('rrDist').textContent=lastDriveDist.toFixed(1);
    document.getElementById('rrLine').textContent=lastStraight.toFixed(1);
    const cg=getCongestFactor();
    document.getElementById('rrTimeDrive').textContent=fmtTime(lastDriveSec*cg.mult);
    document.getElementById('rrTimeBus')  .textContent=fmtTime(lastDriveSec*cg.mult*1.45);
    document.getElementById('rrTimeCycle').textContent=fmtTime(lastCycleSec);
    document.getElementById('rrTimeWalk') .textContent=fmtTime(lastWalkSec);
    // Transit time: metro/suburban runs faster than road but adds wait time (~5 min avg)
    const transitSec = lastDriveSec * 0.80 + 300; // 80% road time + 5 min avg wait
    document.getElementById('rrTimeTransit').textContent=fmtTime(transitSec);
    setDistLinked(true);
    syncModeChip();
    sbPost('route_logs', {
      city_key     : currentCityKey,
      city_name    : city().name,
      from_label   : from,
      to_label     : to,
      distance_km  : lastDriveDist,
      mode         : getModeKey(),
      source       : 'ui',
      route_payload: {
        straightKm: lastStraight,
        driveKm   : lastDriveDist,
        cycleKm   : lastCycleDist,
        walkKm    : lastWalkDist
      }
    }, 'functional');
    sbLogProcess('route_lookup', 'succeeded',
      { from, to, city: currentCityKey },
      { driveKm:lastDriveDist, cycleKm:lastCycleDist, walkKm:lastWalkDist });
  }catch(e){
    spin.classList.remove('show'); res.classList.remove('show'); err.classList.add('show');
    sbLogProcess('route_lookup', 'failed', { from, to, city: currentCityKey }, null, e.message || 'Route lookup failed');
  }
}

async function fetchRouteFromCoords(){
  if(!coordFrom||!coordTo) return;
  fetchRoute();
}

function syncModeChip(){
  const mk=getModeKey();
  document.querySelectorAll('.rr-mode-chip').forEach(c=>c.classList.remove('active'));
  const chipMap={drive:'chipDrive',two:'chipDrive',shared:'chipBus',bus:'chipBus',
                 cycle:'chipCycle',walk:'chipWalk',transit:'chipTransit'};
  document.getElementById(chipMap[mk]||'chipDrive')?.classList.add('active');
  if(routePolyline) routePolyline.setStyle({color:POLY_COLOR[mk]||'#34d399'});
  applyEffectiveDist();
}

document.querySelectorAll('.cat-btn').forEach(b=>b.addEventListener('click',()=>setTimeout(syncModeChip,0)));
document.addEventListener('click',e=>{ if(e.target.closest?.('.fp')) setTimeout(syncModeChip,0); });

/* Route input wiring — autocomplete + debounce */
['fromLoc','toLoc'].forEach(which=>{
  const id=which;
  const inp=document.getElementById(id);
  const clr=document.getElementById(id==='fromLoc'?'fromClear':'toClear');
  const wh =id==='fromLoc'?'from':'to';

  inp.addEventListener('input',()=>{
    clr.classList.toggle('show',inp.value.length>0);
    clearTimeout(acTimers[wh]);
    acTimers[wh]=setTimeout(async()=>{
      const suggestions=await fetchSuggestions(inp.value,wh).catch(()=>[]);
      showAc(wh,suggestions);
    },350);
    clearTimeout(routeTimer);
    routeTimer=setTimeout(fetchRoute,900);
  });

  inp.addEventListener('keydown',e=>{
    if(e.key==='Enter'){ clearTimeout(routeTimer); hideAc(wh); fetchRoute(); }
    if(e.key==='Escape') hideAc(wh);
  });

  inp.addEventListener('blur',()=>{ setTimeout(()=>hideAc(wh),150); });

  clr.addEventListener('click',()=>{
    inp.value=''; clr.classList.remove('show'); hideAc(wh);
    document.getElementById('routeResult').classList.remove('show');
    document.getElementById('routeErr').classList.remove('show');
    if(wh==='from'){ if(pinFrom){routeMap.removeLayer(pinFrom);pinFrom=null;} coordFrom=null; }
    else           { if(pinTo)  {routeMap.removeLayer(pinTo);  pinTo  =null;} coordTo  =null; }
    if(routePolyline){ routeMap.removeLayer(routePolyline); routePolyline=null; }
  });
});

document.getElementById('swapBtn').addEventListener('click',()=>{
  const f=document.getElementById('fromLoc'),t=document.getElementById('toLoc');
  [f.value,t.value]=[t.value,f.value];
  [coordFrom,coordTo]=[coordTo,coordFrom];
  document.getElementById('fromClear').classList.toggle('show',f.value.length>0);
  document.getElementById('toClear')  .classList.toggle('show',t.value.length>0);
  /* Swap markers */
  if(pinFrom&&coordFrom) pinFrom.setLatLng([coordFrom.lat,coordFrom.lon]);
  if(pinTo  &&coordTo)   pinTo  .setLatLng([coordTo.lat,  coordTo.lon  ]);
  if(f.value&&t.value) fetchRoute();
});

/* Initialise route map immediately so it's ready when the page loads */
document.addEventListener('DOMContentLoaded',()=>{ initRouteMap(); }, {once:true});

// ──────────────────────────────────────────────────────
//  LOCAL STORAGE HELPERS — usage tracking
// ──────────────────────────────────────────────────────
function mkKey() {
  const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function getStats() { try { return JSON.parse(localStorage.getItem('taint_stats')||'{}'); } catch { return {}; } }
function saveStats(s) { try { localStorage.setItem('taint_stats',JSON.stringify(s)); } catch {} }

function bumpLocal() {
  const s=getStats(), mk=mkKey();
  s.monthly=s.monthly||{}; s.monthly[mk]=(s.monthly[mk]||0)+1;
  s.total=(s.total||0)+1; s.firstSeen=s.firstSeen||new Date().toISOString();
  saveStats(s); renderTracker(); updateMonthStat(); updateAdminStats();
}

function updateMonthStat() {
  const s=getStats(), mk=mkKey();
  document.getElementById('statMonth').textContent = (s.monthly?.[mk]||0).toLocaleString();
  updateAdminStats();
}

/* Render 6-month bar chart */
function renderTracker() {
  const s=getStats(); const monthly=s.monthly||{};
  const now=new Date(); const months=[];
  for(let i=5;i>=0;i--){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months.push({key,label:d.toLocaleString('default',{month:'short'}),count:monthly[key]||0});
  }
  const max=Math.max(...months.map(m=>m.count),1);
  const curKey=mkKey();
  const chart=document.getElementById('monthChart'); chart.innerHTML='';
  const lbls=document.getElementById('monthLbls');  lbls.innerHTML='';
  months.forEach(m=>{
    const pct=Math.max((m.count/max)*100, m.count>0?6:3);
    const isCur=m.key===curKey;
    const wrap=document.createElement('div'); wrap.className='mb-wrap';
    wrap.innerHTML=`${m.count>0?`<div class="mb-count">${m.count}</div>`:''}<div class="mb-bar${isCur?' cur':m.count>0?' has':''}" style="height:${pct}%"></div>`;
    chart.appendChild(wrap);
    const lb=document.createElement('div'); lb.className='month-lbl'; lb.textContent=m.label;
    lbls.appendChild(lb);
  });
  const total=Object.values(monthly).reduce((a,b)=>a+b,0);
  document.getElementById('totalLocal').textContent=total.toLocaleString();
  if(s.firstSeen) document.getElementById('firstSeenLbl').textContent=`since ${new Date(s.firstSeen).toLocaleDateString('en-IN',{month:'short',year:'numeric'})}`;
  updateAdminStats();
}

function resetControlsToDefaults(scopeSelector) {
  const root = document.querySelector(scopeSelector);
  if (!root) return;
  root.querySelectorAll('input, select, textarea').forEach(ctrl => {
    if (ctrl.type === 'checkbox' || ctrl.type === 'radio') {
      ctrl.checked = ctrl.defaultChecked;
    } else if (ctrl.tagName === 'SELECT') {
      [...ctrl.options].forEach(opt => { opt.selected = opt.defaultSelected; });
      if (ctrl.selectedIndex < 0 && ctrl.options.length) ctrl.selectedIndex = 0;
    } else {
      ctrl.value = ctrl.defaultValue;
    }
  });
}

function resetRouteState() {
  ['fromLoc','toLoc'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  ['fromClear','toClear'].forEach(id => document.getElementById(id)?.classList.remove('show'));
  ['fromAc','toAc'].forEach(id => {
    const ac = document.getElementById(id);
    if (ac) { ac.innerHTML = ''; ac.classList.remove('show'); }
  });
  document.getElementById('routeResult')?.classList.remove('show');
  document.getElementById('routeErr')?.classList.remove('show');
  if (routeMap && routePolyline) { routeMap.removeLayer(routePolyline); routePolyline = null; }
  if (routeMap && pinFrom) { routeMap.removeLayer(pinFrom); pinFrom = null; }
  if (routeMap && pinTo) { routeMap.removeLayer(pinTo); pinTo = null; }
  coordFrom = null;
  coordTo = null;
  distLinked = true;
}

function resetCityVisionState() {
  lastPerPaxKg = 0;
  const visionGrid = document.getElementById('visionGrid');
  if (visionGrid) visionGrid.style.display = 'none';
  const promptDetails = document.getElementById('promptDetails');
  if (promptDetails) promptDetails.style.display = 'none';
  const compare = document.getElementById('visionCompare');
  if (compare) compare.style.display = 'none';
  const genCta = document.getElementById('genCta');
  if (genCta) genCta.style.display = 'none';
  const genText = document.getElementById('genBtnText');
  if (genText) genText.textContent = 'Apply Smog Proxy';
  const genIcon = document.getElementById('genBtnIcon');
  if (genIcon) genIcon.textContent = '↻';
  const effect = document.getElementById('mapEffect');
  if (effect) effect.style.filter = 'none';
  const smogOverlay = document.getElementById('smogOverlay');
  if (smogOverlay) {
    smogOverlay.style.background = 'transparent';
    smogOverlay.style.opacity = '0';
  }
  const viFill = document.getElementById('viBarFill');
  if (viFill) viFill.style.width = '0%';
  const viText = document.getElementById('viIntensityText');
  if (viText) {
    viText.className = 'vi-badge';
    viText.textContent = 'Calculate above to see impact ↑';
  }
  const viDetail = document.getElementById('viDetail');
  if (viDetail) viDetail.textContent = '';
}

function resetAppToDefaults() {
  try { localStorage.removeItem('taint_stats'); } catch {}

  currentCat = 'two';
  currentFuel = 'petrol';
  currentHtype = 'mild';

  resetControlsToDefaults('#commuteSection');
  resetControlsToDefaults('#workplaceSection');
  resetControlsToDefaults('#homeSection');
  resetControlsToDefaults('#taintSection');
  resetRouteState();

  document.getElementById('distance').value = '10';
  document.getElementById('passengers').value = '1';
  document.getElementById('pucStatus').value = 'valid_clean';
  document.getElementById('pucCo').value = '';
  document.getElementById('pucSmoke').value = '';

  document.querySelectorAll('.cat-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.cat === currentCat));
  document.querySelectorAll('.hp-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.htype === currentHtype));

  if (typeof setCity === 'function') setCity('chennai');
  if (typeof setDistLinked === 'function') setDistLinked(true);

  renderFuelPills(currentCat);
  populateVehicles();
  updatePucUI();
  resetCityVisionState();

  if (typeof calculateWorkplace === 'function') calculateWorkplace();
  if (typeof calculateHome === 'function') calculateHome();
  mtSaved = {};
  if (typeof mtRenderStep === 'function') { mtStep = 0; mtRenderStep(); }

  renderTracker();
  updateMonthStat();
  updateAdminStats();
  if (typeof setMode === 'function') setMode('commute');
  notify('Defaults restored.', 'success', 'Reset');
}

document.getElementById('resetBtn').addEventListener('click', resetAppToDefaults);

// ──────────────────────────────────────────────────────
//  FIREBASE — global user & calculation counter
// ──────────────────────────────────────────────────────
function getOrCreateUID() {
  let uid = localStorage.getItem('taint_uid');
  if (!uid) { uid=(crypto.randomUUID?.()||'u'+Math.random().toString(36).slice(2)+Date.now()); localStorage.setItem('taint_uid',uid); }
  return uid;
}

// ──────────────────────────────────────────────────────
//  SUPABASE GLOBAL STATS
//  Replaces Firebase Realtime Database.
//  Uses plain fetch against the Supabase REST + RPC API.
//  No SDK required — the anon key is safe to expose.
// ──────────────────────────────────────────────────────

const SB_HEADERS = () => {
  const headers = {
    'apikey'      : SUPABASE_CONFIG.anonKey,
    'Content-Type': 'application/json'
  };
  if (!SUPABASE_CONFIG.anonKey.startsWith('sb_publishable_')) {
    headers.Authorization = 'Bearer ' + SUPABASE_CONFIG.anonKey;
  }
  return headers;
};
const SB_CONFIGURED = () => {
  const url = SUPABASE_CONFIG.url;
  const key = SUPABASE_CONFIG.anonKey;
  return !!(
    url &&
    key &&
    url !== 'YOUR_PROJECT_URL' &&
    key !== 'YOUR_ANON_PUBLIC_KEY' &&
    /^https?:\/\/[^/\s]+/.test(url)
  );
};

async function SB_AUTH_HEADERS() {
  let token = SUPABASE_CONFIG.anonKey;
  try {
    if (supabaseClient) {
      const { data } = await supabaseClient.auth.getSession();
      token = data.session?.access_token || token;
    }
  } catch {}
  const headers = {
    'apikey'      : SUPABASE_CONFIG.anonKey,
    'Content-Type': 'application/json'
  };
  if (token && !token.startsWith('sb_publishable_')) {
    headers.Authorization = 'Bearer ' + token;
  }
  return headers;
}

async function sbConnectionStatus() {
  if (!SB_CONFIGURED()) {
    return { ok:false, reason:'Supabase config missing. Fill supabase-config.js.' };
  }
  try {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/stats?select=key&limit=1`, {
      headers: await SB_AUTH_HEADERS()
    }, { label:'Supabase connection', timeout:8000 });
    return { ok:true, reason:'Supabase connected' };
  } catch (e) {
    return { ok:false, reason:e.message || 'Supabase connection failed' };
  }
}

window.taintCheckSupabase = sbConnectionStatus;

/* Fetch a single stat value from the stats table */
async function sbGetStat(key) {
  const r = await appFetch(
    `${SUPABASE_CONFIG.url}/rest/v1/stats?key=eq.${key}&select=value`,
    { headers: SB_HEADERS() }
  , { label:'stats read', timeout:8000, retries:1 });
  const d = await r.json();
  return d[0]?.value ?? 0;
}

/* Atomically increment a stat via the increment_stat RPC function */
async function sbIncrement(key) {
  await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/increment_stat`, {
    method : 'POST',
    headers: SB_HEADERS(),
    body   : JSON.stringify({ stat_key: key })
  }, { label:'stats increment', timeout:8000, retries:1 });
}

function sbAuthUserId() {
  return currentUser?.provider === 'supabase' ? currentUser.id : null;
}

const SB_SIGNED_IN_DATA_TABLES = new Set([
  'calculation_logs',
  'carbon_profiles',
  'product_clicks',
  'product_purchases',
  'route_logs'
]);

async function sbPost(table, payload, kind='functional') {
  if (!SB_CONFIGURED()) return null;
  const authUserId = sbAuthUserId();
  if (SB_SIGNED_IN_DATA_TABLES.has(table) && !authUserId) return null;
  return enqueueWrite(async () => {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/${table}`, {
      method : 'POST',
      headers: { ...(await SB_AUTH_HEADERS()), 'Prefer':'return=representation' },
      body   : JSON.stringify({
        device_id   : getOrCreateUID(),
        auth_user_id: authUserId,
        ...payload
      })
    }, { label:`${table} insert`, timeout:9000, retries:1 });
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data[0] : data;
  });
}

async function sbUpsertProfile(user=currentUser) {
  if (!SB_CONFIGURED() || !user || user.provider !== 'supabase') return;
  try {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/profiles?on_conflict=auth_user_id`, {
      method : 'POST',
      headers: { ...(await SB_AUTH_HEADERS()), 'Prefer':'resolution=merge-duplicates,return=minimal' },
      body   : JSON.stringify({
        auth_user_id: user.id,
        username    : user.name || null,
        display_name: user.name || null,
        email       : user.email || null,
        city_key    : currentCityKey,
        city_name   : city().name
      })
    }, { label:'profile sync', timeout:9000, retries:1 });
    sbStoreSensitiveProfile(user);
  } catch (e) {
    console.warn('TAINT profile sync skipped:', e.message);
  }
}

function sbLogProcess(processType, status, requestPayload={}, responsePayload=null, errorMessage=null) {
  return sbPost('process_runs', {
    process_type    : processType,
    status,
    request_payload : requestPayload,
    response_payload: responsePayload,
    error_message   : errorMessage,
    finished_at     : status === 'started' ? null : new Date().toISOString()
  }, 'functional');
}

async function sbRegisterVisitor(cityKey=currentCityKey, cityName=city().name) {
  const uid = getOrCreateUID();
  try {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/register_device`, {
      method : 'POST',
      headers: await SB_AUTH_HEADERS(),
      body   : JSON.stringify({ p_device_id: uid, p_city_key: cityKey, p_city_name: cityName })
    }, { label:'visitor registration', timeout:8000, retries:1 });
    return;
  } catch {
    const exists = await appFetch(
      `${SUPABASE_CONFIG.url}/rest/v1/stats?key=eq.user_${uid}&select=key`,
      { headers: SB_HEADERS() }
    , { label:'visitor fallback read', timeout:8000 }).then(r => r.json());

    if (!exists.length) {
      await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/stats`, {
        method : 'POST',
        headers: { ...SB_HEADERS(), 'Prefer': 'resolution=ignore-duplicates' },
        body   : JSON.stringify({ key: 'user_' + uid, value: 1 })
      }, { label:'visitor fallback insert', timeout:8000 });
      await sbIncrement('uniqueUsers');
    }
  }
}

async function sbCreateBusinessEntity(payload={}) {
  if (!SB_CONFIGURED() || !currentUser || currentUser.provider !== 'supabase') return null;
  try {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/business_entities`, {
      method : 'POST',
      headers: { ...(await SB_AUTH_HEADERS()), 'Prefer':'return=representation' },
      body   : JSON.stringify({
        owner_auth_user_id: currentUser.id,
        entity_type       : payload.entity_type || 'workplace',
        display_name      : payload.display_name || payload.legal_name || 'TAINT business entity',
        legal_name        : payload.legal_name || null,
        sector            : payload.sector || null,
        industry          : payload.industry || null,
        city_key          : currentCityKey,
        city_name         : city().name,
        contact_email     : payload.contact_email || currentUser.email || null,
        metadata          : payload.metadata || {}
      })
    }, { label:'business entity sync', timeout:9000, retries:1 });
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (e) {
    console.warn('TAINT business entity sync skipped:', e.message);
    return null;
  }
}

async function sbUploadJsonArtifact(title, payload, metadata={}) {
  if (!supabaseClient || !currentUser || currentUser.provider !== 'supabase') return null;
  const safeTitle = String(title || 'artifact').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
  const objectPath = `${currentUser.id}/${Date.now()}-${safeTitle}.json`;
  const body = JSON.stringify(payload ?? {}, null, 2);
  const file = new Blob([body], { type:'application/json' });
  const { error } = await supabaseClient.storage
    .from('taint-json-artifacts')
    .upload(objectPath, file, { contentType:'application/json', upsert:false });
  if (error) { console.warn('TAINT JSON artifact upload skipped:', error.message); return null; }
  return sbPost('app_files', {
    bucket_id    : 'taint-json-artifacts',
    object_path  : objectPath,
    file_category: 'json',
    mime_type    : 'application/json',
    extension    : 'json',
    size_bytes   : body.length,
    title,
    metadata
  });
}

async function sbStoreSensitiveData(recordType, payload, metadata={}) {
  if (!SB_CONFIGURED() || !currentUser || currentUser.provider !== 'supabase') return null;
  return enqueueWrite(async () => {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/store_sensitive_user_data`, {
      method : 'POST',
      headers: await SB_AUTH_HEADERS(),
      body   : JSON.stringify({
        p_record_type: recordType,
        p_payload    : payload,
        p_metadata   : metadata
      })
    }, { label:'encrypted sensitive data write', timeout:10000, retries:1 });
    return res.json().catch(() => null);
  });
}

async function sbGetSensitiveData(recordType) {
  if (!SB_CONFIGURED() || !currentUser || currentUser.provider !== 'supabase') return null;
  const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/get_sensitive_user_data`, {
    method : 'POST',
    headers: await SB_AUTH_HEADERS(),
    body   : JSON.stringify({ p_record_type: recordType })
  }, { label:'encrypted sensitive data read', timeout:10000 });
  return res.json().catch(() => null);
}

function sbStoreSensitiveProfile(user=currentUser) {
  if (!user || user.provider !== 'supabase') return null;
  return sbStoreSensitiveData('profile_contact', {
    email       : user.email || null,
    displayName : user.name || null,
    cityKey     : currentCityKey,
    cityName    : city().name,
    syncedAt    : new Date().toISOString()
  }, { source:'auth_profile' });
}

window.taintUploadJsonArtifact = sbUploadJsonArtifact;
window.taintStoreSensitiveData = sbStoreSensitiveData;
window.taintGetSensitiveData = sbGetSensitiveData;

const RECENT_MODE_CONFIG = {
  commute: {
    localKey:'taint_recent_commute_v1',
    listId:'commuteRecentList',
    chartId:'commuteTrendChart',
    metaId:'commuteRecentMeta',
    table:'calculation_logs',
    select:'created_at,city_name,category,fuel,vehicle,distance_km,passengers,per_passenger_kg,result,raw_input',
    query:'calculation_type=eq.commute',
    empty:'Sign in or calculate to see recent commute results.'
  },
  workplace: {
    localKey:'taint_recent_workplace_v1',
    listId:'workplaceRecentList',
    chartId:'workplaceTrendChart',
    metaId:'workplaceRecentMeta',
    table:'carbon_profiles',
    select:'created_at,city_name,total_tco2e,per_capita_tco2e,grade,inputs,results',
    query:'profile_type=eq.workplace',
    empty:'Sign in or calculate to see recent workplace results.'
  },
  home: {
    localKey:'taint_recent_home_v1',
    listId:'homeRecentList',
    chartId:'homeTrendChart',
    metaId:'homeRecentMeta',
    table:'carbon_profiles',
    select:'created_at,city_name,total_tco2e,per_capita_tco2e,grade,inputs,results',
    query:'profile_type=eq.household',
    empty:'Sign in or calculate to see recent home results.'
  },
  taint: {
    localKey:'taint_recent_my_taint_v1',
    listId:'taintRecentList',
    chartId:'taintTrendChart',
    metaId:'taintRecentMeta',
    table:'carbon_profiles',
    select:'created_at,city_name,total_tco2e,per_capita_tco2e,grade,inputs,results',
    query:'profile_type=eq.my_taint',
    empty:'Sign in or calculate to see recent My Taint profiles.'
  },
  buy: {
    localKey:'taint_buy_history_v1',
    listId:'buyRecentList',
    chartId:'buyTrendChart',
    metaId:'buyRecentMeta',
    table:'product_purchases',
    select:'created_at,product_id,product_name,platform,status,price_num,quantity,city_name,metadata',
    query:'status=in.(checked_out,bought)',
    empty:'Open a vendor link or mark a product bought to build your list.'
  }
};

function readLocalRecent(mode) {
  const cfg = RECENT_MODE_CONFIG[mode];
  if (!cfg) return [];
  try { return JSON.parse(localStorage.getItem(cfg.localKey) || '[]').filter(Boolean); }
  catch { return []; }
}

function writeLocalRecent(mode, records) {
  const cfg = RECENT_MODE_CONFIG[mode];
  if (!cfg) return;
  try { localStorage.setItem(cfg.localKey, JSON.stringify(records.slice(0, 25))); } catch {}
}

function recentRecord(mode, record) {
  const now = new Date().toISOString();
  return {
    id: record.id || `${mode}-${Date.now()}`,
    mode,
    at: record.at || now,
    city: record.city || city().name,
    title: record.title || mode,
    detail: record.detail || '',
    value: Number(record.value || 0),
    unit: record.unit || 't/yr',
    grade: record.grade || '',
    payload: record.payload || {}
  };
}

function saveRecentRecord(mode, record) {
  const row = recentRecord(mode, record);
  const existing = readLocalRecent(mode).filter(item => item.id !== row.id);
  writeLocalRecent(mode, [row, ...existing]);
  renderRecentCalculations(mode);
}

function rowToRecent(mode, row) {
  if (mode === 'commute') {
    const perPassenger = Number(row.per_passenger_kg || 0);
    const annual = Number(row.result?.annualTco2e || (perPassenger * 2 * 260 / 1000));
    return recentRecord(mode, {
      id: row.id || row.created_at,
      at: row.created_at,
      city: row.city_name,
      title: `${row.vehicle || row.fuel || 'Commute'} route`,
      detail: `${Number(row.distance_km || 0).toFixed(1)} km · ${row.passengers || 1} passenger(s)`,
      value: annual,
      unit: 't/yr',
      payload: row
    });
  }
  if (mode === 'buy') {
    const status = row.status === 'bought' ? 'Bought' : 'Checked out';
    return recentRecord(mode, {
      id: row.id || row.created_at,
      at: row.created_at,
      city: row.city_name,
      title: row.product_name || row.product_id || 'Taint Buy product',
      detail: `${status}${row.platform ? ` · ${row.platform}` : ''}`,
      value: Number(row.price_num || 0),
      unit: 'INR',
      payload: row
    });
  }
  return recentRecord(mode, {
    id: row.id || row.created_at,
    at: row.created_at,
    city: row.city_name,
    title: mode === 'taint' ? 'My Taint profile' : `${mode[0].toUpperCase()}${mode.slice(1)} profile`,
    detail: row.grade ? `Grade ${row.grade}` : '',
    value: Number(row.total_tco2e || 0),
    unit: 't/yr',
    grade: row.grade || '',
    payload: row
  });
}

async function fetchRecentRemote(mode) {
  const cfg = RECENT_MODE_CONFIG[mode];
  if (!cfg || !SB_CONFIGURED() || !currentUser || currentUser.provider !== 'supabase') return null;
  const url = `${SUPABASE_CONFIG.url}/rest/v1/${cfg.table}?${cfg.query}&select=${encodeURIComponent(cfg.select)}&order=created_at.desc&limit=5`;
  const res = await appFetch(url, { headers: await SB_AUTH_HEADERS() }, { label:`${mode} history`, timeout:9000, retries:1 });
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map(row => rowToRecent(mode, row)) : [];
}

function trendSvg(records, mode) {
  const values = records.map(r => Number(r.value || 0)).filter(v => Number.isFinite(v));
  if (!values.length) return 'No trend yet';
  const width = 260, height = 132, pad = 18;
  const max = Math.max(...values, mode === 'buy' ? 1 : 0.1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 0.001);
  const points = values.slice().reverse().map((v, i, arr) => {
    const x = pad + (arr.length === 1 ? (width - pad * 2) : i * (width - pad * 2) / (arr.length - 1));
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y, v];
  });
  const poly = points.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pad},${height-pad} ${poly} ${width-pad},${height-pad}`;
  const unit = mode === 'buy' ? 'INR' : 't';
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Stored ${mode} trend">
    <line class="trend-axis" x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}"></line>
    <line class="trend-axis" x1="${pad}" y1="${pad}" x2="${pad}" y2="${height-pad}"></line>
    <polygon class="trend-area" points="${area}"></polygon>
    <polyline class="trend-line" points="${poly}"></polyline>
    ${points.map(([x,y]) => `<circle class="trend-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"></circle>`).join('')}
    <text class="trend-label" x="${pad}" y="12">${max.toFixed(mode === 'buy' ? 0 : 2)} ${unit}</text>
    <text class="trend-label" x="${pad}" y="${height-2}">${records.length} saved</text>
  </svg>`;
}

function renderRecentCalculations(mode, incoming=null) {
  const cfg = RECENT_MODE_CONFIG[mode];
  const list = cfg && document.getElementById(cfg.listId);
  const chart = cfg && document.getElementById(cfg.chartId);
  const meta = cfg && document.getElementById(cfg.metaId);
  if (!cfg || !list || !chart) return;
  const records = (incoming || readLocalRecent(mode)).slice(0, 5);
  if (meta) meta.textContent = currentUser?.provider === 'supabase' ? 'signed-in latest 5' : 'local latest 5';
  if (!records.length) {
    list.innerHTML = `<div class="recent-empty">${cfg.empty}</div>`;
    chart.textContent = 'No trend yet';
    return;
  }
  list.innerHTML = records.map(r => {
    const date = new Date(r.at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    const value = r.unit === 'INR' ? `₹${Number(r.value || 0).toLocaleString('en-IN')}` : `${Number(r.value || 0).toFixed(2)} ${escapeHTML(r.unit)}`;
    return `<div class="recent-row">
      <div>
        <div class="recent-title">${escapeHTML(r.title)}</div>
        <div class="recent-detail">${escapeHTML(r.city || '')} · ${escapeHTML(date)}${r.detail ? ` · ${escapeHTML(r.detail)}` : ''}</div>
      </div>
      <div class="recent-value">${value}</div>
    </div>`;
  }).join('');
  chart.innerHTML = trendSvg(records, mode);
}

async function refreshRecentCalculations(mode) {
  renderRecentCalculations(mode);
  try {
    const remote = await fetchRecentRemote(mode);
    if (remote) {
      writeLocalRecent(mode, remote);
      renderRecentCalculations(mode, remote);
    }
  } catch (e) {
    console.warn(`TAINT ${mode} history read skipped:`, e.message);
  }
}

function refreshAllRecentCalculations() {
  Object.keys(RECENT_MODE_CONFIG).forEach(mode => refreshRecentCalculations(mode));
}

/* Update the stats display from Supabase */
async function refreshGlobalStats() {
  try {
    const [users, calcs] = await Promise.all([
      sbGetStat('uniqueUsers'),
      sbGetStat('totalCalcs')
    ]);
    document.getElementById('statUsers').textContent    = (+users).toLocaleString();
    document.getElementById('statUsersLbl').textContent = 'global unique visitors';
    document.getElementById('statCalcs').textContent    = (+calcs).toLocaleString();
    document.getElementById('statCalcsLbl').textContent = 'calculations all time';
    updateAdminStats();
  } catch { /* silently fall back */ }
}

async function initSupabase() {
  if (!SB_CONFIGURED()) { showLocalStats(); return; }
  try {
    await sbRegisterVisitor();
    sbConnected = true;
    await refreshGlobalStats();
    setInterval(refreshGlobalStats, 30000);
    return;

    const uid    = getOrCreateUID();
    const exists = await fetch(
      `${SUPABASE_CONFIG.url}/rest/v1/stats?key=eq.user_${uid}&select=key`,
      { headers: SB_HEADERS() }
    ).then(r => r.json());

    if (!exists.length) {
      /* New unique visitor — mark them and increment counter */
      await fetch(`${SUPABASE_CONFIG.url}/rest/v1/stats`, {
        method : 'POST',
        headers: { ...SB_HEADERS(), 'Prefer': 'resolution=ignore-duplicates' },
        body   : JSON.stringify({ key: 'user_' + uid, value: 1 })
      });
      await sbIncrement('uniqueUsers');
    }

    sbConnected = true;
    await refreshGlobalStats();

    /* Poll for live updates every 30 s (Supabase Realtime needs the JS client;
       polling is simpler and sufficient for this use-case) */
    setInterval(refreshGlobalStats, 30000);
  } catch { showLocalStats(); }
}

function showLocalStats() {
  const s = getStats();
  document.getElementById('statUsers').textContent    = '—';
  document.getElementById('statUsersLbl').textContent = 'Supabase not configured';
  document.getElementById('statCalcs').textContent    = (s.total || 0).toLocaleString();
  document.getElementById('statCalcsLbl').textContent = 'on this device';
  updateAdminStats();
}

function bumpGlobal() {
  if (sbConnected) sbIncrement('totalCalcs');
}

function updateAdminStats() {
  const text = id => document.getElementById(id)?.textContent || '—';
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('adminUsers', text('statUsers'));
  set('adminUsersLbl', text('statUsersLbl'));
  set('adminCalcs', text('statCalcs'));
  set('adminCalcsLbl', text('statCalcsLbl'));
  set('adminMonth', text('statMonth'));
  updateRuntimeUI();
}

// ──────────────────────────────────────────────────────
//  CALCULATOR — fuel pills, vehicle list, calculate
// ──────────────────────────────────────────────────────
function renderFuelPills(cat) {
  const pills=document.getElementById('fuelPills'); pills.innerHTML='';
  const fuels=CAT_FUELS[cat];
  if(!fuels.includes(currentFuel)) currentFuel=fuels[0];
  fuels.forEach(f=>{
    const m=FUEL_META[f]; const btn=document.createElement('button');
    btn.className='fp'+(f===currentFuel?' active':''); btn.dataset.fuel=f;
    btn.innerHTML=`<span class="fdot"></span>${m.icon} ${m.label}`;
    pills.appendChild(btn);
  });
  /* Hide hybrid panel for transit and non-hybrid categories */
  document.getElementById('hybridPanel').style.display =
    (currentFuel==='hybrid' && cat!=='transit') ? 'flex' : 'none';
}

function populateVehicles() {
  const sel=document.getElementById('vehicle'); const noV=document.getElementById('noVeh');
  const list=getVehicleList(); sel.innerHTML='';
  if(!list.length){ sel.style.display='none'; noV.style.display='block'; }
  else {
    sel.style.display=''; noV.style.display='none';
    list.forEach(v=>{ const o=document.createElement('option'); o.value=v.value; o.textContent=v.label; sel.appendChild(o); });
  }
  updatePucUI();
  calculate();
}

let calcTimer;
function scheduleCalc() { clearTimeout(calcTimer); calcTimer=setTimeout(calculate,180); }

function calculate(options={}) {
  const vVal=document.getElementById('vehicle').value;
  const distCheck = validateNumberField('distance', { min:0.1, max:10000, label:'Distance' });
  const paxCheck  = validateNumberField('passengers', { min:1, max:100, label:'Passengers' });
  if (!distCheck.ok || !paxCheck.ok) {
    if (options.log) notify(distCheck.message || paxCheck.message, 'warn', 'Check commute inputs');
    return;
  }
  const dist=distCheck.value;
  const pax =Math.max(1,Math.round(paxCheck.value));
  const list=getVehicleList(); const veh=list.find(v=>v.value===vVal);
  if(!veh) return;

  const puc = getPucAdjustment(currentFuel);
  updatePucUI();
  const adjustedGPerKm = Math.max(0, veh.gPerKm * puc.multiplier);
  const totalKg=(adjustedGPerKm*dist)/1000;
  const divisor = Math.max(1, veh.avgOccupancy || pax);
  const perPax =totalKg/divisor;
  const trees  =perPax/21;

  /* Output values */
  document.getElementById('totalCo2').textContent=totalKg.toFixed(3);
  document.getElementById('perPax').textContent  =perPax.toFixed(3);
  document.getElementById('trees').textContent   =trees<.001?'<0.001':trees.toFixed(3);

  /* Fuel badge */
  const fm=FUEL_META[currentFuel];
  const badge=document.getElementById('fuelBadge');
  badge.className=`fuel-badge ${fm.cls}`;
  badge.textContent=`${fm.icon} ${fm.label}${currentFuel==='hybrid'?' · '+currentHtype.toUpperCase():''}`;

  /* Comparison strip vs petrol base — skip for transit */
  const baseG=PETROL_BASE[currentCat];
  const basePax=(baseG*dist)/1000/divisor;
  const saved=basePax-perPax; const pct=basePax>0?(saved/basePax*100):0;
  const cr=document.getElementById('cmpRow');
  if(currentFuel!=='petrol' && currentCat!=='transit' && baseG>0){
    cr.innerHTML=`
      <div class="ci-box"><div class="ci-lbl">Petrol base</div><div class="ci-val">${basePax.toFixed(3)}</div><div class="ci-unit">kg CO₂/person</div></div>
      <div class="ci-box ${saved>=0?'good':'bad'}"><div class="ci-lbl">${saved>=0?'You save':'Extra'}</div><div class="ci-val">${Math.abs(saved).toFixed(3)}</div><div class="ci-unit">kg CO₂/person</div></div>
      <div class="ci-box ${saved>=0?'good':'bad'}"><div class="ci-lbl">${saved>=0?'Reduction':'Increase'}</div><div class="ci-val">${Math.abs(pct).toFixed(1)}%</div><div class="ci-unit">vs petrol</div></div>`;
  } else { cr.innerHTML=''; }

  /* Emission intensity bar */
  const pctBar=Math.min(100,(adjustedGPerKm/160)*100);
  const bar=document.getElementById('ratingBar'), rtxt=document.getElementById('ratingTxt');
  bar.style.width=pctBar.toFixed(1)+'%';
  if     (pctBar<15){bar.style.background='#34d399';rtxt.textContent='Very Low';}
  else if(pctBar<35){bar.style.background='#84cc16';rtxt.textContent='Low';}
  else if(pctBar<55){bar.style.background='#fbbf24';rtxt.textContent='Moderate';}
  else if(pctBar<75){bar.style.background='#fb923c';rtxt.textContent='High';}
  else              {bar.style.background='#f87171';rtxt.textContent='Very High';}

  /* Tip */
  document.getElementById('tipText').innerHTML=TIPS[vVal]||'Select a vehicle to see your personalised insight.';

  /* City vision — update emission intensity meter with per-passenger CO₂ */
  updateVisionMeter(perPax);

  /* Fuel cost */
  renderCost(veh, currentFuel);

  const annualDays = 260;
  const annualTco2e = perPax * 2 * annualDays / 1000;
  window._commuteResult = {
    source: 'commuteMode',
    t: annualTco2e,
    annualTco2e,
    perTripKg: perPax,
    totalTripKg: totalKg,
    distanceKm: dist,
    passengers: pax,
    vehicle: vVal,
    vehicleLabel: veh.label,
    fuel: currentFuel,
    mode: currentCat,
    baseGPerKm: veh.gPerKm,
    adjustedGPerKm,
    puc,
    annualDays,
    trees
  };
  if (typeof mtImportSavedModeResults === 'function') mtImportSavedModeResults({ silent:true });

  /* Usage tracking only counts explicit user calculations, not auto-refresh. */
  if (options.log) {
    bumpLocal(); bumpGlobal();
    sbPost('calculation_logs', {
      calculation_type: 'commute',
      city_key        : currentCityKey,
      city_name       : city().name,
      category        : currentCat,
      fuel            : currentFuel,
      vehicle         : vVal,
      distance_km     : dist,
      passengers      : pax,
      per_trip_kg     : totalKg,
      per_passenger_kg: perPax,
      from_label      : document.getElementById('fromLoc')?.value?.trim() || null,
      to_label        : document.getElementById('toLoc')?.value?.trim() || null,
      raw_input       : { ...collectFormFields('#commuteSection'), hybridType: currentHtype, linkedDistance: distLinked, avgOccupancy: veh.avgOccupancy || null },
      result          : { annualTco2e, trees, gPerKm: adjustedGPerKm, baseGPerKm: veh.gPerKm, fuelLabel: FUEL_META[currentFuel]?.label || currentFuel, puc }
    }, 'functional');
    saveRecentRecord('commute', {
      city: city().name,
      title: veh.label,
      detail: `${dist.toFixed(1)} km · ${pax} passenger(s)`,
      value: annualTco2e,
      unit: 't/yr',
      payload: window._commuteResult
    });
  }
}

// ──────────────────────────────────────────────────────
//  FUEL COST COMPARISON
// ──────────────────────────────────────────────────────
function cpk(fuelPerKm, fuel) {
  if(!fuelPerKm) return null;
  return fuelPerKm*(PRICES[PRICE_KEY[fuel]]||DEFAULT_PRICES[PRICE_KEY[fuel]]||0);
}

function renderCost(veh, fuel) {
  lastVeh=veh; lastFuel=fuel;
  const c=cpk(veh.fuelPerKm,fuel);
  const dist=parseFloat(document.getElementById('distance').value)||0;
  document.getElementById('costVehName').textContent=veh.label;
  document.getElementById('costPerKm').textContent =c?`₹${c.toFixed(2)}`:'N/A';
  document.getElementById('costTrip').textContent  =c?`₹${(c*dist).toFixed(0)}`:'—';
  document.getElementById('costMonth').textContent =c?`₹${(c*dist*22).toFixed(0)}`:'—';
  /* Build alternatives table */
  const rows=COST_VEHICLES.map(v=>({...v,cost:cpk(v.fuelPerKm,v.fuel)||0})).sort((a,b)=>a.cost-b.cost);
  const maxC=Math.max(...rows.map(r=>r.cost),1);
  const tbody=document.getElementById('altBody'); tbody.innerHTML='';
  rows.slice(0,8).forEach((r,i)=>{
    const barColor={electric:'var(--green)',cng:'var(--blue)',hybrid:'var(--purple)',diesel:'var(--orange)',petrol:'var(--amber)'}[r.fuel]||'var(--mu)';
    const tr=document.createElement('tr');
    if(Math.abs(r.cost-cpk(veh.fuelPerKm,fuel)||0)<.01) tr.className='cur';
    tr.innerHTML=`
      <td>${r.label}${i===0&&tr.className!=='cur'?'<span class="cheapest-tag">Cheapest</span>':''}</td>
      <td><span class="fuel-tag ${r.fuel}">${FUEL_META[r.fuel].icon} ${FUEL_META[r.fuel].label}</span></td>
      <td><div class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${(r.cost/maxC*100).toFixed(1)}%;background:${barColor}"></div></div><span style="font-family:'DM Mono',monospace;font-size:12px">₹${r.cost.toFixed(2)}</span></div></td>
      <td style="font-family:'DM Mono',monospace;font-size:12px">₹${(r.cost*dist*22).toFixed(0)}</td>`;
    tbody.appendChild(tr);
  });
}

// ──────────────────────────────────────────────────────
//  EVENT LISTENERS — category, fuel pills, hybrid panel, form inputs
// ──────────────────────────────────────────────────────
document.getElementById('catToggle').addEventListener('click',e=>{
  const btn=e.target.closest('.cat-btn'); if(!btn) return;
  document.querySelectorAll('.cat-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); currentCat=btn.dataset.cat;
  renderFuelPills(currentCat); populateVehicles();
});

document.getElementById('fuelPills').addEventListener('click',e=>{
  const pill=e.target.closest('.fp'); if(!pill) return;
  document.querySelectorAll('.fp').forEach(p=>p.classList.remove('active'));
  pill.classList.add('active'); currentFuel=pill.dataset.fuel;
  document.getElementById('hybridPanel').style.display=currentFuel==='hybrid'?'flex':'none';
  populateVehicles();
});

document.getElementById('hybridPanel').addEventListener('click',e=>{
  const btn=e.target.closest('.hp-btn'); if(!btn) return;
  document.querySelectorAll('.hp-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); currentHtype=btn.dataset.htype; populateVehicles();
});

document.getElementById('commuteCalcBtn')?.addEventListener('click', () => calculate({ log:true }));
document.getElementById('vehicle').addEventListener('change',scheduleCalc);
document.getElementById('distance').addEventListener('input',scheduleCalc);
document.getElementById('passengers').addEventListener('input',scheduleCalc);
['pucStatus','pucCo','pucSmoke'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    updatePucUI();
    scheduleCalc();
  });
  document.getElementById(id)?.addEventListener('change', () => {
    updatePucUI();
    scheduleCalc();
  });
});

// ──────────────────────────────────────────────────────
//  FEEDBACK FORM
//  Saves to localStorage + POSTs to FormSubmit.co
// ──────────────────────────────────────────────────────
const FB_KEY='taint_feedback_v1';

function renderFeedback() {
  const items=JSON.parse(localStorage.getItem(FB_KEY)||'[]');
  const list=document.getElementById('fbList');
  if(!items.length){ list.innerHTML='<div class="fb-empty">No feedback yet from this device.</div>'; return; }
  list.innerHTML=[...items].reverse().map(fb=>{
    const stars = Math.max(0, Math.min(5, Number(fb.stars) || 0));
    return `
    <div class="fb-comment">
      <div class="fb-cm-meta">
        <span class="fb-cm-name">${escapeHTML(fb.name || 'Anonymous')}</span>
        <span class="fb-cm-type">${escapeHTML(fb.type || 'general')}</span>
        ${stars ? `<span>${'&#9733;'.repeat(stars)}</span>` : ''}
        <span class="fb-cm-date">${escapeHTML(fb.date || '')}</span>
      </div>
      <div class="fb-cm-text">${escapeHTML(fb.msg || '')}</div>
    </div>`;
  }).join('');
}

/* Star hover + click */
document.getElementById('starRow').addEventListener('mouseover',e=>{
  const s=e.target.closest('.star'); if(!s) return;
  const v=+s.dataset.v;
  document.querySelectorAll('.star').forEach((st,i)=>st.classList.toggle('on',i<v));
});
document.getElementById('starRow').addEventListener('mouseleave',()=>{
  document.querySelectorAll('.star').forEach((s,i)=>s.classList.toggle('on',i<starRating));
});
document.getElementById('starRow').addEventListener('click',e=>{
  const s=e.target.closest('.star'); if(!s) return;
  starRating=+s.dataset.v;
  document.querySelectorAll('.star').forEach((st,i)=>st.classList.toggle('on',i<starRating));
});

document.getElementById('fbForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg  = document.getElementById('fbMsg').value.trim();
  const emailEl = document.getElementById('fbEmail');
  const email = emailEl.value.trim();
  const err  = document.getElementById('fbErr');
  const btn  = document.getElementById('fbSubmit');
  if (!msg || msg.length < 8) {
    err.textContent = 'Please write at least 8 characters of feedback.';
    err.classList.add('show');
    setFieldInvalid(document.getElementById('fbMsg'), 'Feedback is too short.');
    return;
  }
  setFieldInvalid(document.getElementById('fbMsg'), '');
  if (email && !isValidEmail(email)) {
    err.textContent = 'Please enter a valid email address or leave it blank.';
    err.classList.add('show');
    setFieldInvalid(emailEl, 'Invalid email address.');
    return;
  }
  setFieldInvalid(emailEl, '');
  err.classList.remove('show');
  btn.disabled = true; btn.textContent = 'Sending…';

  const now   = new Date();
  const entry = {
    name  : document.getElementById('fbName').value.trim()  || 'Anonymous',
    email,
    type  : document.getElementById('fbType').value,
    stars : starRating, msg,
    city  : city().name,
    date  : `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`
  };

  /* ── 1. Save to localStorage (always works) ── */
  try {
    const items = JSON.parse(localStorage.getItem(FB_KEY) || '[]');
    items.push(entry);
    if (items.length > 20) items.splice(0, items.length - 20);
    localStorage.setItem(FB_KEY, JSON.stringify(items));
  } catch {}

  /* ── 2. Send via FormSubmit AJAX endpoint ──────────────────────────
     FormSubmit.co AJAX mode — supports fetch() + CORS + returns JSON.
     IMPORTANT: On the FIRST ever submission FormSubmit sends an
     activation email to FEEDBACK_EMAIL. Click the link in that email
     once, then all subsequent submissions will be delivered.
     Endpoint: https://formsubmit.co/ajax/{email}  (NOT the plain URL)
     ─────────────────────────────────────────────────────────────────── */
  let emailSent = false;
  let emailError = '';

  try {
    const payload = {
      name     : entry.name,
      email    : entry.email || 'noreply@taint.app',
      message  : `[${entry.type}] ★${entry.stars}/5 | City: ${entry.city}\n\n${entry.msg}`,
      _subject : `TAINT Feedback (${entry.type}) from ${entry.name} — ${entry.city}`,
      _captcha : 'false',
      _template: 'table'
    };

    const res = await appFetch(`https://formsubmit.co/ajax/${FEEDBACK_EMAIL}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body   : JSON.stringify(payload)
    }, { label:'feedback email', timeout:12000 });

    const data = await res.json();
    emailSent  = data.success === 'true' || data.success === true;
    if (!emailSent) emailError = data.message || 'FormSubmit returned failure';

  } catch (fetchErr) {
    emailError = fetchErr.message;
    console.warn('TAINT feedback email failed:', fetchErr);
  }

  await sbPost('feedback_messages', {
    source       : 'contact',
    name         : entry.name,
    email        : entry.email || null,
    feedback_type: entry.type,
    rating       : entry.stars || null,
    message      : entry.msg,
    city_key     : currentCityKey,
    city_name    : city().name,
    email_sent   : emailSent,
    email_error  : emailError || null
  }, 'functional');

  /* ── 3. Show result to user ── */
  if (emailSent) {
    document.getElementById('fbForm').style.display = 'none';
    document.getElementById('fbOk').textContent     = '✅ Thank you! Your feedback has been saved and emailed.';
    document.getElementById('fbOk').classList.add('show');
    notify('Feedback saved and emailed.', 'success', 'Thanks');
  } else {
    /* Saved locally but email failed — still positive but honest */
    document.getElementById('fbForm').style.display = 'none';
    document.getElementById('fbOk').textContent     =
      `💾 Feedback saved on this device. Email delivery failed${emailError ? ': '+emailError.slice(0,60) : ''}.
      (If this is your first submission, check ${FEEDBACK_EMAIL} for a FormSubmit activation link.)`;
    document.getElementById('fbOk').classList.add('show');
    document.getElementById('fbOk').style.color = 'var(--amber)';
    notify('Feedback saved locally. Email delivery needs attention.', 'warn', 'Saved');
  }

  renderFeedback();

  /* Reset form after 6s */
  setTimeout(() => {
    document.getElementById('fbForm').reset();
    document.getElementById('fbForm').style.display   = 'flex';
    document.getElementById('fbOk').classList.remove('show');
    document.getElementById('fbOk').style.color       = '';
    starRating = 0;
    document.querySelectorAll('.star').forEach(s => s.classList.remove('on'));
    btn.disabled = false; btn.textContent = 'Send Feedback →';
  }, 6000);
});

/* ── Test email button ── */
document.getElementById('fbTestBtn')?.addEventListener('click', async () => {
  const btn    = document.getElementById('fbTestBtn');
  const result = document.getElementById('fbTestResult');
  btn.textContent  = '⏳ Sending…';
  btn.disabled     = true;
  result.textContent = '';
  result.className   = 'fb-test-result';

  try {
    const res  = await appFetch(`https://formsubmit.co/ajax/${FEEDBACK_EMAIL}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body   : JSON.stringify({
        name    : 'TAINT Test',
        email   : 'noreply@taint.app',
        message : `Test email from TAINT Carbon Calculator.\nSent at: ${new Date().toISOString()}\nCity: ${city().name}`,
        _subject: 'TAINT — Test Email (workflow check)',
        _captcha: 'false'
      })
    }, { label:'feedback test email', timeout:12000 });
    const data  = await res.json();
    const ok    = data.success === 'true' || data.success === true;
    result.textContent = ok
      ? '✅ Delivered! Check your inbox.'
      : `❌ Failed: ${data.message || 'unknown error'}. Click the activation link in the first FormSubmit email.`;
    result.className = 'fb-test-result ' + (ok ? 'ok' : 'fail');
  } catch (err) {
    result.textContent = `❌ Network error: ${err.message}`;
    result.className   = 'fb-test-result fail';
  }

  btn.textContent = '🧪 Send Test Email';
  btn.disabled    = false;
});

/* ── Basic email format validation on feedback form ── */
document.getElementById('fbEmail')?.addEventListener('blur', function() {
  const v = this.value.trim();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    this.style.borderColor = 'var(--red)';
    this.title = 'Please enter a valid email address';
  } else {
    this.style.borderColor = '';
    this.title = '';
  }
});
// ──────────────────────────────────────────────────────

/* Tracks last per-passenger CO₂ so area-change can regenerate the effect */
let lastPerPaxKg = 0;

/* Show or hide an overlay div; optionally update its text label */
function setOverlay(id, show, text) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.style.display = show ? 'flex' : 'none';
  if (text) {
    const span = overlay.querySelector('span[id]') || overlay.querySelector('span');
    if (span) span.textContent = text;
  }
}

/* Update the emission intensity meter after each calculate() call */
function updateVisionMeter(perPaxKg) {
  lastPerPaxKg = perPaxKg;
  const fill   = document.getElementById('viBarFill');
  const badge  = document.getElementById('viIntensityText');
  const detail = document.getElementById('viDetail');
  const genCta = document.getElementById('genCta');
  if (!fill || !badge) return;

  /* Scale: 1.0 kg CO₂/person = 100% bar */
  const pct = Math.min(100, (perPaxKg / 1.0) * 100);
  fill.style.width = pct.toFixed(1) + '%';

  let level, cls, color;
  if      (perPaxKg <= 0.001) { level = 'Zero';     cls = 'zero';     color = 'var(--green)';  }
  else if (perPaxKg < 0.05)   { level = 'Low';      cls = 'low';      color = '#84cc16';        }
  else if (perPaxKg < 0.2)    { level = 'Moderate'; cls = 'moderate'; color = 'var(--amber)';   }
  else if (perPaxKg < 0.5)    { level = 'High';     cls = 'high';     color = 'var(--orange)';  }
  else                         { level = 'Critical'; cls = 'critical'; color = 'var(--red)';     }

  fill.style.background = color;
  badge.className       = `vi-badge ${cls}`;
  badge.textContent     = `${level} — ${perPaxKg.toFixed(3)} kg CO₂/person`;
  if (detail) detail.textContent =
    `${(perPaxKg * 250).toFixed(1)} kg/year (250 working days) · ${(perPaxKg / 21 * 250).toFixed(2)} trees to offset`;

  /* Reveal the generate button once the user has calculated something */
  if (perPaxKg > 0 && genCta) genCta.style.display = 'block';
}

/* Apply CSS pollution filter to the right Leaflet map */
function applyEmissionEffect() {
  const mapEffectEl = document.getElementById('mapEffect');
  if (!mapEffectEl) return;

  const fuelSmog = { diesel:1.45, petrol:1.0, cng:0.72, hybrid:0.75, electric:0.18, rail:0.12 };
  const puc = typeof getPucAdjustment === 'function' ? getPucAdjustment(currentFuel) : { multiplier:1 };
  const localTailpipe = currentFuel === 'electric' || currentFuel === 'rail' || currentCat === 'transit' ? 0.18 : 1;
  const smogIndex = Math.max(0, lastPerPaxKg * (fuelSmog[currentFuel] || 1) * (puc.multiplier || 1) * localTailpipe);
  const hazePct = Math.min(1, smogIndex / 0.65);
  let filterStr, smogBg, smogOpacity, aqiLabel, smogLabel;

  if (smogIndex <= 0.001) {
    filterStr = 'none';
    smogBg = 'transparent'; smogOpacity = 0;
    aqiLabel = 'Negligible local-pollutant proxy'; smogLabel = 'Clear conditions';
  } else if (smogIndex < 0.05) {
    filterStr = 'sepia(6%) brightness(98%) saturate(93%) contrast(98%)';
    smogBg = 'linear-gradient(rgba(210,205,185,0.07),rgba(196,190,170,0.05))'; smogOpacity = 1;
    aqiLabel = 'Low local-pollutant proxy'; smogLabel = 'Light haze';
  } else if (smogIndex < 0.18) {
    filterStr = 'sepia(18%) saturate(80%) brightness(91%) contrast(93%)';
    smogBg = 'radial-gradient(circle at 50% 25%,rgba(224,218,190,0.22),rgba(171,158,125,0.12) 55%,rgba(118,110,92,0.08))'; smogOpacity = 1;
    aqiLabel = 'Moderate local-pollutant proxy'; smogLabel = 'Visible haze';
  } else if (smogIndex < 0.5) {
    filterStr = 'sepia(36%) saturate(62%) brightness(82%) contrast(88%)';
    smogBg = 'linear-gradient(rgba(164,150,113,0.25),rgba(126,116,94,0.18)),radial-gradient(circle at 50% 20%,rgba(225,214,174,0.20),transparent 58%)'; smogOpacity = 1;
    aqiLabel = 'High local-pollutant proxy'; smogLabel = 'Dense urban haze';
  } else {
    filterStr = 'sepia(58%) saturate(42%) brightness(68%) contrast(82%) blur(0.6px)';
    smogBg = 'linear-gradient(rgba(110,102,86,0.38),rgba(74,70,62,0.30)),radial-gradient(circle at 48% 22%,rgba(210,196,152,0.25),transparent 48%)'; smogOpacity = 1;
    aqiLabel = 'Critical local-pollutant proxy'; smogLabel = 'Severe smog proxy';
  }

  mapEffectEl.style.filter = filterStr;

  const smogOverlay = document.getElementById('smogOverlay');
  if (smogOverlay) {
    smogOverlay.style.background = smogBg;
    smogOverlay.style.opacity    = smogOpacity;
  }

  const overlayPolluted = document.getElementById('overlayPolluted');
  if (overlayPolluted) overlayPolluted.style.display = 'none';

  const el = id => document.getElementById(id);
  if (el('vsAqiPill'))   el('vsAqiPill').textContent   = aqiLabel;
  if (el('vsSmogPill'))  el('vsSmogPill').textContent  = smogLabel;
  if (el('vsPollBadge')) el('vsPollBadge').textContent = smogLabel;

  const promptDetails  = el('promptDetails');
  const promptPolluted = el('promptPolluted');
  if (promptDetails)  promptDetails.style.display  = '';
  if (promptPolluted) promptPolluted.textContent =
    `Smog index ${smogIndex.toFixed(3)} = per-person CO2 ${lastPerPaxKg.toFixed(3)} kg x fuel/PUC/local-tailpipe modifiers. Visual haze strength ${(hazePct*100).toFixed(0)}%. This is a qualitative co-emitted PM/NOx proxy, not measured AQI.`;

  const visionCompare = el('visionCompare');
  if (visionCompare) {
    visionCompare.style.display = '';
    const annual  = lastPerPaxKg * 250;
    const trees   = annual / 21;
    const aqiPts  = Math.round(smogIndex * 80);
    const visLoss = Math.min(90, Math.round(hazePct * 70));
    if (el('vcAnnual')) el('vcAnnual').textContent = annual.toFixed(1);
    if (el('vcTrees'))  el('vcTrees').textContent  = trees.toFixed(1);
    if (el('vcAqi'))    el('vcAqi').textContent    = '+' + aqiPts;
    if (el('vcVis'))    el('vcVis').textContent    = visLoss + '%';
  }

  if (el('genBtnText')) el('genBtnText').textContent = 'Update Smog Proxy';
  if (el('genBtnIcon')) el('genBtnIcon').textContent = '↻';
}

/* Show vision section, init maps (once), then apply effect */
function generateCityVision() {
  /* 1. Show the vision grid */
  const visionGrid = document.getElementById('visionGrid');
  if (visionGrid) visionGrid.style.display = '';

  /* 2. Init Leaflet maps on first call (needs div to be visible first) */
  if (!mapsReady) {
    requestAnimationFrame(() => {
      initLeafletMaps();
      /* Give tiles a moment to start loading before applying filter */
      setTimeout(applyEmissionEffect, 300);
    });
    return;
  }

  /* 3. Sync effect map to current satellite view */
  if (leafSat && leafEffect) {
    leafEffect.setView(leafSat.getCenter(), leafSat.getZoom(), { animate: false });
    leafEffect.invalidateSize();
  }

  applyEmissionEffect();
}


//  LEFT  : Real satellite tile of Chennai via ESRI World
//          Imagery static export (free · no auth · instant)
//          URL: arcgisonline.com/.../World_Imagery/.../export
//
//  RIGHT : synced ESRI satellite view with a CSS aerosol haze proxy.
//          Haze strength scales with per-person CO2, fuel, PUC status,
//          and local tailpipe-pollutant risk. This is not measured AQI.
//
//  ESRI bbox format: minLon,minLat,maxLon,maxLat (WGS84)
// ──────────────────────────────────────────────────────

/* ── ESRI World Imagery static export ── */
// Returns a 1024×1024 satellite image for any bounding box.
// Free, public, no API key required.
/* ── ESRI World Imagery tile-based satellite loader ──────────
   Uses individual 256×256 tile requests (CORS: * on ESRI CDN)
   and stitches them onto a canvas — avoids the export endpoint
   which blocks cross-origin browser requests.
   Tile URL: arcgisonline.com/.../World_Imagery/.../tile/{z}/{y}/{x}
   ──────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────
   CITY VISION — Leaflet maps (satellite + street overlay)
   Left panel: interactive map the user can pan/zoom.
   Right panel: synced non-interactive map with CSS pollution filter.
   ────────────────────────────────────────────────────── */

// ──────────────────────────────────────────────────────
//  MULTI-CITY CONFIG
//  Grid intensity: CEA 2023 state-wise values (kg CO₂/kWh)
//  Zones: used for satellite City Vision area selector
// ──────────────────────────────────────────────────────
const CITIES = {
  chennai: {
    name:'Chennai', state:'Tamil Nadu', code:'MAS',
    lat:13.0827, lon:80.2707, zoom:12, grid:0.716, aqiSlug:'chennai',
    placeholder:{from:'e.g. T. Nagar, Chennai', to:'e.g. Anna Nagar, Chennai'},
    metro:'Chennai Metro (CMRL)',
    suburban:'MRTS / Suburban Rail',
    suburbanKwhPerKm:0.025,
    hasMonorail:false,
    zones:[
      {key:'marina',    label:'Marina & Central', lat:13.0827,lon:80.2707,zoom:14},
      {key:'adyar',     label:'South — Adyar',    lat:13.0050,lon:80.2574,zoom:14},
      {key:'annanagar', label:'Anna Nagar',        lat:13.0900,lon:80.2101,zoom:14},
      {key:'omr',       label:'OMR / IT Corridor', lat:12.9121,lon:80.2275,zoom:14},
      {key:'guindy',    label:'Guindy / Airport',  lat:13.0063,lon:80.2206,zoom:14},
    ],
  },
  mumbai: {
    name:'Mumbai', state:'Maharashtra', code:'BOM',
    lat:19.0760, lon:72.8777, zoom:12, grid:0.820, aqiSlug:'mumbai',
    placeholder:{from:'e.g. Bandra, Mumbai', to:'e.g. Andheri, Mumbai'},
    metro:'Mumbai Metro (MahaMetro)',
    suburban:'Mumbai Local (Western / Central / Harbour)',
    suburbanKwhPerKm:0.013,   // very high occupancy Local trains
    hasMonorail:true,
    zones:[
      {key:'marine',    label:'Marine Lines & CST',lat:18.9388,lon:72.8354,zoom:14},
      {key:'bandra',    label:'Bandra / BKC',      lat:19.0596,lon:72.8295,zoom:14},
      {key:'andheri',   label:'Andheri / Airport', lat:19.1136,lon:72.8697,zoom:14},
      {key:'thane',     label:'Thane',              lat:19.2183,lon:72.9781,zoom:13},
      {key:'navimumbai',label:'Navi Mumbai',        lat:19.0330,lon:73.0297,zoom:13},
    ],
  },
  delhi: {
    name:'Delhi', state:'Delhi / NCR', code:'DEL',
    lat:28.6139, lon:77.2090, zoom:11, grid:0.820, aqiSlug:'delhi',
    placeholder:{from:'e.g. Connaught Place, Delhi', to:'e.g. Noida, Delhi NCR'},
    metro:'Delhi Metro (DMRC)',
    suburban:'Delhi Suburban / Ring Rail',
    suburbanKwhPerKm:0.025,
    hasMonorail:false,
    zones:[
      {key:'cp',        label:'Connaught Place',   lat:28.6315,lon:77.2167,zoom:14},
      {key:'southdelhi',label:'South Delhi',       lat:28.5355,lon:77.2100,zoom:13},
      {key:'noida',     label:'Noida Sector 62',   lat:28.5355,lon:77.3910,zoom:13},
      {key:'gurgaon',   label:'Gurugram / Cyber',  lat:28.4595,lon:77.0266,zoom:13},
      {key:'dwarka',    label:'Dwarka / Airport',  lat:28.5921,lon:77.0460,zoom:13},
    ],
  },
  bangalore: {
    name:'Bengaluru', state:'Karnataka', code:'BLR',
    lat:12.9716, lon:77.5946, zoom:12, grid:0.550, aqiSlug:'bengaluru',
    placeholder:{from:'e.g. MG Road, Bengaluru', to:'e.g. Whitefield, Bengaluru'},
    metro:'Namma Metro (BMRCL)',
    suburban:'Bengaluru Suburban Rail (BSRL)',
    suburbanKwhPerKm:0.028,
    hasMonorail:false,
    zones:[
      {key:'mgroad',     label:'MG Road & CBD',    lat:12.9757,lon:77.6011,zoom:14},
      {key:'koramangala',label:'Koramangala',       lat:12.9352,lon:77.6245,zoom:14},
      {key:'whitefield', label:'Whitefield / ITPL', lat:12.9698,lon:77.7499,zoom:14},
      {key:'electronic', label:'Electronic City',   lat:12.8399,lon:77.6770,zoom:13},
      {key:'hebbal',     label:'Hebbal / Airport',  lat:13.0358,lon:77.5970,zoom:13},
    ],
  },
  hyderabad: {
    name:'Hyderabad', state:'Telangana', code:'HYD',
    lat:17.3850, lon:78.4867, zoom:12, grid:0.760, aqiSlug:'hyderabad',
    placeholder:{from:'e.g. Hitech City, Hyderabad', to:'e.g. Banjara Hills, Hyderabad'},
    metro:'Hyderabad Metro (HMRL)',
    suburban:'MMTS Suburban Rail',
    suburbanKwhPerKm:0.030,
    hasMonorail:false,
    zones:[
      {key:'hitec',     label:'Hitech City / CYBS',lat:17.4435,lon:78.3772,zoom:14},
      {key:'banjara',   label:'Banjara Hills',     lat:17.4138,lon:78.4503,zoom:14},
      {key:'gachibowli',label:'Gachibowli',        lat:17.4399,lon:78.3489,zoom:14},
      {key:'secund',    label:'Secunderabad',      lat:17.4399,lon:78.4983,zoom:13},
      {key:'uppal',     label:'Uppal / East',      lat:17.4062,lon:78.5592,zoom:13},
    ],
  },
  kolkata: {
    name:'Kolkata', state:'West Bengal', code:'CCU',
    lat:22.5726, lon:88.3639, zoom:12, grid:0.870, aqiSlug:'kolkata',
    placeholder:{from:'e.g. Park Street, Kolkata', to:'e.g. Salt Lake, Kolkata'},
    metro:'Kolkata Metro (KMRC)',
    suburban:'Kolkata Suburban / Local Train',
    suburbanKwhPerKm:0.022,
    hasMonorail:false,
    zones:[
      {key:'parkstreet',label:'Park Street & CBD', lat:22.5553,lon:88.3492,zoom:14},
      {key:'saltlake',  label:'Salt Lake / IT',    lat:22.5697,lon:88.4220,zoom:13},
      {key:'howrah',    label:'Howrah',             lat:22.5958,lon:88.2636,zoom:13},
      {key:'newtown',   label:'New Town / Rajarhat',lat:22.6033,lon:88.4610,zoom:13},
      {key:'dumdum',    label:'Dum Dum / Airport',  lat:22.6520,lon:88.4463,zoom:13},
    ],
  },
  pune: {
    name:'Pune', state:'Maharashtra', code:'PNQ',
    lat:18.5204, lon:73.8567, zoom:12, grid:0.820, aqiSlug:'pune',
    placeholder:{from:'e.g. Koregaon Park, Pune', to:'e.g. Hinjewadi, Pune'},
    metro:'Pune Metro (MahaMetro)',
    suburban:'Pune Suburban Rail',
    suburbanKwhPerKm:0.030,
    hasMonorail:false,
    zones:[
      {key:'koregaon',  label:'Koregaon Park',     lat:18.5362,lon:73.8939,zoom:14},
      {key:'hinjewadi', label:'Hinjewadi IT Hub',  lat:18.5912,lon:73.7389,zoom:14},
      {key:'kothrud',   label:'Kothrud',           lat:18.5063,lon:73.8080,zoom:14},
      {key:'pimpri',    label:'Pimpri-Chinchwad',  lat:18.6298,lon:73.7997,zoom:13},
      {key:'yerawada',  label:'Yerawada / Airport',lat:18.5793,lon:73.9120,zoom:13},
    ],
  },
  ahmedabad: {
    name:'Ahmedabad', state:'Gujarat', code:'AMD',
    lat:23.0225, lon:72.5714, zoom:12, grid:0.680, aqiSlug:'ahmedabad',
    placeholder:{from:'e.g. CG Road, Ahmedabad', to:'e.g. SG Highway, Ahmedabad'},
    metro:'Ahmedabad Metro (GMRC)',
    suburban:'Ahmedabad Suburban Rail',
    suburbanKwhPerKm:0.030,
    hasMonorail:false,
    zones:[
      {key:'cgroad',    label:'CG Road & CBD',     lat:23.0395,lon:72.5540,zoom:14},
      {key:'sghighway', label:'SG Highway / West', lat:23.0552,lon:72.5054,zoom:13},
      {key:'vatva',     label:'Vatva / Industrial',lat:22.9499,lon:72.6345,zoom:13},
      {key:'airport',   label:'Sardar Airport',    lat:23.0726,lon:72.6342,zoom:13},
      {key:'sanand',    label:'Sanand / Auto Hub', lat:22.9860,lon:72.3831,zoom:13},
    ],
  },
  kochi: {
    name:'Kochi', state:'Kerala', code:'COK',
    lat:9.9312, lon:76.2673, zoom:13, grid:0.430, aqiSlug:'kochi',
    placeholder:{from:'e.g. MG Road, Kochi', to:'e.g. Kakkanad, Kochi'},
    metro:'Kochi Metro (KMRL)',
    suburban:'Kochi Water Metro / Suburban Rail',
    suburbanKwhPerKm:0.025,
    hasMonorail:false,
    zones:[
      {key:'mgroad',    label:'MG Road & CBD',     lat:9.9312,lon:76.2673,zoom:14},
      {key:'kakkanad',  label:'Kakkanad / Infopark',lat:10.0183,lon:76.3552,zoom:14},
      {key:'ernakulam', label:'Ernakulam North',   lat:9.9816,lon:76.2999,zoom:14},
      {key:'edapally',  label:'Edapally / NH',     lat:10.0278,lon:76.3085,zoom:13},
      {key:'airport',   label:'Nedumbassery',      lat:10.1520,lon:76.4018,zoom:13},
    ],
  },
  jaipur: {
    name:'Jaipur', state:'Rajasthan', code:'JAI',
    lat:26.9124, lon:75.7873, zoom:12, grid:0.780, aqiSlug:'jaipur',
    placeholder:{from:'e.g. MI Road, Jaipur', to:'e.g. Vaishali Nagar, Jaipur'},
    metro:'Jaipur Metro (JMRC)',
    suburban:'Jaipur Suburban Rail',
    suburbanKwhPerKm:0.030,
    hasMonorail:false,
    zones:[
      {key:'miroad',    label:'MI Road & Pink City',lat:26.9124,lon:75.7873,zoom:14},
      {key:'vaishali',  label:'Vaishali Nagar',    lat:26.9300,lon:75.7438,zoom:14},
      {key:'mansarovar',label:'Mansarovar',        lat:26.8445,lon:75.7788,zoom:14},
      {key:'sitapura',  label:'Sitapura Industrial',lat:26.7815,lon:75.8564,zoom:13},
      {key:'sanganer',  label:'Sanganer / Airport',lat:26.8243,lon:75.8122,zoom:13},
    ],
  },
};

let currentCityKey = 'chennai';
function city() { return CITIES[currentCityKey]; }

/* Build AREA_CENTRES map from current city zones */
function buildAreaCentres() {
  return Object.fromEntries(city().zones.map(z => [z.key, z]));
}
let AREA_CENTRES = buildAreaCentres();
let currentArea  = city().zones[0].key;

// ──────────────────────────────────────────────────────
//  SET CITY — updates every city-specific element
// ──────────────────────────────────────────────────────
function setCity(key) {
  if (!CITIES[key]) return;
  currentCityKey = key;
  AREA_CENTRES   = buildAreaCentres();
  currentArea    = city().zones[0].key;

  /* City picker pills */
  document.querySelectorAll('.city-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.city === key));

  /* Logo */
  const lc = document.getElementById('logoCity');
  if (lc) lc.textContent = city().name;
  const logo = document.querySelector('.logo');
  if (logo) logo.setAttribute('aria-label', 'TAINT home');

  /* Route input placeholders */
  document.getElementById('fromLoc')?.setAttribute('placeholder', city().placeholder.from);
  document.getElementById('toLoc')  ?.setAttribute('placeholder', city().placeholder.to);

  /* Satellite area select — rebuild from city zones */
  const sel = document.getElementById('satArea');
  if (sel) {
    sel.innerHTML = city().zones
      .map(z => `<option value="${z.key}">${z.label}</option>`).join('');
  }

  /* Pan route map and clear previous route */
  if (routeMapReady && routeMap) {
    routeMap.setView([city().lat, city().lon], city().zoom);
    if (routePolyline){ routeMap.removeLayer(routePolyline); routePolyline=null; }
    if (pinFrom){ routeMap.removeLayer(pinFrom); pinFrom=null; coordFrom=null; }
    if (pinTo)  { routeMap.removeLayer(pinTo);   pinTo=null;   coordTo=null;   }
    document.getElementById('fromLoc').value='';
    document.getElementById('toLoc').value='';
    ['fromClear','toClear'].forEach(id=>document.getElementById(id).classList.remove('show'));
    document.getElementById('routeResult').classList.remove('show');
  }

  /* Pan City Vision satellite maps */
  if (mapsReady && leafSat) {
    const z0 = city().zones[0];
    leafSat   .setView([z0.lat,z0.lon], z0.zoom);
    leafEffect?.setView([z0.lat,z0.lon], z0.zoom, {animate:false});
  }

  /* Rebuild transit options for new city */
  buildTransitOptions();
  if (currentCat === 'transit') {
    renderFuelPills('transit');
    populateVehicles();
  } else if (typeof calculate === 'function' && document.getElementById('vehicle')) {
    calculate();
  }

  /* Workplace grid note */
  const gn = document.getElementById('wpGridNote');
  if (gn) gn.textContent =
    `${city().name} (${city().state}): ${city().grid} kg CO₂/kWh`;
  const routeErr = document.getElementById('routeErr');
  if (routeErr) routeErr.textContent = `Could not find one or both locations. Try adding "${city().name}".`;
  const visionCity = document.getElementById('visionCityName');
  if (visionCity) visionCity.textContent = city().name;

  /* Refresh live data */
  fetchWeather();
  fetchAQI();
}

document.addEventListener('click', e => {
  const btn = e.target?.closest?.('.city-pill, .sb-city-btn');
  if (!btn?.dataset?.city) return;
  e.preventDefault();
  setCity(btn.dataset.city);
});
let leafSat      = null;   // left interactive map
let leafEffect   = null;   // right synced map
let mapsReady    = false;

const SAT_URL    = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const STREET_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}';
const LABEL_URL  = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const TILE_OPTS  = { maxZoom: 19, attribution: '© Esri' };

function initLeafletMaps() {
  if (mapsReady) return;
  if (!hasLeaflet()) {
    const sat = document.getElementById('mapSat');
    const eff = document.getElementById('mapEffect');
    const msg = '<div class="route-err show">City Vision maps are unavailable. Calculator results still work.</div>';
    if (sat) sat.innerHTML = msg;
    if (eff) eff.innerHTML = msg;
    return;
  }
  mapsReady = true;

  const c = AREA_CENTRES[currentArea] || city().zones[0];

  /* ── Left map: satellite + streets + labels (interactive) ── */
  leafSat = L.map('mapSat', { zoomControl: true, attributionControl: true })
              .setView([c.lat, c.lon], c.zoom);
  L.tileLayer(SAT_URL, TILE_OPTS).addTo(leafSat);
  L.tileLayer(STREET_URL, { ...TILE_OPTS, opacity: 0.65 }).addTo(leafSat);
  L.tileLayer(LABEL_URL,  { ...TILE_OPTS, opacity: 0.90 }).addTo(leafSat);

  /* ── Right map: same layers, non-interactive, synced ── */
  leafEffect = L.map('mapEffect', { zoomControl: false, attributionControl: false,
                                     dragging: false, touchZoom: false, scrollWheelZoom: false,
                                     doubleClickZoom: false, keyboard: false })
                .setView([c.lat, c.lon], c.zoom);
  L.tileLayer(SAT_URL,    TILE_OPTS).addTo(leafEffect);
  L.tileLayer(STREET_URL, { ...TILE_OPTS, opacity: 0.65 }).addTo(leafEffect);
  L.tileLayer(LABEL_URL,  { ...TILE_OPTS, opacity: 0.90 }).addTo(leafEffect);

  /* Keep right panel in sync when user pans/zooms left panel */
  leafSat.on('move zoom', () => {
    leafEffect.setView(leafSat.getCenter(), leafSat.getZoom(), { animate: false });
  });

  leafSat.invalidateSize();
  leafEffect.invalidateSize();
}

/* Pan both maps to a new area */
function flyToArea(areaKey) {
  currentArea = areaKey;
  const c = AREA_CENTRES[areaKey] || AREA_CENTRES.marina;
  if (leafSat)    leafSat.setView([c.lat, c.lon], c.zoom);
  if (leafEffect) leafEffect.setView([c.lat, c.lon], c.zoom, { animate: false });
}

document.getElementById('satArea').addEventListener('change', function () {
  flyToArea(this.value);
  if (lastPerPaxKg > 0) applyEmissionEffect();
});

document.getElementById('satReloadBtn').addEventListener('click', () => {
  if (leafSat)    leafSat.invalidateSize();
  if (leafEffect) leafEffect.invalidateSize();
});

document.getElementById('genBtn').addEventListener('click', generateCityVision);


// ──────────────────────────────────────────────────────
//  INIT — runs when DOM is ready
// ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  /* Restore saved theme */
  try { if(localStorage.getItem('taint_theme')==='light') applyTheme(true); } catch {}

  /* Start live clock — updates every second */
  tickClock(); setInterval(tickClock,1000);

  /* Fetch AQI now and refresh every 30 min */
  fetchAQI(); setInterval(fetchAQI, 30*60*1000);

  /* Fetch Chennai temperature now and refresh every 10 min */
  fetchWeather(); setInterval(fetchWeather, 10*60*1000);

  /* Supabase global stats */
  initSupabase();

  /* Calculator */
  renderFuelPills(currentCat);
  populateVehicles(); // triggers first calculate()

  /* Usage tracker */
  renderTracker(); updateMonthStat();
  syncCookieConsent();
  refreshAllRecentCalculations();

  /* Auth — restore session or show overlay */
  initAuth();

  /* Build desktop sidebar */
  buildSidebar();

  /* Build initial transit options for default city */
  buildTransitOptions();

  /* Show fallback prices immediately, then fetch live in background */
  applyPrices(DEFAULT_PRICES,'fallback');
  fetchLivePrices();

  /* Render stored feedback */
  renderFeedback();
});

// ──────────────────────────────────────────────────────
//  SITE CARBON FOOTPRINT TRACKER
//  Measures actual data transferred and estimates CO₂
//  using the Sustainable Web Design (SWD) model with
//  India's grid carbon intensity (CEA 2023).
// ──────────────────────────────────────────────────────

const SC = {
  // India CEA 2023 grid intensity: 716 g CO₂/kWh
  GRID_G_PER_KWH : 716,
  // SWD model: 1.805 kWh per GB transferred
  KWH_PER_GB     : 1.805,
  // Derived: g CO₂ per byte
  get G_PER_BYTE(){ return this.KWH_PER_GB * this.GRID_G_PER_KWH / (1024 ** 3); },

  // Buckets (bytes)
  pageBytes  : 0,
  tileBytes  : 0,
  apiBytes   : 0,
  tileCount  : 0,
  apiCount   : 0,
  seenResources : new Set(),

  // Known approximate response sizes for cross-origin requests
  // (Performance API returns transferSize=0 for cross-origin without TAHI)
  KNOWN : {
    'router.project-osrm.org' : 18000,  // OSRM route with full geometry ~18 KB
    'nominatim.openstreetmap.org' : 2200, // geocode result ~2.2 KB
    'server.arcgisonline.com' : 38000,  // ESRI satellite tile ~38 KB
    'tile.openstreetmap.org'  : 14000,  // OSM tile ~14 KB
    'calendarmcp.googleapis.com': 1000,
    'gmailmcp.googleapis.com' : 1000,
    'fonts.googleapis.com'    : 1200,
    'fonts.gstatic.com'       : 28000,
    'cdnjs.cloudflare.com'    : 65000,  // Leaflet ~65 KB minified
  },

  sizeOf(url){
    try {
      const host = new URL(url).hostname;
      for(const [k,v] of Object.entries(this.KNOWN))
        if(host.includes(k)) return v;
    } catch{}
    return 3000; // generic fallback ~3 KB
  },

  totalBytes(){ return this.pageBytes + this.tileBytes + this.apiBytes; },
  totalGrams(){ return this.totalBytes() * this.G_PER_BYTE; },

  isTile(url){
    return /arcgisonline\.com\/.*tile|tile\.openstreetmap|tile\.osm|opentopomap|esri.*tile/i.test(url);
  },
  isApi(url){
    return /nominatim|osrm|project-osrm|overpass|googleapis/i.test(url);
  },
  bucketFor(url){
    if(this.isTile(url)) return 'tile';
    if(this.isApi(url)) return 'api';
    return 'page';
  },
  addBytes(bucket, bytes, count=true){
    const size = Math.max(0, Math.round(bytes || 0));
    if(!size) return;
    if(bucket === 'tile') { this.tileBytes += size; if(count) this.tileCount++; }
    else if(bucket === 'api') { this.apiBytes += size; if(count) this.apiCount++; }
    else this.pageBytes += size;
  },
  entryBytes(entry){
    if(entry.transferSize > 0) return entry.transferSize;
    try {
      const url = new URL(entry.name, location.href);
      const sameOrigin = url.origin === location.origin;
      if(location.protocol === 'file:' && entry.encodedBodySize > 0) return entry.encodedBodySize;
      if(!sameOrigin) return this.sizeOf(entry.name);
    } catch {}
    return 0;
  },
  recordResource(entry){
    if(!entry?.name) return;
    if(['fetch','xmlhttprequest','beacon'].includes(entry.initiatorType)) return;
    const bucket = this.bucketFor(entry.name);
    const key = `${bucket}:${entry.name}`;
    if(this.seenResources.has(key)) return;
    this.seenResources.add(key);
    this.addBytes(bucket, this.entryBytes(entry), bucket !== 'page');
  },
  recordFetch(url, bytes){
    const bucket = this.bucketFor(url);
    this.addBytes(bucket === 'page' ? 'api' : bucket, bytes || this.sizeOf(url), true);
  },
};

/* Grade thresholds (g CO₂ per session) — adapted from websitecarbon.com */
function scGrade(grams){
  if(grams <  0.095) return 'A+';
  if(grams <  0.19)  return 'A';
  if(grams <  0.4)   return 'B';
  if(grams <  0.75)  return 'C';
  if(grams <  1.5)   return 'D';
  return 'F';
}

/* Format bytes → human-readable KB/MB */
function fmtBytes(b){
  if(b < 1024)      return b + ' B';
  if(b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

/* Format grams → mg or g */
function fmtGrams(g){
  if(g < 0.001) return (g*1000000).toFixed(1) + ' µg';
  if(g < 1)     return (g*1000).toFixed(2) + ' mg';
  return g.toFixed(3) + ' g';
}

/* Equivalents */
function scEquivHTML(g){
  const mg = g * 1000;
  const lines = [];
  // Phone charge: full charge (0→100%) of a smartphone ≈ 10 Wh → 7.16 g CO₂
  const phoneSec = (g / 7.16) * 3600;
  if(phoneSec < 3600)
    lines.push(`📱 Charges your phone for <b>${phoneSec.toFixed(1)} sec</b>`);
  else
    lines.push(`📱 Charges your phone for <b>${(phoneSec/60).toFixed(1)} min</b>`);
  // LED bulb (9 W): 9W × h × 0.716 kg/kWh → CO₂
  const ledMin = (g / (9 / 1000 * 0.716 * 1000)) * 60;
  lines.push(`💡 Powers a 9 W LED for <b>${ledMin < 60 ? ledMin.toFixed(1)+' min' : (ledMin/60).toFixed(2)+' hr'}</b>`);
  // Streaming video (data only): ~1 GB/hr on mobile → at this CO₂/GB
  const streamSec = (g / SC.totalGrams()) * SC.totalBytes() / (1e9 / 3600);
  // Email: ~4 g CO₂ per email with attachment, 0.3 g without
  const emails = (g / 0.3).toFixed(1);
  lines.push(`📧 Equivalent to sending <b>${emails} plain-text emails</b>`);
  return lines.join('<br>');
}

let scAnimFrame = null;
let scDisplayedG = 0;

/* Smoothly animate the CO₂ counter */
function scAnimateTo(targetG){
  if(scAnimFrame) cancelAnimationFrame(scAnimFrame);
  const start = scDisplayedG;
  const delta = targetG - start;
  const dur   = 600;
  const t0    = performance.now();
  function step(now){
    const p = Math.min(1, (now - t0) / dur);
    const ease = 1 - Math.pow(1 - p, 3);
    scDisplayedG = start + delta * ease;
    renderScHero(scDisplayedG);
    if(p < 1) scAnimFrame = requestAnimationFrame(step);
  }
  scAnimFrame = requestAnimationFrame(step);
}

function renderScHero(g){
  const valEl  = document.getElementById('scCO2Val');
  const unitEl = document.getElementById('scCO2Unit');
  if(!valEl) return;
  let val, unit;
  if(g < 0.001)      { val = (g*1000000).toFixed(1); unit = 'µg CO₂'; }
  else if(g < 1)     { val = (g*1000).toFixed(2);    unit = 'mg CO₂'; }
  else               { val = g.toFixed(3);             unit = 'g CO₂'; }
  valEl.textContent  = val;
  unitEl.textContent = unit;
  // Colour by severity
  valEl.className = 'sc-co2-val' + (g > 1.5 ? ' red' : g > 0.75 ? ' amber' : '');
}

function updateSiteCarbonUI(){
  const totalG = SC.totalGrams();
  const pageG  = SC.pageBytes * SC.G_PER_BYTE;
  const tileG  = SC.tileBytes * SC.G_PER_BYTE;
  const apiG   = SC.apiBytes  * SC.G_PER_BYTE;
  const total  = SC.totalBytes();

  scAnimateTo(totalG);

  /* Grade */
  const grade = scGrade(totalG);
  const gradeEl = document.getElementById('scGrade');
  if(gradeEl){
    gradeEl.textContent = grade;
    gradeEl.className   = 'sc-grade ' + grade.replace('+','');
  }

  /* Stacked bar */
  if(total > 0){
    const pageBar = document.getElementById('scPageBar');
    const tileBar = document.getElementById('scTileBar');
    const apiBar  = document.getElementById('scApiBar');
    if(pageBar) pageBar.style.width = (SC.pageBytes/total*100).toFixed(1)+'%';
    if(tileBar) tileBar.style.width = (SC.tileBytes/total*100).toFixed(1)+'%';
    if(apiBar)  apiBar.style.width  = (SC.apiBytes /total*100).toFixed(1)+'%';
  }

  /* Rows */
  const setText = (id, value) => { const el = document.getElementById(id); if(el) el.textContent = value; };
  setText('scPageKB', fmtBytes(SC.pageBytes));
  setText('scTileKB', fmtBytes(SC.tileBytes));
  setText('scApiKB', fmtBytes(SC.apiBytes));
  setText('scPageCO2', fmtGrams(pageG));
  setText('scTileCO2', fmtGrams(tileG));
  setText('scApiCO2', fmtGrams(apiG));
  setText('scTileCount', SC.tileCount);
  setText('scApiCount', SC.apiCount);

  /* Equivalents */
  if(total > 0){
    const eq = document.getElementById('scEquiv');
    if(eq) eq.innerHTML = scEquivHTML(totalG);
  }

  /* Compare to commute CO₂ */
  const perPaxEl = document.getElementById('perPax');
  if(perPaxEl){
    const commute = parseFloat(perPaxEl.textContent);
    if(commute > 0){
      const pct = (totalG / (commute * 1000) * 100).toFixed(4);
      const cmp = document.getElementById('scCompare');
      if(cmp){
        cmp.innerHTML = `🚗 Your one-way commute emits <b>${(commute*1000).toFixed(2)} g CO₂</b> — using this tool for your session is <b>${pct}%</b> of that.`;
        cmp.classList.add('show');
      }
    }
  }

  /* ── Sync Taint Contact carbon panel (live) ── */
  const tcV = document.getElementById('tcScVal');
  const tcU = document.getElementById('tcScUnit');
  if(tcV && tcU){
    let tv, tu;
    if(totalG < 0.001)     { tv=(totalG*1e6).toFixed(1); tu='µg CO₂'; }
    else if(totalG < 1)    { tv=(totalG*1000).toFixed(2); tu='mg CO₂'; }
    else                   { tv=totalG.toFixed(3);         tu='g CO₂'; }
    tcV.textContent = tv; tcU.textContent = tu;
    tcV.className   = 'sc-co2-val'+(totalG>1.5?' red':totalG>0.75?' amber':'');
  }
  const ge = id=>document.getElementById(id);
  if(ge('tcPageCO2'))   ge('tcPageCO2').textContent   = fmtGrams(pageG);
  if(ge('tcTileCO2'))   ge('tcTileCO2').textContent   = fmtGrams(tileG);
  if(ge('tcApiCO2'))    ge('tcApiCO2').textContent    = fmtGrams(apiG);
  if(ge('tcTileCount')) ge('tcTileCount').textContent = SC.tileCount;
  if(ge('tcApiCount'))  ge('tcApiCount').textContent  = SC.apiCount;
}

/* Measure page load resources via Performance API */
function measurePageLoad(){
  const nav = performance.getEntriesByType('navigation')[0];
  if(nav) {
    const navBytes = nav.transferSize > 0
      ? nav.transferSize
      : (location.protocol === 'file:' ? new Blob([document.documentElement.outerHTML]).size : nav.encodedBodySize || 0);
    SC.addBytes('page', navBytes, false);
  }

  performance.getEntriesByType('resource').forEach(e => SC.recordResource(e));

  // Observe future resources
  if('PerformanceObserver' in window){
    const po = new PerformanceObserver(list => {
      list.getEntries().forEach(e => SC.recordResource(e));
      updateSiteCarbonUI();
    });
    po.observe({type:'resource', buffered:false});
  }

  updateSiteCarbonUI();
}

/* Intercept fetch to catch cross-origin API calls */
(function interceptFetch(){
  const orig = window.fetch;
  window.fetch = async function(...args){
    const url = typeof args[0]==='string' ? args[0] : args[0]?.url || '';
    const res = await orig.apply(this, args);
    const clone = res.clone();
    clone.blob().then(b => {
      SC.recordFetch(url, b.size > 0 ? b.size : SC.sizeOf(url));
      updateSiteCarbonUI();
    }).catch(()=>{});
    return res;
  };
})();

/* Kick off measurement after page load */
if(document.readyState === 'complete'){
  setTimeout(measurePageLoad, 1500);
} else {
  window.addEventListener('load', () => setTimeout(measurePageLoad, 1500));
}

/* Update commute comparison whenever the calculator runs */
const _origScheduleCalc = typeof scheduleCalc === 'function' ? scheduleCalc : null;
// Hook into results update by observing perPax element
if('MutationObserver' in window){
  const perPaxEl = document.getElementById('perPax');
  if(perPaxEl){
    new MutationObserver(updateSiteCarbonUI).observe(perPaxEl, {childList:true, characterData:true, subtree:true});
  }
}

// ──────────────────────────────────────────────────────
//  GEOLOCATION — current location → From field
// ──────────────────────────────────────────────────────

document.getElementById('geoFromBtn').addEventListener('click', async () => {
  const btn = document.getElementById('geoFromBtn');
  if (!('geolocation' in navigator)) { alert('Geolocation not supported by this browser.'); return; }
  btn.classList.add('loading'); btn.textContent = '⏳ Locating…';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const {latitude: lat, longitude: lon} = pos.coords;
      coordFrom = {lat, lon};
      if (!routeMapReady) initRouteMap();
      placePin('from', lat, lon);
      autoUpdateCityVisionArea(lat, lon);
      await reverseGeocode(lat, lon, 'from');
      btn.classList.remove('loading'); btn.textContent = '📍 My Location';
      document.getElementById('fromClear').classList.add('show');
      if (coordTo) fetchRoute();
    },
    err => {
      btn.classList.remove('loading'); btn.textContent = '📍 My Location';
      alert('Could not get your location: ' + err.message);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ──────────────────────────────────────────────────────
//  LIVE JOURNEY TRACKER
//  Watches GPS position, calculates speed, predicts
//  vehicle type, and computes real-time CO₂ emission.
// ──────────────────────────────────────────────────────

/* Emission factors per predicted mode (g CO₂ per km) */
const LT_MODES = {
  stationary: { gPerKm:  0,   icon:'🚦', label:'Stopped',         cat:null,     fuel:null      },
  walk:       { gPerKm:  0,   icon:'🚶', label:'Walking',          cat:'two',    fuel:'walk'    },
  cycle:      { gPerKm:  0,   icon:'🚲', label:'Cycling',          cat:'two',    fuel:'cycle'   },
  two_petrol: { gPerKm: 63,   icon:'🛵', label:'Two-Wheeler',      cat:'two',    fuel:'petrol'  },
  auto:       { gPerKm: 82,   icon:'🛺', label:'Auto / Share Auto',cat:'shared', fuel:'cng'     },
  bus:        { gPerKm: 28,   icon:'🚌', label:'Bus',              cat:'shared', fuel:'cng'     },
  car:        { gPerKm:140,   icon:'🚗', label:'Car',              cat:'four',   fuel:'petrol'  },
  metro:      { gPerKm: 35,   icon:'🚆', label:'Metro / Train',    cat:'shared', fuel:'electric'},
};

/* Speed-to-mode prediction with Chennai traffic patterns */
function predictMode(speeds, pauses) {
  if (!speeds.length) return { mode:'stationary', confidence:0 };
  const avg  = speeds.reduce((a,b)=>a+b,0)/speeds.length;
  const max  = Math.max(...speeds);
  const dev  = Math.sqrt(speeds.reduce((s,v)=>s+(v-avg)**2,0)/speeds.length);
  const pauseRatio = pauses / Math.max(1, speeds.length); // fraction of stopped readings

  let mode, confidence;
  if      (avg < 1.5)                       { mode='stationary'; confidence = avg < 0.3 ? 3 : 2; }
  else if (avg < 6)                         { mode='walk';       confidence = avg < 3 ? 3 : 2;   }
  else if (avg < 22 && max < 30)            { mode='cycle';      confidence = 2;                  }
  else if (avg < 35 && pauseRatio > 0.25)   { mode='bus';        confidence = dev > 6 ? 2 : 3;   }
  else if (avg < 35)                        { mode='two_petrol'; confidence = 2;                  }
  else if (avg < 50 && pauseRatio > 0.2)    { mode='auto';       confidence = 2;                  }
  else if (avg < 70)                        { mode='car';        confidence = avg>55?3:2;          }
  else if (avg < 100 && dev < 10)           { mode='metro';      confidence = 3;                  }
  else                                      { mode='car';        confidence = avg>90?2:1;          }

  /* Boost confidence if we have many consistent readings */
  if (speeds.length >= 10 && dev < 8) confidence = Math.min(3, confidence+1);

  return { mode, confidence };
}

/* Live tracker state */
let ltWatchId    = null;
let ltRunning    = false;
let ltPositions  = [];    // [{lat,lon,ts,speed,accuracy}]
let ltSpeeds     = [];    // rolling window of valid speeds (km/h)
let ltPauses     = 0;     // count of near-zero speed readings
let ltTotalDist  = 0;     // km traveled
let ltTotalCO2g  = 0;     // grams CO₂
let ltStartTime  = null;
let ltLastPos    = null;
let ltCurMode    = 'stationary';
let ltSpeedHistory = [];  // for sparkline (last 60 readings)
let ltTrackedPolyline = null;
let ltTrackedPoints   = [];
let ltElapsedTimer = null;

const GAUGE_ARC = 172.8; // full arc stroke-dasharray value
const GAUGE_MAX = 120;   // km/h = full gauge

function ltUpdateGauge(speed) {
  const pct    = Math.min(1, speed / GAUGE_MAX);
  const offset = GAUGE_ARC * (1 - pct);
  const arc    = document.getElementById('ltGaugeArc');
  if (!arc) return;
  arc.style.strokeDashoffset = offset;
  arc.style.stroke = speed < 6 ? '#34d399'
                   : speed < 35 ? '#60a5fa'
                   : speed < 70 ? '#fb923c' : '#ef4444';
}

function ltUpdateSparkline() {
  const poly = document.getElementById('ltSparkPoly');
  if (!poly || ltSpeedHistory.length < 2) return;
  const w=300, h=40, n=Math.min(60, ltSpeedHistory.length);
  const slice = ltSpeedHistory.slice(-n);
  const mx = Math.max(1, Math.max(...slice));
  const pts = slice.map((v,i)=>`${(i/(n-1)*w).toFixed(1)},${(h - v/mx*(h-4)-2).toFixed(1)}`).join(' ');
  poly.setAttribute('points', pts);
}

function ltUpdateConfidence(level, label) {
  [1,2,3].forEach(i => {
    const el = document.getElementById('ltConf'+i);
    if (el) el.classList.toggle('on', i <= level);
  });
  const txt = document.getElementById('ltConfTxt');
  if (txt) txt.textContent = ['—','Low','Medium','High'][level] || '—';
}

function ltUpdatePrediction(mode, confidence) {
  ltCurMode = mode;
  const m = LT_MODES[mode] || LT_MODES.stationary;
  document.getElementById('ltPredIcon').textContent = m.icon;
  document.getElementById('ltPredLbl').textContent  = m.label;
  ltUpdateConfidence(confidence, '');
}

function ltUpdateStats() {
  document.getElementById('ltDistVal').textContent    = ltTotalDist.toFixed(2);
  document.getElementById('ltCO2Val').textContent     = ltTotalCO2g.toFixed(1);
  if (ltSpeeds.length)
    document.getElementById('ltAvgSpeedVal').textContent =
      (ltSpeeds.reduce((a,b)=>a+b,0)/ltSpeeds.length).toFixed(0);
}

function ltFormatElapsed() {
  if (!ltStartTime) return '0:00';
  const s = Math.floor((Date.now() - ltStartTime)/1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

function ltOnPosition(pos) {
  const { latitude:lat, longitude:lon, accuracy, speed:rawSpeed } = pos.coords;
  const ts = pos.timestamp;
  if (accuracy > 50) return; // ignore low-accuracy readings

  let speed = 0;
  if (rawSpeed != null && rawSpeed >= 0) {
    speed = rawSpeed * 3.6; // m/s → km/h
  } else if (ltLastPos) {
    const dist = haversine(ltLastPos.lat, ltLastPos.lon, lat, lon);
    const dt   = (ts - ltLastPos.ts) / 3600000;
    speed = dt > 0 ? Math.min(200, dist / dt) : 0;
  }

  /* Accumulate distance and CO₂ */
  if (ltLastPos) {
    const seg = haversine(ltLastPos.lat, ltLastPos.lon, lat, lon);
    if (seg < 0.5) { // ignore GPS jumps > 500m between readings
      ltTotalDist  += seg;
      ltTotalCO2g  += seg * (LT_MODES[ltCurMode]?.gPerKm || 0);
    }
  }

  if (speed < 1.5) ltPauses++;
  ltSpeeds.push(speed);
  if (ltSpeeds.length > 30) ltSpeeds.shift();
  ltSpeedHistory.push(speed);
  if (ltSpeedHistory.length > 60) ltSpeedHistory.shift();

  /* Predict mode */
  const { mode, confidence } = predictMode(ltSpeeds, ltPauses);
  ltUpdatePrediction(mode, confidence);

  /* Update map tracked path */
  ltTrackedPoints.push([lat, lon]);
  if (routeMap) {
    if (ltTrackedPolyline) ltTrackedPolyline.setLatLngs(ltTrackedPoints);
    else ltTrackedPolyline = L.polyline(ltTrackedPoints,
      {color:'#a78bfa',weight:4,opacity:.8,dashArray:'6,4'}).addTo(routeMap);
    routeMap.panTo([lat, lon], {animate:true, duration:.5});
  }

  /* Update UI */
  document.getElementById('ltSpeedVal').textContent = speed.toFixed(0);
  document.getElementById('ltTimeVal').textContent  = ltFormatElapsed();
  ltUpdateGauge(speed);
  ltUpdateStats();
  ltUpdateSparkline();

  /* Store first position as From */
  if (!ltLastPos) {
    coordFrom = {lat, lon};
    placePin('from', lat, lon);
    reverseGeocode(lat, lon, 'from');
    document.getElementById('fromClear').classList.add('show');
    autoUpdateCityVisionArea(lat, lon);
  }

  ltLastPos = {lat, lon, ts, speed};
  ltPositions.push({lat, lon, ts, speed, accuracy});
}

function ltStart() {
  if (!('geolocation' in navigator)) { alert('Geolocation not supported.'); return; }
  ltRunning     = true;
  ltPositions   = []; ltSpeeds = []; ltPauses = 0;
  ltTotalDist   = 0;  ltTotalCO2g = 0;
  ltLastPos     = null; ltSpeedHistory = [];
  ltStartTime   = Date.now();
  ltCurMode     = 'stationary';

  /* Clear previous tracked path */
  if (ltTrackedPolyline && routeMap) { routeMap.removeLayer(ltTrackedPolyline); ltTrackedPolyline=null; }
  ltTrackedPoints = [];

  /* Status */
  document.getElementById('ltDot').className = 'lt-status-dot tracking';
  document.getElementById('ltStatusTxt').textContent = 'Tracking your journey…';
  document.getElementById('ltSummary').classList.remove('show');

  /* Elapsed timer */
  clearInterval(ltElapsedTimer);
  ltElapsedTimer = setInterval(()=>{
    document.getElementById('ltTimeVal').textContent = ltFormatElapsed();
  }, 1000);

  ltWatchId = navigator.geolocation.watchPosition(ltOnPosition,
    err => { document.getElementById('ltStatusTxt').textContent = '⚠ ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

function ltStop() {
  ltRunning = false;
  if (ltWatchId != null) { navigator.geolocation.clearWatch(ltWatchId); ltWatchId=null; }
  clearInterval(ltElapsedTimer);

  document.getElementById('ltDot').className      = 'lt-status-dot done';
  document.getElementById('ltStatusTxt').textContent = `Journey recorded · ${ltFormatElapsed()} · ${ltTotalDist.toFixed(2)} km`;

  /* Compute dominant mode */
  const { mode, confidence } = predictMode(ltSpeeds, ltPauses);
  ltUpdatePrediction(mode, confidence);
  ltUpdateGauge(0);

  /* Store end position as To */
  if (ltLastPos) {
    coordTo = {lat: ltLastPos.lat, lon: ltLastPos.lon};
    placePin('to', ltLastPos.lat, ltLastPos.lon);
    reverseGeocode(ltLastPos.lat, ltLastPos.lon, 'to');
    document.getElementById('toClear').classList.add('show');
  }

  /* Show summary */
  const avgSpeed = ltSpeeds.length
    ? (ltSpeeds.reduce((a,b)=>a+b,0)/ltSpeeds.length).toFixed(1) : '—';
  const m = LT_MODES[mode] || LT_MODES.stationary;
  const grid = document.getElementById('ltSumGrid');
  grid.innerHTML = [
    `<div class="lt-sum-item"><b>${ltTotalDist.toFixed(2)} km</b><span>Distance</span></div>`,
    `<div class="lt-sum-item"><b>${ltTotalCO2g.toFixed(1)} g</b><span>CO₂ emitted</span></div>`,
    `<div class="lt-sum-item"><b>${avgSpeed} km/h</b><span>Average speed</span></div>`,
    `<div class="lt-sum-item"><b>${m.icon} ${m.label}</b><span>Predicted mode</span></div>`,
    `<div class="lt-sum-item"><b>${ltFormatElapsed()}</b><span>Duration</span></div>`,
    `<div class="lt-sum-item"><b>${confidence===3?'High':confidence===2?'Medium':'Low'}</b><span>Confidence</span></div>`,
  ].join('');
  document.getElementById('ltSummary').classList.add('show');

  document.getElementById('ltToggleBtn').textContent = '🚦 Track Live Journey';
  document.getElementById('ltToggleBtn').classList.remove('active');
}

/* Wire up buttons */
document.getElementById('ltToggleBtn').addEventListener('click', () => {
  if (!ltRunning) {
    document.getElementById('ltCard').classList.add('open');
    document.getElementById('ltToggleBtn').textContent = '■ Tracking…';
    document.getElementById('ltToggleBtn').classList.add('active');
    if (!routeMapReady) initRouteMap();
    ltStart();
  } else {
    ltStop();
  }
});
document.getElementById('ltStopBtn').addEventListener('click', ltStop);

/* "Use this journey" fills the calculator */
document.getElementById('ltUseBtn').addEventListener('click', () => {
  const m = LT_MODES[ltCurMode] || LT_MODES.stationary;

  /* Set distance */
  document.getElementById('distance').value = ltTotalDist.toFixed(2);
  setDistLinked(false); // manually set

  /* Switch vehicle category & fuel to match prediction */
  if (m.cat) {
    const catBtn = document.querySelector(`.cat-btn[data-cat="${m.cat}"]`);
    if (catBtn) catBtn.click();
    setTimeout(()=>{
      if (m.fuel) {
        const pillBtn = [...document.querySelectorAll('.fp')]
          .find(p=>p.dataset.fuel===m.fuel);
        if (pillBtn) pillBtn.click();
      }
      scheduleCalc();
    }, 100);
  } else {
    scheduleCalc();
  }

  /* Scroll to results */
  document.getElementById('result')?.scrollIntoView({behavior:'smooth', block:'start'});
});

// ──────────────────────────────────────────────────────
//  AUTH SYSTEM
//  Supabase Auth when configured · local fallback otherwise
//  Guest / skip always available
// ──────────────────────────────────────────────────────

let supabaseClient = null;
let currentUser    = null;
const AUTH_RESET_COOLDOWN_MS = Number(authSettings().resetEmailCooldownMs || 60000);
let authResetInFlightEmail = '';
let authLastResetRequest = { email:'', at:0 };

if (SB_CONFIGURED() && window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  });
}

function authSettings() {
  const cfg = window.TAINT_SUPABASE_CONFIG || {};
  const envName = SUPABASE_CONFIG.environment || cfg.environment || 'dev';
  const envCfg = (cfg.environments && cfg.environments[envName]) || {};
  const envHasSiteUrl = !!(cfg.environments &&
    Object.prototype.hasOwnProperty.call(cfg.environments, envName) &&
    Object.prototype.hasOwnProperty.call(envCfg, 'siteUrl'));
  return {
    ...(cfg.auth || {}),
    ...(envCfg.auth || {}),
    siteUrl: envHasSiteUrl ? String(envCfg.siteUrl || '').trim() : (cfg.auth?.siteUrl || SUPABASE_CONFIG.siteUrl || cfg.siteUrl || '')
  };
}

function runtimeSettings() {
  const cfg = window.TAINT_SUPABASE_CONFIG || {};
  const envName = SUPABASE_CONFIG.environment || cfg.environment || 'dev';
  const envCfg = (cfg.environments && cfg.environments[envName]) || {};
  return { cfg, envName, envCfg };
}

function isTaintAdminOwner(user=currentUser) {
  if (!user || user.provider !== 'supabase') return false;
  const settings = authSettings();
  const ownerEmails = Array.isArray(settings.adminOwnerEmails)
    ? settings.adminOwnerEmails.map(normalizeAuthEmail).filter(Boolean)
    : [];
  const ownerIds = Array.isArray(settings.adminOwnerUserIds)
    ? settings.adminOwnerUserIds.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  return ownerIds.includes(String(user.id || '').trim()) || ownerEmails.includes(normalizeAuthEmail(user.email));
}

function authRedirectTo() {
  const configured = cleanAuthUrl(authSettings().siteUrl || window.TAINT_SUPABASE_CONFIG?.siteUrl || '');
  if (configured) return configured;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

function cleanAuthUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function authUrlParams() {
  const search = new URLSearchParams(location.search || '');
  const hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  return { search, hash };
}

function authUrlError() {
  const { search, hash } = authUrlParams();
  const code = search.get('error') || hash.get('error') || search.get('error_code') || hash.get('error_code');
  if (!code) return '';
  const desc = search.get('error_description') || hash.get('error_description') || search.get('msg') || hash.get('msg') || '';
  const combined = `${code} ${desc}`;
  if (/access_denied|otp_expired|expired|invalid/i.test(combined)) {
    return 'This email link is expired, already used, or blocked by the Supabase redirect settings. Request a fresh reset link from this app.';
  }
  return desc || 'Supabase could not complete this email link. Request a fresh reset link from this app.';
}

function enabledOAuthProviders() {
  const providers = authSettings().oauthProviders;
  return Array.isArray(providers) ? providers.map(p => String(p).toLowerCase()) : [];
}

function isOAuthProviderEnabled(provider) {
  return enabledOAuthProviders().includes(String(provider).toLowerCase());
}

function isEnterpriseSsoEnabled() {
  return authSettings().enterpriseSso === true;
}

function updateRuntimeUI() {
  const { envName, envCfg } = runtimeSettings();
  const envLabel = envCfg.label || SUPABASE_CONFIG.label || envName;
  const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  setText('adminEnvName', envName);
  setText('adminEnvProject', `${envLabel} Supabase`);
  setText('adminEnvSite', authRedirectTo() || 'No redirect URL configured');
}

function syncAdminVisibility() {
  const allowed = isTaintAdminOwner();
  document.querySelectorAll('[data-mode="admin"], [data-admin-only="true"]').forEach(el => {
    el.hidden = !allowed;
    el.disabled = !allowed;
    el.setAttribute('aria-hidden', allowed ? 'false' : 'true');
  });
  const state = document.getElementById('adminAccessState');
  if (state) state.textContent = allowed ? 'Supabase owner' : 'Owner only';
  updateRuntimeUI();
  const adminSection = document.getElementById('adminSection');
  const adminVisible = !!adminSection && adminSection.style.display !== 'none';
  if (!allowed && adminVisible && typeof setMode === 'function') setMode('commute');
  return allowed;
}

function providerLabel(provider) {
  return provider === 'github' ? 'GitHub' : provider === 'google' ? 'Google' : provider;
}

function authFriendlyError(error, provider) {
  const msg = error?.message || String(error || 'Authentication failed.');
  if (/unsupported provider|provider.*not enabled/i.test(msg)) {
    return `${providerLabel(provider)} sign-in is not enabled in Supabase. Use email/password, continue as guest, or enable the provider in Supabase Authentication → Providers.`;
  }
  if (/email.*provider|provider.*email|email.*disabled|email.*not enabled|smtp/i.test(msg)) {
    return 'Email/password authentication is not fully enabled in Supabase. Enable Email in Authentication -> Providers and configure SMTP before production.';
  }
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/email.*not confirmed|confirm.*email/i.test(msg)) return 'Please confirm your email, then sign in.';
  if (/signup|signups.*disabled|disabled/i.test(msg)) return 'Email sign-up is disabled in Supabase. Enable Email in Authentication → Providers, or continue in guest mode.';
  return msg;
}

function isPasswordRecoveryUrl() {
  const { search, hash } = authUrlParams();
  return search.get('type') === 'recovery' || hash.get('type') === 'recovery';
}

function clearAuthUrlTokens() {
  if (!history.replaceState || (location.protocol !== 'http:' && location.protocol !== 'https:')) return;
  history.replaceState(null, document.title, location.pathname);
}

function updateAuthProviderUI() {
  const google = document.getElementById('authGoogle');
  const github = document.getElementById('authGithub');
  const ssoRow = document.querySelector('.auth-sso-row');
  const note = document.getElementById('authProviderNote');
  const googleOn = !!supabaseClient && isOAuthProviderEnabled('google');
  const githubOn = !!supabaseClient && isOAuthProviderEnabled('github');
  const ssoOn = !!supabaseClient && isEnterpriseSsoEnabled();
  const allowProviders = authMode === 'signin' || authMode === 'signup';
  if (google) google.hidden = !allowProviders || !googleOn;
  if (github) github.hidden = !allowProviders || !githubOn;
  if (ssoRow) ssoRow.hidden = !allowProviders || !ssoOn;
  if (note) {
    const hosted = authRedirectTo();
    if (!allowProviders) {
      note.hidden = true;
    } else if (!supabaseClient) {
      note.textContent = 'Cloud sign-in is not configured. Email sign-up will use this device only.';
      note.hidden = false;
    } else if (!hosted) {
      note.textContent = 'Social sign-in needs an http(s) hosted URL. Email/password can still be used here.';
      note.hidden = false;
    } else if (!googleOn && !githubOn && !ssoOn) {
      note.textContent = 'Social sign-in is hidden until providers are enabled in supabase-config.js and Supabase Authentication → Providers.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }
}

async function hashPwd(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt:enc.encode(salt), iterations:100000, hash:'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
const LOCAL_USERS_KEY   = 'taint_users_v1';
const LOCAL_SESSION_KEY = 'taint_session_v1';
const AUTH_SKIP_COOKIE  = 'taint_skip_auth';
const COOKIE_ACK_COOKIE = 'taint_cookie_ack';

function cookieSecureSuffix() {
  return location.protocol === 'https:' ? '; Secure' : '';
}
function setFirstPartyCookie(name, value, days=180) {
  const maxAge = Math.max(0, Math.round(days * 86400));
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${cookieSecureSuffix()}`;
}
function getFirstPartyCookie(name) {
  const key = encodeURIComponent(name) + '=';
  return document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(key))?.slice(key.length) || '';
}
function deleteFirstPartyCookie(name) {
  document.cookie = `${encodeURIComponent(name)}=; Max-Age=0; Path=/; SameSite=Lax${cookieSecureSuffix()}`;
}
function rememberAuthSkip(value) {
  try {
    if (value) {
      setFirstPartyCookie(AUTH_SKIP_COOKIE, '1');
      localStorage.setItem(AUTH_SKIP_COOKIE, '1');
    } else {
      deleteFirstPartyCookie(AUTH_SKIP_COOKIE);
      localStorage.removeItem(AUTH_SKIP_COOKIE);
    }
  } catch (e) {
    console.warn('TAINT auth preference update skipped:', e.message);
  }
}
function hasAuthSkip() {
  try {
    return getFirstPartyCookie(AUTH_SKIP_COOKIE) === '1' || localStorage.getItem(AUTH_SKIP_COOKIE) === '1';
  } catch {
    return false;
  }
}
function hasCookieAck() {
  try {
    return getFirstPartyCookie(COOKIE_ACK_COOKIE) === '1' || localStorage.getItem(COOKIE_ACK_COOKIE) === '1';
  } catch {
    return false;
  }
}
function setCookieAck(value=true) {
  try {
    if (value) {
      setFirstPartyCookie(COOKIE_ACK_COOKIE, '1', 365);
      localStorage.setItem(COOKIE_ACK_COOKIE, '1');
    } else {
      deleteFirstPartyCookie(COOKIE_ACK_COOKIE);
      localStorage.removeItem(COOKIE_ACK_COOKIE);
    }
  } catch {}
}
function syncCookieConsent() {
  const banner = document.getElementById('cookieConsent');
  if (!banner) return;
  banner.classList.toggle('hidden', hasCookieAck());
}
function userInitials(user) {
  if (!user) return 'GU';
  const source = (user.email || user.name || '').replace(/[^a-z0-9]/ig, '');
  return (source.slice(0, 2) || '?').toUpperCase();
}
function hideLoadingOverlay() {
  document.getElementById('loadingOverlay')?.classList.add('hidden');
}
window.addEventListener('load', () => setTimeout(hideLoadingOverlay, 450), { once:true });
setTimeout(hideLoadingOverlay, 2500);

async function localSignUp(name, email, password) {
  let users = [];
  try { users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '[]'); } catch {}
  if (users.find(u => u.email === email.toLowerCase()))
    throw new Error('Email already registered on this device.');
  const salt = crypto.randomUUID();
  const hash = await hashPwd(password, salt);
  const user = { id:'local_'+Date.now(), name, email:email.toLowerCase(), hash, salt };
  users.push(user);
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({id:user.id,name,email:user.email}));
  return user;
}
async function localSignIn(email, password) {
  let users = [];
  try { users = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '[]'); } catch {}
  const candidate = users.find(u => u.email===email.toLowerCase());
  if (!candidate) throw new Error('Incorrect email or password.');
  let valid = false;
  if (candidate.hash && candidate.salt) {
    valid = (await hashPwd(password, candidate.salt)) === candidate.hash;
  } else if (candidate.pwd) {
    valid = candidate.pwd === btoa(password);
    if (valid) {
      const salt = crypto.randomUUID();
      const hash = await hashPwd(password, salt);
      const nextUsers = JSON.parse(localStorage.getItem(LOCAL_USERS_KEY) || '[]');
      const idx = nextUsers.findIndex(u => u.email===email.toLowerCase());
      if (idx > -1) { nextUsers[idx].hash = hash; nextUsers[idx].salt = salt; delete nextUsers[idx].pwd; }
      try { localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(nextUsers)); } catch {}
    }
  }
  const user = valid ? candidate : null;
  if (!user) throw new Error('Incorrect email or password.');
  localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({id:user.id,name:user.name,email:user.email}));
  return user;
}
function localSignOut()   { localStorage.removeItem(LOCAL_SESSION_KEY); }
function localGetSession(){ try{return JSON.parse(localStorage.getItem(LOCAL_SESSION_KEY));}catch{return null;} }
function normalizeAuthEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function authSignUp(name, email, password) {
  if (supabaseClient) {
    const options = { data:{ name, username:name, acknowledgement:'Account created. Password is never sent by email.' } };
    const redirectTo = authRedirectTo();
    if (redirectTo) options.emailRedirectTo = redirectTo;
    const {data,error} = await supabaseClient.auth.signUp({
      email,
      password,
      options
    });
    if (error) throw new Error(authFriendlyError(error, 'email'));
    if (!data.user) throw new Error('Supabase did not create the account. Check Email provider/sign-up settings, or sign in if this email already exists.');
    const pendingConfirmation = !data.session;
    if (pendingConfirmation) notify('Check your email to confirm the account before signing in.', 'success', 'Account created');
    return {id:data.user?.id,name,email,provider:'supabase',pendingConfirmation};
  }
  return {...(await localSignUp(name,email,password)),provider:'local'};
}
async function authSignIn(email, password) {
  if (supabaseClient) {
    const {data,error} = await supabaseClient.auth.signInWithPassword({email,password});
    if (error) throw new Error(authFriendlyError(error, 'email'));
    const u=data.user;
    return {id:u.id,name:u.user_metadata?.name||email.split('@')[0],email:u.email,provider:'supabase'};
  }
  return {...(await localSignIn(email,password)),provider:'local'};
}
async function authSendPasswordReset(email) {
  if (!supabaseClient) throw new Error('Password reset email needs Supabase configured. Local-only accounts are stored on this device.');
  const normalizedEmail = normalizeAuthEmail(email);
  const redirectTo = authRedirectTo();
  if (!redirectTo) throw new Error('Password reset needs a configured https redirect URL in supabase-config.js.');
  if (authResetInFlightEmail === normalizedEmail) throw new Error('A reset link is already being sent for this email. Please wait a moment.');
  const elapsed = Date.now() - authLastResetRequest.at;
  if (authLastResetRequest.email === normalizedEmail && elapsed < AUTH_RESET_COOLDOWN_MS) {
    const wait = Math.ceil((AUTH_RESET_COOLDOWN_MS - elapsed) / 1000);
    throw new Error(`A reset link was just sent. Please wait ${wait}s before requesting another one.`);
  }
  authResetInFlightEmail = normalizedEmail;
  try {
    const exists = await authAccountExistsForReset(normalizedEmail);
    if (!exists) throw new Error('No TAINT account was found for this email. Please sign up first.');
    const { error } = await supabaseClient.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
    if (error) throw new Error(authFriendlyError(error, 'email'));
    authLastResetRequest = { email: normalizedEmail, at: Date.now() };
    return true;
  } finally {
    authResetInFlightEmail = '';
  }
}
async function authAccountExistsForReset(email) {
  if (authSettings().validateResetEmail === false) return true;
  const checked = validateEmailValue(email);
  if (!checked.ok) return false;
  try {
    const res = await appFetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/taint_account_email_exists`, {
      method : 'POST',
      headers: await SB_AUTH_HEADERS(),
      body   : JSON.stringify({ p_email: checked.value })
    }, { label:'account validation', timeout:9000, retries:1 });
    const data = await res.json();
    return data === true;
  } catch (error) {
    console.warn('TAINT reset email validation failed:', error.message || error);
    throw new Error('Account validation is not available yet. Run the latest Supabase schema migration, then try again.');
  }
}
async function authUpdateRecoveredPassword(password) {
  if (!supabaseClient) throw new Error('Password update needs Supabase configured.');
  const { data, error } = await supabaseClient.auth.updateUser({ password });
  if (error) throw new Error(authFriendlyError(error, 'email'));
  const u = data.user;
  if (u) currentUser = { id:u.id, name:u.user_metadata?.name || u.email.split('@')[0], email:u.email, provider:'supabase' };
  return currentUser;
}
async function authSignInGoogle() {
  return authSignInOAuth('google');
}
async function authSignInOAuth(provider) {
  if (!supabaseClient) { showAuthError('Cloud sign-in needs Supabase configured. Use email or continue as guest.'); return; }
  if (!isOAuthProviderEnabled(provider)) { showAuthError(`${providerLabel(provider)} sign-in is not enabled for this app. Use email/password or continue as guest.`); return; }
  const redirectTo = authRedirectTo();
  if (!redirectTo) { showAuthError('Social sign-in needs the app hosted on http(s). Use email/password locally or continue as guest.'); return; }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider,
    options:{ redirectTo }
  });
  if (error) showAuthError(authFriendlyError(error, provider));
}
async function authSignInSSO(domain) {
  if (!supabaseClient) { showAuthError('Enterprise SSO needs Supabase configured.'); return; }
  if (!isEnterpriseSsoEnabled()) { showAuthError('Enterprise SSO is not enabled for this app. Use email/password or continue as guest.'); return; }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain || '')) { showAuthError('Enter your company domain, e.g. company.com.'); return; }
  const redirectTo = authRedirectTo();
  if (!redirectTo) { showAuthError('Enterprise SSO needs the app hosted on http(s).'); return; }
  const { error } = await supabaseClient.auth.signInWithSSO({
    domain,
    options:{ redirectTo }
  });
  if (error) showAuthError(authFriendlyError(error, 'SSO'));
}
async function authSignOut() {
  try {
    if (supabaseClient) await supabaseClient.auth.signOut();
  } catch (e) {
    console.warn('TAINT Supabase sign-out skipped:', e.message);
  }
  localSignOut(); currentUser=null; updateAuthUI(null);
  notify('Signed out.', 'success', 'Account');
}
async function restoreSession() {
  if (supabaseClient) {
    const {data} = await supabaseClient.auth.getSession();
    if (data.session?.user) {
      const u=data.session.user;
      currentUser={id:u.id,name:u.user_metadata?.name||u.email.split('@')[0],email:u.email,provider:'supabase'};
      return true;
    }
  }
  const local=localGetSession();
  if (local) { currentUser={...local,provider:'local'}; return true; }
  return false;
}

function updateAuthUI(user) {
  const initial = userInitials(user);
  const name    = user ? (user.name||user.email.split('@')[0]) : 'Guest';
  const email   = user ? user.email : 'Not signed in';
  const provider= user ? `${user.provider || 'local'} account` : 'Guest mode';
  const isGuest = !user;

  const ab=document.getElementById('userAvatarBtn'),al=document.getElementById('userAvatarInitial');
  if(ab&&al){ al.textContent=initial; ab.classList.toggle('signed-in',!isGuest); ab.title=isGuest?'Sign in':'Signed in as '+name; }

  const sbAv=document.getElementById('sbAvatar'),sbNm=document.getElementById('sbUserName'),sbAct=document.getElementById('sbUserAction');
  if(sbAv)  sbAv.textContent=initial;
  if(sbNm)  sbNm.textContent=name;
  if(sbAct){ sbAct.textContent=isGuest?'Sign In / Sign Up':'Sign Out'; sbAct.onclick=isGuest?showAuthOverlay:authSignOut; }

  const mn=document.getElementById('accountMenuName'),me=document.getElementById('accountMenuEmail'),mp=document.getElementById('accountMenuProvider');
  const details=document.getElementById('accountDetailsBtn'),logout=document.getElementById('accountLogoutBtn');
  if(mn) mn.textContent=name;
  if(me) me.textContent=email;
  if(mp) mp.textContent=provider;
  if(details){ details.textContent=isGuest?'Sign in to view details':'Account details'; details.disabled=false; }
  if(logout){ logout.textContent=isGuest?'Sign In / Sign Up':'Logout'; }
  syncAdminVisibility();
  refreshAllRecentCalculations();
}

function setAccountMenu(open) {
  const menu=document.getElementById('accountMenu'),btn=document.getElementById('accountMenuBtn');
  if(menu) menu.classList.toggle('open', !!open);
  if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function toggleAccountMenu() {
  setAccountMenu(!document.getElementById('accountMenu')?.classList.contains('open'));
}

function showAuthOverlay(mode){
  const requestedMode = typeof mode === 'string' ? mode : (authMode || 'signin');
  setAuthMode(requestedMode);
  updateAuthProviderUI();
  document.getElementById('authOverlay').classList.remove('hidden');
}
function hideAuthOverlay(){ document.getElementById('authOverlay').classList.add('hidden'); }
function showAuthError(msg){ const e=document.getElementById('authError'); if(e) e.textContent=msg; }
function showAuthSuccess(msg){
  const e=document.getElementById('authSuccess');
  if(!e) return;
  e.textContent = msg || '';
  e.hidden = !msg;
}

let authMode='signin';
let authRecoveryMode=false;
function authSubmitText(mode=authMode) {
  if (mode === 'signup') return 'Create Account';
  if (mode === 'forgot') return 'Send Reset Link';
  if (mode === 'reset') return 'Update Password';
  return 'Sign In';
}
function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';
  const isReset  = mode === 'reset';
  document.querySelectorAll('.auth-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === mode));
  const emailField = document.getElementById('authEmailField');
  const nameField  = document.getElementById('authNameField');
  const passField  = document.getElementById('authPasswordField');
  const confirm    = document.getElementById('authConfirmPasswordField');
  const passInput  = document.getElementById('authPassword');
  const confirmInput = document.getElementById('authConfirmPassword');
  const passLabel  = document.getElementById('authPasswordLabel');
  const submit     = document.getElementById('authSubmit');
  const forgot     = document.getElementById('authForgotBtn');
  const back       = document.getElementById('authBackToSignInBtn');
  const or         = document.querySelector('.auth-or');
  if (emailField) emailField.style.display = isReset ? 'none' : '';
  if (nameField)  nameField.style.display  = isSignup ? '' : 'none';
  if (passField)  passField.style.display  = isForgot ? 'none' : '';
  if (confirm)    confirm.style.display    = isReset ? '' : 'none';
  if (passInput) {
    passInput.autocomplete = (isSignup || isReset) ? 'new-password' : 'current-password';
    passInput.placeholder  = isReset ? 'Upper/lower/number/symbol, 8-72 chars' : isSignup ? 'Upper/lower/number/symbol, 8-72 chars' : 'Your password';
  }
  if (passLabel) passLabel.textContent = isReset ? 'New password' : 'Password';
  if (confirmInput && !isReset) confirmInput.value = '';
  if (submit) submit.textContent = authSubmitText(mode);
  if (forgot) forgot.hidden = mode !== 'signin';
  if (back) back.hidden = mode === 'signin' || mode === 'signup';
  if (or) or.style.display = (mode === 'signin' || mode === 'signup') ? '' : 'none';
  updateAuthProviderUI();
  showAuthError('');
  showAuthSuccess('');
}
document.querySelectorAll('.auth-tab').forEach(tab=>{
  tab.addEventListener('click',()=> setAuthMode(tab.dataset.tab));
});

function validateAuthForm(mode, { name='', email='', password='', confirmPassword='' }={}) {
  const emailCheck = mode === 'reset' ? { ok:true, value:email } : validateEmailValue(email);
  if (!emailCheck.ok) {
    setFieldInvalid(document.getElementById('authEmail'), emailCheck.message);
    showAuthError(emailCheck.message);
    notify(emailCheck.message, 'warn', 'Account');
    return null;
  }
  const normalizedEmail = emailCheck.value;
  if (mode === 'forgot') return { email:normalizedEmail };

  const username = mode === 'signup' ? validateUsernameValue(name) : { ok:true, value:name };
  if (!username.ok) {
    setFieldInvalid(document.getElementById('authName'), username.message);
    showAuthError(username.message);
    notify(username.message, 'warn', 'Account');
    return null;
  }

  const passwordCheck = validatePasswordValue(password, {
    strong: mode === 'signup' || mode === 'reset',
    label : mode === 'reset' ? 'New password' : 'Password'
  });
  if (!passwordCheck.ok) {
    setFieldInvalid(document.getElementById('authPassword'), passwordCheck.message);
    showAuthError(passwordCheck.message);
    notify(passwordCheck.message, 'warn', 'Account');
    return null;
  }
  if (mode === 'reset' && password !== confirmPassword) {
    const message = 'Passwords do not match.';
    setFieldInvalid(document.getElementById('authConfirmPassword'), message);
    showAuthError(message);
    notify(message, 'warn', 'Account');
    return null;
  }
  return { name:username.value, email:normalizedEmail, password };
}

document.addEventListener('click', async e => {
  if (e.target?.id !== 'authSubmit') return;
  const email=document.getElementById('authEmail').value.trim();
  const pass =document.getElementById('authPassword').value;
  const confirmPass=document.getElementById('authConfirmPassword')?.value || '';
  const name =document.getElementById('authName').value.trim()||email.split('@')[0];
  const btn  =document.getElementById('authSubmit');
  if (!btn || btn.disabled) return;
  setFieldInvalid(document.getElementById('authEmail'), '');
  setFieldInvalid(document.getElementById('authPassword'), '');
  setFieldInvalid(document.getElementById('authConfirmPassword'), '');
  setFieldInvalid(document.getElementById('authName'), '');
  showAuthError(''); showAuthSuccess('');

  if (authMode === 'forgot') {
    const checked = validateAuthForm('forgot', { email });
    if (!checked) return;
    btn.disabled=true; btn.textContent='Sending…';
    try {
      await authSendPasswordReset(checked.email);
      showAuthSuccess(`A secure password reset email has been sent to ${checked.email}. Follow the link, then create a new password here.`);
      notify('Password reset email sent.', 'success', 'Account');
    } catch(err){ showAuthError(err.message); }
    finally{ btn.disabled=false; btn.textContent=authSubmitText(); }
    return;
  }

  if (authMode === 'reset') {
    const checked = validateAuthForm('reset', { password:pass, confirmPassword:confirmPass });
    if (!checked) return;
    btn.disabled=true; btn.textContent='Updating…';
    try {
      await authUpdateRecoveredPassword(checked.password);
      authRecoveryMode = false;
      clearAuthUrlTokens();
      rememberAuthSkip(false);
      await sbUpsertProfile(currentUser);
      updateAuthUI(currentUser);
      hideAuthOverlay();
      notify('Password updated. You are signed in.', 'success', 'Account');
    } catch(err){ showAuthError(err.message); }
    finally{ btn.disabled=false; btn.textContent=authSubmitText(); }
    return;
  }

  const checked = validateAuthForm(authMode, { name, email, password:pass });
  if (!checked) return;
  btn.disabled=true; btn.textContent=authMode==='signup'?'Creating…':'Signing in…';
  try {
    currentUser=authMode==='signup'?await authSignUp(checked.name,checked.email,checked.password):await authSignIn(checked.email,checked.password);
    if (currentUser?.pendingConfirmation) {
      currentUser = null;
      updateAuthUI(null);
      showAuthSuccess(`Acknowledgement sent to ${checked.email}. Check your email to confirm the account, then sign in. Your password is never emailed.`);
      return;
    }
    rememberAuthSkip(false);
    await sbUpsertProfile(currentUser);
    updateAuthUI(currentUser); hideAuthOverlay();
    notify(authMode==='signup' ? 'Account ready. Password was stored securely, not emailed.' : 'Signed in successfully.', 'success', 'Account');
  } catch(err){ showAuthError(err.message); }
  finally{ btn.disabled=false; btn.textContent=authSubmitText(); }
});

document.addEventListener('click', e => {
  if (e.target?.id === 'authGoogle') authSignInGoogle();
  if (e.target?.id === 'authGithub') authSignInOAuth('github');
  if (e.target?.id === 'authSsoBtn') authSignInSSO(document.getElementById('authSsoDomain')?.value?.trim());
  if (e.target?.id === 'authForgotBtn') {
    setAuthMode('forgot');
    showAuthSuccess('Enter your email and TAINT will send a secure reset link. Passwords are never emailed.');
  }
  if (e.target?.id === 'authBackToSignInBtn') setAuthMode('signin');
});

document.addEventListener('click', e => {
  if (e.target?.id !== 'authSkip') return;
  hideAuthOverlay(); currentUser=null; updateAuthUI(null);
  rememberAuthSkip(true);
  notify('Continuing in guest mode. Preference saved with a first-party SameSite cookie.', 'success', 'Account');
});

document.addEventListener('click', e => {
  if (e.target?.id !== 'cookieClearBtn') return;
  rememberAuthSkip(false);
  setCookieAck(false);
  syncCookieConsent();
  notify('TAINT guest preference cookie cleared.', 'success', 'Cookies');
});

document.addEventListener('click', e => {
  if (e.target?.id !== 'cookieAcceptBtn') return;
  setCookieAck(true);
  syncCookieConsent();
  notify('Cookie preference saved.', 'success', 'Cookies');
});

document.addEventListener('click', e => {
  if (!e.target?.closest?.('#userAvatarBtn')) return;
  if(!currentUser) showAuthOverlay();
  else toggleAccountMenu();
});

document.addEventListener('click', e => {
  if (e.target?.closest?.('#accountMenuBtn')) {
    toggleAccountMenu();
    return;
  }
  if (!e.target?.closest?.('.account-controls')) setAccountMenu(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') setAccountMenu(false);
});
document.addEventListener('click', async e => {
  if (e.target?.id === 'accountLogoutBtn') {
    setAccountMenu(false);
    if (!currentUser) showAuthOverlay();
    else await authSignOut();
  }
  if (e.target?.id === 'accountDetailsBtn') {
    if (!currentUser) { setAccountMenu(false); showAuthOverlay(); return; }
    notify(`${currentUser.email} · ${currentUser.provider || 'local'} account`, 'success', 'Account details');
  }
});

if(supabaseClient){
  supabaseClient.auth.onAuthStateChange((event,session)=>{
    if(session?.user){
      const u=session.user;
      currentUser={id:u.id,name:u.user_metadata?.name||u.email.split('@')[0],email:u.email,provider:'supabase'};
      if (event === 'PASSWORD_RECOVERY' || isPasswordRecoveryUrl()) {
        authRecoveryMode = true;
        updateAuthUI(currentUser);
        showAuthOverlay('reset');
        showAuthSuccess('Email verified. Create a new password to finish resetting your account.');
        return;
      }
      if (authRecoveryMode || authMode === 'reset') return;
      sbUpsertProfile(currentUser);
      updateAuthUI(currentUser); hideAuthOverlay();
    }
  });
}

async function initAuth(){
  updateAuthProviderUI();
  const linkError = supabaseClient ? authUrlError() : '';
  if (linkError) {
    updateAuthUI(currentUser);
    showAuthOverlay('forgot');
    showAuthError(linkError);
    clearAuthUrlTokens();
    return;
  }
  const skipped   = hasAuthSkip();
  const hasSession= await restoreSession();
  if (supabaseClient && isPasswordRecoveryUrl()) {
    authRecoveryMode = true;
    if (currentUser) updateAuthUI(currentUser);
    showAuthOverlay('reset');
    showAuthSuccess('Create a new password to finish resetting your account.');
    return;
  }
  if(hasSession){ sbUpsertProfile(currentUser); updateAuthUI(currentUser); hideAuthOverlay(); }
  else if(skipped){ updateAuthUI(null); hideAuthOverlay(); }
  else { updateAuthUI(null); setTimeout(showAuthOverlay,700); }
}

// ──────────────────────────────────────────────────────
//  MODE TOGGLE — Commute ↔ Workplace
// ──────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────
//  WORKPLACE CARBON CALCULATOR
// ──────────────────────────────────────────────────────

/* Emission factors */
const WP_EF = {
  // Energy
  gridKgPerKwh   : 0.716,   // India CEA 2023 (kg CO₂/kWh)
  dieselKgPerL   : 2.68,    // Diesel generator (kg CO₂/litre)
  lpgKgPerKg     : 1.56,    // LPG combustion (kg CO₂/kg fuel)
  // AC: COP ≈ 3.0; 1 ton cooling = 3.517 kW; runtime power = 3.517/3.0 = 1.17 kW/ton
  acKwPerTon     : 1.17,
  // Devices (W, active)
  laptopW        : 50,
  desktopW       : 200,
  monitorW       : 30,
  serverKwFactor : 1.0,     // user-supplied kW
  printerKgPerPage: 0.000018, // lifecycle + toner per page (tCO₂/page from SWD)
  // Travel
  flightDomKgPerPax_km  : 0.255,  // ICAO domestic
  flightIntlKgPerPax_km : 0.195,  // ICAO international economy
  trainKgPerKm   : 0.047,  // Indian Railways per pax-km
  carKgPerKm     : 0.140,  // intercity road avg
  // Commute modes (kg CO₂/km per person)
  commuteCarKg   : 0.063,  // two-wheeler / car city
  commuteBusKg   : 0.028,  // MTC bus per pax
  commuteMetroKg : 0.035,  // Chennai Metro per pax
  commuteAutoKg  : 0.082,  // share auto per pax
  // Resources
  paperKgPerRiem : 4.4,    // 500-sheet ream lifecycle
  waterKgPerM3   : 0.344,  // treatment energy
  wasteKgPerKg   : 0.5,    // landfill emission factor
  mealKgEach     : 0.8,    // avg Indian office meal
  // WFH home setup (W during work hours)
  wfhLaptopW     : 50,
  wfhLaptopMonW  : 80,
  wfhDesktopW    : 200,
  wfhAcW         : 1200,   // 1 ton split AC actual power
};

/* Industry benchmarks — t CO₂e per employee per year */
const WP_BENCH = {
  it          : { val: 2.5,  label: 'IT / Tech' },
  finance     : { val: 3.5,  label: 'Finance' },
  healthcare  : { val: 4.5,  label: 'Healthcare' },
  retail      : { val: 2.0,  label: 'Retail' },
  manufacturing:{ val: 8.0,  label: 'Manufacturing' },
  education   : { val: 1.8,  label: 'Education' },
  hospitality : { val: 5.0,  label: 'Hospitality' },
  other       : { val: 3.0,  label: 'General office' },
};

/* Donut chart colours per category */
const WP_COLORS = ['#34d399','#60a5fa','#f59e0b','#a78bfa','#fb923c','#f472b6','#4ade80','#38bdf8'];

function wpV(id) { return parseFloat(document.getElementById(id)?.value || 0) || 0; }
function wpS(id) { return document.getElementById(id)?.value || ''; }

/* Live mode-split sum validation */
function wpUpdateSplitSum() {
  const sum = ['Car','Bus','Metro','Auto'].reduce((a,k)=>a+wpV('wpSplit'+k),0);
  const el  = document.getElementById('wpSplitSum');
  const ok  = document.getElementById('wpSplitOk');
  if (el) el.textContent = sum;
  if (ok) { ok.textContent = sum===100?'✓':'✗ must equal 100'; ok.className='wp-split-ok'+(sum!==100?' warn':''); }
}
['wpSplitCar','wpSplitBus','wpSplitMetro','wpSplitAuto'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', wpUpdateSplitSum));

function calculateWorkplace() {
  const employees  = Math.max(1, wpV('wpEmployees'));
  const days       = Math.max(1, wpV('wpDays'));
  const sector     = wpS('wpSector');
  const occ        = wpV('wpOccupancy') / 100;

  const gridIntensity = city().grid; // kg CO₂/kWh — state-specific CEA 2023
  /* ── SCOPE 2: Electricity ── */
  const elecKwh    = wpV('wpElecKwh') * 12;
  const solarPct   = wpV('wpSolar') / 100;
  const gridKwh    = elecKwh * (1 - solarPct);
  const acKwh      = wpV('wpAcUnits') * wpV('wpAcTons') * WP_EF.acKwPerTon * wpV('wpAcHours') * days;
  const s2_elec    = (gridKwh + acKwh) * gridIntensity / 1000;

  /* ── SCOPE 1: Direct ── */
  const s1_diesel  = wpV('wpDiesel') * 12 * WP_EF.dieselKgPerL / 1000;
  const s1_lpg     = wpV('wpLpg')    * 12 * WP_EF.lpgKgPerKg   / 1000;
  const s1         = s1_diesel + s1_lpg;

  /* ── SCOPE 3 ── */
  // Devices
  const devLaptopKwh  = wpV('wpLaptops')  * WP_EF.laptopW  /1000 * wpV('wpLaptopHrs')  * days;
  const devDeskKwh    = wpV('wpDesktops') * WP_EF.desktopW /1000 * wpV('wpDesktopHrs') * days;
  const devMonKwh     = wpV('wpMonitors') * WP_EF.monitorW /1000 * 8 * days;
  const devServerKwh  = wpV('wpServerKw') * 24 * 365;
  const devPrintKg    = wpV('wpPrintPages') * 12 * WP_EF.printerKgPerPage * 1000;
  const s3_devices    = (devLaptopKwh+devDeskKwh+devMonKwh+devServerKwh) * gridIntensity/1000 + devPrintKg/1000;

  // Business travel
  const s3_domFlight  = wpV('wpDomFlights')  * wpV('wpDomFlightKm')  * 2 * WP_EF.flightDomKgPerPax_km  / 1000;
  const s3_intlFlight = wpV('wpIntlFlights') * wpV('wpIntlFlightKm') * 2 * WP_EF.flightIntlKgPerPax_km / 1000;
  const s3_train      = wpV('wpTrainKm')   * WP_EF.trainKgPerKm / 1000;
  const s3_road       = wpV('wpRoadKm')    * WP_EF.carKgPerKm   / 1000;
  const s3_travel     = s3_domFlight + s3_intlFlight + s3_train + s3_road;

  // WFH
  const wfhSetup      = wpS('wpHomeSetup');
  const wfhW          = wfhSetup==='laptop'?WP_EF.wfhLaptopW : wfhSetup==='desktop'?WP_EF.wfhDesktopW : WP_EF.wfhLaptopMonW;
  const wfhDaysPerYr  = wpV('wpWfhDays') * 52;
  const wfhDevKwh     = employees * wfhW/1000 * 8 * wfhDaysPerYr;
  const wfhAcKwh      = employees * WP_EF.wfhAcW/1000 * wpV('wpHomeAcHrs') * wfhDaysPerYr;
  const s3_wfh        = (wfhDevKwh + wfhAcKwh) * gridIntensity / 1000;

  // Team commute
  const commuters     = wpV('wpCommuters');
  const comKm         = wpV('wpCommuteKm') * 2 * days; // annual km per person
  const splits        = {
    car:   wpV('wpSplitCar')  /100, bus: wpV('wpSplitBus')  /100,
    metro: wpV('wpSplitMetro')/100, auto:wpV('wpSplitAuto') /100,
  };
  const comKgPer = splits.car*WP_EF.commuteCarKg + splits.bus*WP_EF.commuteBusKg
                 + splits.metro*WP_EF.commuteMetroKg + splits.auto*WP_EF.commuteAutoKg;
  const s3_commute    = commuters * comKm * comKgPer / 1000;

  // Resources
  const s3_paper  = wpV('wpPaper')  * 12 * WP_EF.paperKgPerRiem / 1000;
  const s3_water  = wpV('wpWater')  * 365 /1000 * WP_EF.waterKgPerM3 / 1000;
  const s3_waste  = wpV('wpWaste')  * 12 * WP_EF.wasteKgPerKg   / 1000;
  const s3_meals  = wpV('wpMeals')  * days * WP_EF.mealKgEach   / 1000;
  const s3_resources = s3_paper + s3_water + s3_waste + s3_meals;

  const s3 = s3_devices + s3_travel + s3_wfh + s3_commute + s3_resources;

  const total    = s1 + s2_elec + s3;
  const perEmp   = total / employees;

  /* ── Render results ── */
  const rc = document.getElementById('wpResultCard');
  rc.style.display = '';
  rc.scrollIntoView({ behavior:'smooth', block:'start' });

  document.getElementById('wpTotalVal').textContent = total.toFixed(2);
  document.getElementById('wpPerEmp').textContent   = perEmp.toFixed(2);

  /* Grade (t CO₂e per employee per year) */
  const g = perEmp<1?'A':perEmp<2?'B':perEmp<3.5?'C':perEmp<6?'D':'F';
  const grEl = document.getElementById('wpGrade');
  grEl.textContent = g; grEl.className = 'sc-grade '+g;

  /* Scope bars */
  const maxS = Math.max(s1, s2_elec, s3, 0.001);
  ['1','2','3'].forEach((n,i) => {
    const v = [s1, s2_elec, s3][i];
    document.getElementById('wpS'+n+'Val').textContent = v.toFixed(3)+' t';
    document.getElementById('wpS'+n+'Bar').style.width = (v/maxS*100).toFixed(1)+'%';
  });

  // Scope detail tags
  function tags(pairs) {
    return pairs.filter(([,v])=>v>0).map(([l,v])=>
      `<span class="wp-scope-tag">${l}: ${v.toFixed(3)}t</span>`).join('');
  }
  document.getElementById('wpS1Detail').innerHTML = tags([['Diesel gen',s1_diesel],['LPG',s1_lpg]]);
  document.getElementById('wpS2Detail').innerHTML = tags([['Grid electricity',s2_elec]]);
  document.getElementById('wpS3Detail').innerHTML = tags([
    ['Devices',s3_devices],['Travel',s3_travel],['WFH',s3_wfh],
    ['Team commute',s3_commute],['Resources',s3_resources]]);

  /* Donut chart */
  const cats = [
    { name:'⚡ Electricity',    val: s2_elec,      },
    { name:'💻 Devices',        val: s3_devices,   },
    { name:'🚌 Team commute',   val: s3_commute,   },
    { name:'✈️ Travel',          val: s3_travel,    },
    { name:'🏠 Remote work',    val: s3_wfh,       },
    { name:'🗑️ Resources',       val: s3_resources, },
    { name:'🔥 Direct (S1)',     val: s1,           },
  ].filter(c=>c.val>0).sort((a,b)=>b.val-a.val);

  const donut = document.getElementById('wpDonut');
  const R=48, CX=60, CY=60, CIRC=2*Math.PI*R;
  let offset=0;
  let arcs = '';
  cats.forEach((c,i)=>{
    const pct = c.val/total;
    const dash = pct*CIRC;
    arcs += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none"
      stroke="${WP_COLORS[i%WP_COLORS.length]}" stroke-width="18"
      stroke-dasharray="${dash.toFixed(2)} ${(CIRC-dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${CX} ${CY})"/>`;
    c.color = WP_COLORS[i%WP_COLORS.length];
    offset += dash;
  });
  donut.innerHTML = `<circle cx="60" cy="60" r="48" fill="none" stroke="var(--bd2)" stroke-width="18"/>${arcs}`;

  const cl = document.getElementById('wpCatList');
  cl.innerHTML = cats.map(c=>`
    <div class="wp-cat-row">
      <span class="wp-cat-dot" style="background:${c.color}"></span>
      <span class="wp-cat-name">${c.name}</span>
      <span class="wp-cat-pct">${(c.val/total*100).toFixed(0)}%</span>
      <span class="wp-cat-val">${c.val.toFixed(3)}t</span>
    </div>`).join('');

  /* Benchmark */
  const bench = WP_BENCH[sector] || WP_BENCH.other;
  const bPct  = Math.min(100, perEmp / (bench.val*1.5) * 100);
  const bYours= Math.min(100, perEmp / (bench.val*1.5) * 100);
  document.getElementById('wpBenchmark').innerHTML = `
    <b>Industry benchmark (${bench.label})</b>: ${bench.val} t CO₂e/employee/year<br>
    Your office: <b>${perEmp.toFixed(2)} t</b> — ${perEmp<bench.val?
      `<span style="color:var(--green)">✓ ${((1-perEmp/bench.val)*100).toFixed(0)}% below benchmark</span>`:
      `<span style="color:var(--amber)">⚠ ${((perEmp/bench.val-1)*100).toFixed(0)}% above benchmark</span>`}
    <div class="wp-bm-bar-wrap">
      <div class="wp-bm-your" style="width:${bYours.toFixed(1)}%;background:${perEmp<bench.val?'var(--green)':'var(--amber)'}"></div>
    </div>
    <span style="font-size:10.5px;color:var(--hi)">▲ benchmark at ${(bench.val/(bench.val*1.5)*100).toFixed(0)}%</span>`;

  /* Tips — sorted by reduction potential */
  const tips = [
    { cond: solarPct<0.3,             pct: Math.round(s2_elec/total*25),  tip: 'Install rooftop solar — 25 kW covers ~30 employees. Pays back in 4–5 years in Chennai.' },
    { cond: wpV('wpAcHours')>8,       pct: 8,                              tip: 'Set AC to 24°C (not 18°C) and use inverter units. Every 1°C higher saves ~6% AC energy.' },
    { cond: s3_commute/total>0.2,     pct: Math.round(s3_commute/total*30),tip: 'Subsidise metro / bus passes. Shifting 30% of car commuters to Metro cuts Scope 3 by ~15%.' },
    { cond: s3_wfh/total>0.05,        pct: Math.round(s3_wfh/total*40),   tip: 'Equip WFH staff with energy-efficient laptops and LED lighting. Home AC is the biggest WFH emission.' },
    { cond: wpV('wpDesktops')>0,      pct: 12,                             tip: 'Replace desktops with laptops — 4× lower power draw saves ~120 kWh/unit/year.' },
    { cond: wpV('wpServerKw')>0,      pct: 18,                             tip: 'Move on-premise servers to a certified green cloud (AWS/Azure in Mumbai region). Avg 65% lower IT emission.' },
    { cond: s3_domFlight/total>0.05,  pct: Math.round(s3_domFlight/total*50), tip: 'Replace domestic flights with video conferencing. One round-trip Chennai→Mumbai = 100 kg CO₂.' },
    { cond: s3_paper/total>0.01,      pct: 5,                              tip: 'Go paperless for internal docs. Eliminating printing halves paper Scope 3.' },
  ].filter(t=>t.cond&&t.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,4);

  document.getElementById('wpTipsList').innerHTML = tips.map(t=>
    `<div class="wp-tip-row">
       <span class="wp-tip-pct">↓${t.pct}%</span>
       <span>${t.tip}</span>
     </div>`).join('');

  /* Store for export */
  window._wpResult = { total, perEmp, s1, s2_elec, s3, cats, sector, employees, days };
  if (typeof mtImportSavedModeResults === 'function') mtImportSavedModeResults({ silent:true });
  const wpOrgName = wpS('wpName') || null;
  sbPost('carbon_profiles', {
    profile_type     : 'workplace',
    city_key         : currentCityKey,
    city_name        : city().name,
    total_tco2e      : total,
    per_capita_tco2e : perEmp,
    grade            : g,
    inputs           : { ...collectFormFields('#workplaceSection'), sector, employees, days, organisation: wpOrgName },
    results          : window._wpResult
  }, 'functional');
  saveRecentRecord('workplace', {
    city: city().name,
    title: wpOrgName || 'Workplace profile',
    detail: `${employees} employee(s) · Grade ${g}`,
    value: total,
    unit: 't/yr',
    grade: g,
    payload: window._wpResult
  });
  if (wpOrgName) {
    sbCreateBusinessEntity({
      entity_type : 'workplace',
      display_name: wpOrgName,
      sector,
      metadata: { employees, annualWorkDays: days, source: 'workplace_calculator' }
    });
  }
  sbUploadJsonArtifact('workplace-carbon-profile', window._wpResult, { profileType:'workplace', city:city().name });
}

document.getElementById('wpCalcBtn').addEventListener('click', calculateWorkplace);

/* Export report as plain text summary */
document.getElementById('wpExportBtn').addEventListener('click', () => {
  const r = window._wpResult;
  if (!r) return;
  const lines = [
    'WORKPLACE CARBON FOOTPRINT REPORT',
    'Generated: ' + new Date().toLocaleString('en-IN'),
    '─'.repeat(48),
    `Organisation: ${wpS('wpName')||'—'}`,
    `Sector: ${WP_BENCH[r.sector]?.label||r.sector}`,
    `Employees: ${r.employees}  ·  Working days: ${r.days}`,
    '',
    'TOTAL:  ' + r.total.toFixed(3) + ' t CO₂e / year',
    'Per employee: ' + r.perEmp.toFixed(3) + ' t CO₂e / year',
    '',
    'SCOPE BREAKDOWN',
    '  Scope 1 (Direct):      ' + r.s1.toFixed(3) + ' t',
    '  Scope 2 (Electricity): ' + r.s2_elec.toFixed(3) + ' t',
    '  Scope 3 (Value chain): ' + r.s3.toFixed(3) + ' t',
    '',
    'CATEGORY BREAKDOWN',
    ...r.cats.map(c=>`  ${c.name.padEnd(24)} ${c.val.toFixed(3)} t  (${(c.val/r.total*100).toFixed(1)}%)`),
    '',
    'Emission factors: India CEA 2023 grid · ICAO flights · IPCC AR6',
    'Tool: Chennai Carbon Calculator',
  ];
  const blob = new Blob([lines.join('\n')], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'workplace_carbon_report.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ──────────────────────────────────────────────────────
//  MODE TOGGLE — Commute / Workplace / Home
// ──────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────
//  HOME CARBON CALCULATOR
// ──────────────────────────────────────────────────────

/* Emission factors — Indian context */
const HM_EF = {
  /* Cooking */
  lpgKgPerCylinder : 14.2,   // kg per 14.2 kg domestic cylinder
  lpgCO2PerKg      : 2.983,  // kg CO₂/kg LPG
  pngCO2PerSCM     : 2.220,  // kg CO₂/SCM piped gas
  inductionKw      : 1.5,    // induction cooktop kW
  microwaveKw      : 0.9,    // microwave kW

  /* Appliances (kW) */
  acKwPerTon       : 1.17,   // actual draw (COP 3)
  fanKw            : 0.075,
  geyserWatt       : { solar_thermal:0, electric_2kw:2, electric_3kw:3, instant:4.5, none:0 },
  // geyser: heating 1L water by 30°C needs 0.035 kWh; electric geyser efficiency ~90%
  geyserKwhPerL    : 0.039,
  fridgeKwhPerDay  : { small:0.5, medium:1.0, large:1.5, double:2.0 },
  washKwhPerLoad   : 0.5,
  tvKw             : 0.10,
  laptopKw         : 0.05,

  /* Water treatment (kg CO₂/m³) */
  waterCO2PerM3    : 0.344,
  // RO wastes ~3L per 1L purified
  roCO2Factor      : 4,

  /* Vehicle (kg CO₂/km) */
  carPetrol        : 0.170,
  carDiesel        : 0.155,
  carCng           : 0.105,
  carEv            : null,   // uses grid
  bikeKgPerKm      : 0.060,
  bikeEvKgPerKm    : null,   // uses grid
  cabKgPerKm       : 0.100,  // shared/pooled avg

  /* Flights */
  domFlightKgPerKm : 0.255,  // ICAO
  intlFlightKgPerKm: 0.195,
  domFlightAvgKm   : 900,    // typical domestic round-trip
  intlFlightAvgKm  : 5000,   // typical international round-trip

  /* Diet (kg CO₂e per person per day) */
  diet : {
    vegan        : 2.50,
    vegetarian   : 2.80,
    eggetarian   : 3.20,
    nonveg_occ   : 3.80,
    nonveg_reg   : 5.00,
  },

  /* Shopping lifecycle */
  clothingKgPerItem   : 15,   // avg garment lifecycle
  electronicsKgEach   : 80,   // avg smartphone/gadget
  applianceKgEach     : 400,  // large appliance lifecycle
  deliveryKgEach      : 0.50, // per online delivery
  furnitureKg         : { 0:0, 1:25, 2:120, 3:350 },

  /* Waste (reduction multipliers) */
  plasticKgPerMonth   : { high:2.0, medium:1.0, low:0.3, none:0.05 },
  plasticCO2PerKg     : 3.0,  // production + disposal
};

function hmV(id){ return parseFloat(document.getElementById(id)?.value||0)||0; }
function hmS(id){ return document.getElementById(id)?.value||''; }

function calculateHome(){
  const occupants  = Math.max(1, hmV('hmOccupants'));
  const gridKgKwh  = city().grid;

  /* ── SCOPE 2: Home electricity ── */
  const elecKwh    = hmV('hmElec') * 12;
  const solarPct   = hmV('hmSolar') / 100;
  const gridKwh    = elecKwh * (1 - solarPct);

  /* AC */
  const acKwh   = hmV('hmAcUnits') * parseFloat(hmS('hmAcTons'))
                * HM_EF.acKwPerTon * hmV('hmAcHours')
                * (hmV('hmAcMonths') * 30.4);

  /* Fans */
  const fanKwh  = hmV('hmFans') * HM_EF.fanKw * hmV('hmFanHrs') * 365;

  /* Geyser */
  const geyserKwhPerL = HM_EF.geyserKwhPerL;
  const geyserKwh = hmS('hmGeyser') === 'solar_thermal' ? 0
                  : hmS('hmGeyser') === 'none' ? 0
                  : hmV('hmGeyserL') * geyserKwhPerL * 365;

  /* Fridge */
  const fridgeKwh = (HM_EF.fridgeKwhPerDay[hmS('hmFridge')]||1) * 365;

  /* Washing machine */
  const washKwh   = hmV('hmWash') * 52 * HM_EF.washKwhPerLoad;

  /* TV + Laptops */
  const tvKwh     = HM_EF.tvKw     * hmV('hmTvHrs')   * 365;
  const laptopKwh = HM_EF.laptopKw * hmV('hmLaptops') * 8 * 365;

  /* Cooking — electric */
  const inductionKwh  = hmV('hmInduction')  * HM_EF.inductionKw  * 365;
  const microwaveKwh  = hmV('hmMicrowave')  * HM_EF.microwaveKw  * 365;

  const totalElecKwh = gridKwh + acKwh + fanKwh + geyserKwh
                     + fridgeKwh + washKwh + tvKwh + laptopKwh
                     + inductionKwh + microwaveKwh;

  const s2_elec = totalElecKwh * gridKgKwh / 1000; // tCO₂

  /* ── SCOPE 1: Direct ── */
  const s1_lpg  = hmV('hmLpg')  * 12 * HM_EF.lpgKgPerCylinder * HM_EF.lpgCO2PerKg / 1000;
  const s1_png  = hmV('hmPng')  * 12 * HM_EF.pngCO2PerSCM / 1000;

  /* Vehicles */
  const carFuel = hmS('hmCarFuel');
  const carKm   = hmV('hmCarKm') * 12;
  const carKgPer = carFuel==='petrol' ? HM_EF.carPetrol
                 : carFuel==='diesel' ? HM_EF.carDiesel
                 : carFuel==='cng'    ? HM_EF.carCng
                 : carFuel==='ev'     ? gridKgKwh * 0.2  // 200 Wh/km EV
                 : 0;
  const s1_car  = carKm * carKgPer / 1000;

  const bikeKm   = hmV('hmBikeKm') * 12;
  const bikeKgPer = hmS('hmBikeFuel')==='electric'
                  ? gridKgKwh * 0.04  // 40 Wh/km e-bike
                  : HM_EF.bikeKgPerKm;
  const s1_bike = bikeKm * bikeKgPer / 1000;

  const s1 = s1_lpg + s1_png + s1_car + s1_bike;

  /* ── SCOPE 3 ── */
  /* Flights */
  const s3_domFlight  = hmV('hmDomFlights')  * HM_EF.domFlightAvgKm  * 2 * HM_EF.domFlightKgPerKm  / 1000;
  const s3_intlFlight = hmV('hmIntlFlights') * HM_EF.intlFlightAvgKm * 2 * HM_EF.intlFlightKgPerKm / 1000;
  const s3_cab        = hmV('hmCabKm') * 12 * HM_EF.cabKgPerKm / 1000;
  const s3_travel     = s3_domFlight + s3_intlFlight + s3_cab;

  /* Diet */
  const dietKgPerDay  = HM_EF.diet[hmS('hmDiet')] || 2.8;
  const localDiscount = (hmV('hmLocalFood') / 100) * 0.1; // up to 10% reduction
  const wasteMulti    = 1 + (parseFloat(hmS('hmFoodWaste'))||15) / 100;
  const eatOutKgPerWeek = hmV('hmEatOut') * 0.8; // extra ~0.8 kg CO₂ per meal out
  const s3_diet = (dietKgPerDay * (1-localDiscount) * wasteMulti * 365
                + eatOutKgPerWeek * 52) * occupants / 1000;

  /* Water */
  const waterM3  = (hmV('hmWater') + hmV('hmGarden')) * 365 / 1000;
  const roWasteM3 = hmV('hmRo') * HM_EF.roCO2Factor * 365 / 1000;
  const poolM3   = hmV('hmPool') / 1000 * 4; // 4 full refills/year
  const s3_water = (waterM3 + roWasteM3 + poolM3) * HM_EF.waterCO2PerM3 / 1000;

  /* Shopping */
  const s3_clothes   = hmV('hmClothes')     * HM_EF.clothingKgPerItem  / 1000;
  const s3_elec      = hmV('hmElectronics') * HM_EF.electronicsKgEach  / 1000;
  const s3_appli     = hmV('hmAppliances')  * HM_EF.applianceKgEach    / 1000;
  const s3_deliver   = hmV('hmDeliveries')  * 52 * HM_EF.deliveryKgEach / 1000;
  const furni        = parseFloat(hmS('hmFurniture'))||0;
  const s3_furniture = (HM_EF.furnitureKg[furni]||0) / 1000;
  const s3_shopping  = s3_clothes + s3_elec + s3_appli + s3_deliver + s3_furniture;

  /* Waste & plastic */
  const plasticKg   = (HM_EF.plasticKgPerMonth[hmS('hmPlastic')]||1) * 12;
  const compostDisc = hmS('hmCompost')==='yes'?0.4 : hmS('hmCompost')==='partial'?0.2 : 0;
  const segregDisc  = hmS('hmSegregation')==='full'?0.25 : hmS('hmSegregation')==='partial'?0.10 : 0;
  const s3_waste    = plasticKg * HM_EF.plasticCO2PerKg * (1-compostDisc-segregDisc) / 1000;

  const s3 = s3_travel + s3_diet + s3_water + s3_shopping + s3_waste;
  const total    = s1 + s2_elec + s3;
  const perCap   = total / occupants;

  /* ── Render ── */
  const rc = document.getElementById('hmResultCard');
  rc.style.display = '';
  rc.scrollIntoView({behavior:'smooth', block:'start'});

  document.getElementById('hmTotalVal') .textContent = total.toFixed(2);
  document.getElementById('hmPerCapita').textContent = perCap.toFixed(2);

  /* Grade vs India urban avg ~5t, global sustainable ~2.3t */
  const g = perCap<1.5?'A':perCap<2.5?'B':perCap<4?'C':perCap<7?'D':'F';
  const gEl = document.getElementById('hmGrade');
  gEl.textContent=g; gEl.className='sc-grade '+g;

  /* Carbon budget bar — scale to 2× Paris budget (4.6t) */
  const SCALE = Math.max(total*1.1, 10);
  const indiaAvg = 1.9 * occupants, parisBudget = 2.3 * occupants;
  document.getElementById('hmBudgetBar') .style.width = Math.max(0,(1-total/SCALE)*100).toFixed(1)+'%';
  document.getElementById('hmMarkerIndia').style.left = Math.min(98,(indiaAvg/SCALE*100)).toFixed(1)+'%';
  document.getElementById('hmMarkerParis').style.left = Math.min(98,(parisBudget/SCALE*100)).toFixed(1)+'%';
  document.getElementById('hmMarkerYou')  .style.left = Math.min(98,(total/SCALE*100)).toFixed(1)+'%';
  document.getElementById('hmBudgetScale').textContent = SCALE.toFixed(1)+' t';

  /* Scope bars */
  const maxS = Math.max(s1, s2_elec, s3, 0.001);
  document.getElementById('hmS1Val').textContent = s1.toFixed(3)+' t';
  document.getElementById('hmS2Val').textContent = s2_elec.toFixed(3)+' t';
  document.getElementById('hmS3Val').textContent = s3.toFixed(3)+' t';
  document.getElementById('hmS1Bar').style.width = (s1/maxS*100).toFixed(1)+'%';
  document.getElementById('hmS2Bar').style.width = (s2_elec/maxS*100).toFixed(1)+'%';
  document.getElementById('hmS3Bar').style.width = (s3/maxS*100).toFixed(1)+'%';

  function tags(pairs){ return pairs.filter(([,v])=>v>0.0001).map(([l,v])=>`<span class="wp-scope-tag">${l}: ${v.toFixed(3)}t</span>`).join(''); }
  document.getElementById('hmS1Detail').innerHTML = tags([['LPG',s1_lpg],['PNG',s1_png],['Car',s1_car],['Two-wheeler',s1_bike]]);
  document.getElementById('hmS2Detail').innerHTML = tags([['Grid electricity',s2_elec]]);
  document.getElementById('hmS3Detail').innerHTML = tags([['Food & diet',s3_diet],['Flights',s3_domFlight+s3_intlFlight],['Cab',s3_cab],['Shopping',s3_shopping],['Water',s3_water],['Waste',s3_waste]]);

  /* Donut */
  const cats = [
    {name:'⚡ Electricity', val:s2_elec},
    {name:'🍽 Food & diet',  val:s3_diet},
    {name:'🔥 Cooking gas',  val:s1_lpg+s1_png},
    {name:'🚗 Vehicles',     val:s1_car+s1_bike},
    {name:'✈️ Flights',       val:s3_domFlight+s3_intlFlight+s3_cab},
    {name:'🛍 Shopping',     val:s3_shopping},
    {name:'💧 Water',        val:s3_water},
    {name:'🗑 Waste',        val:s3_waste},
  ].filter(c=>c.val>0).sort((a,b)=>b.val-a.val);

  const R=48,CX=60,CY=60,CIRC=2*Math.PI*R;
  let offset=0, arcs='';
  cats.forEach((c,i)=>{
    const dash=(c.val/total)*CIRC;
    arcs+=`<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${WP_COLORS[i%WP_COLORS.length]}" stroke-width="18" stroke-dasharray="${dash.toFixed(2)} ${(CIRC-dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"/>`;
    c.color=WP_COLORS[i%WP_COLORS.length]; offset+=dash;
  });
  document.getElementById('hmDonut').innerHTML=`<circle cx="60" cy="60" r="48" fill="none" stroke="var(--bd2)" stroke-width="18"/>${arcs}`;
  document.getElementById('hmCatList').innerHTML=cats.map(c=>`<div class="wp-cat-row"><span class="wp-cat-dot" style="background:${c.color}"></span><span class="wp-cat-name">${c.name}</span><span class="wp-cat-pct">${(c.val/total*100).toFixed(0)}%</span><span class="wp-cat-val">${c.val.toFixed(3)}t</span></div>`).join('');

  /* Benchmark */
  const indiaPerCap=1.9, globalAvg=4.7, paris=2.3;
  const bPct=Math.min(100, perCap/(globalAvg*1.5)*100);
  document.getElementById('hmBenchmark').innerHTML=`
    <b>India urban average:</b> ~${indiaPerCap} t CO₂e/person/yr &nbsp;·&nbsp;
    <b>Global average:</b> ~${globalAvg} t &nbsp;·&nbsp;
    <b>Paris 1.5°C budget:</b> ~${paris} t<br>
    Your footprint <b>${perCap.toFixed(2)} t/person</b> is ${perCap<=paris?
      `<span style="color:var(--green)">✓ within the 1.5°C sustainable budget</span>`:
      perCap<=indiaPerCap?`<span style="color:var(--green)">✓ below India average</span>`:
      `<span style="color:var(--amber)">⚠ ${((perCap/paris-1)*100).toFixed(0)}% above the Paris budget</span>`}
    <div class="wp-bm-bar-wrap"><div class="wp-bm-your" style="width:${bPct.toFixed(1)}%;background:${perCap<=paris?'var(--green)':'var(--amber)'}"></div></div>`;

  /* Tips */
  const tips=[
    {cond:acKwh/totalElecKwh>0.3, pct:Math.round(acKwh/totalElecKwh*s2_elec/total*40),
     tip:`Set AC to 24°C (not 18°C). Each degree higher saves ~6% cooling energy. Inverter ACs use 30–40% less.`},
    {cond:s1_lpg>0.3,              pct:15,
     tip:`Switch to induction cooking. No direct LPG emissions and more efficient — saves ~${s1_lpg.toFixed(2)} t CO₂/year.`},
    {cond:solarPct<0.2,            pct:Math.round(s2_elec/total*35),
     tip:`Install rooftop solar. A 2 kW system covers ~80% of a 2BHK's needs and pays back in 5–6 years.`},
    {cond:s3_diet/total>0.25,      pct:12,
     tip:`Reducing meat to once a week saves ~0.5 t CO₂e/person/year. Local seasonal produce cuts another 5%.`},
    {cond:(s3_domFlight+s3_intlFlight)/total>0.1, pct:Math.round((s3_domFlight+s3_intlFlight)/total*60),
     tip:`Flights are your biggest single Scope 3 item. One fewer round-trip saves ~${(HM_EF.domFlightAvgKm*2*HM_EF.domFlightKgPerKm/1000).toFixed(2)} t CO₂.`},
    {cond:hmS('hmSegregation')==='none', pct:5,
     tip:`Segregating dry/wet waste and composting wet waste can cut household waste emissions by 40–60%.`},
    {cond:fridgeKwh/totalElecKwh>0.2, pct:8,
     tip:`Old refrigerators use 2–3× more electricity. A 3-star BEE-rated model reduces fridge energy by ~40%.`},
    {cond:s3_shopping/total>0.15,  pct:10,
     tip:`Buying second-hand clothing and repairing devices instead of replacing cuts shopping emissions by ~50%.`},
  ].filter(t=>t.cond&&t.pct>0).sort((a,b)=>b.pct-a.pct).slice(0,4);

  document.getElementById('hmTipsList').innerHTML=tips.map(t=>
    `<div class="wp-tip-row"><span class="wp-tip-pct">↓${t.pct}%</span><span>${t.tip}</span></div>`).join('');

  window._hmResult={total,perCap,s1,s2_elec,s3,cats,occupants};
  if (typeof mtImportSavedModeResults === 'function') mtImportSavedModeResults({ silent:true });
  sbPost('carbon_profiles', {
    profile_type     : 'household',
    city_key         : currentCityKey,
    city_name        : city().name,
    total_tco2e      : total,
    per_capita_tco2e : perCap,
    grade            : g,
    inputs           : { ...collectFormFields('#homeSection'), occupants, diet: hmS('hmDiet') },
    results          : window._hmResult
  }, 'functional');
  saveRecentRecord('home', {
    city: city().name,
    title: 'Home profile',
    detail: `${occupants} occupant(s) · Grade ${g}`,
    value: total,
    unit: 't/yr',
    grade: g,
    payload: window._hmResult
  });
  sbUploadJsonArtifact('household-carbon-profile', window._hmResult, { profileType:'household', city:city().name });
}

document.getElementById('hmCalcBtn').addEventListener('click', calculateHome);

document.getElementById('hmExportBtn').addEventListener('click',()=>{
  const r=window._hmResult; if(!r) return;
  const lines=[
    'HOME CARBON FOOTPRINT REPORT',
    'Generated: '+new Date().toLocaleString('en-IN'),
    'City: '+city().name+' ('+city().state+')',
    '─'.repeat(48),
    `Household total:  ${r.total.toFixed(3)} t CO₂e / year`,
    `Per person:       ${r.perCap.toFixed(3)} t CO₂e / year`,
    `Occupants:        ${r.occupants}`,
    '',
    'SCOPE BREAKDOWN',
    `  Scope 1 (Direct):       ${r.s1.toFixed(3)} t`,
    `  Scope 2 (Electricity):  ${r.s2_elec.toFixed(3)} t`,
    `  Scope 3 (Indirect):     ${r.s3.toFixed(3)} t`,
    '',
    'CATEGORY BREAKDOWN',
    ...r.cats.map(c=>`  ${c.name.padEnd(22)} ${c.val.toFixed(3)} t  (${(c.val/r.total*100).toFixed(1)}%)`),
    '',
    `Grid intensity used: ${city().grid} kg CO₂/kWh (${city().state}, CEA 2023)`,
    'References: IPCC AR6 · ICAO CORSIA · MoEFCC India · BEE appliance data',
  ];
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='home_carbon_report.txt';
  a.click(); URL.revokeObjectURL(a.href);
});

/* Update city grid note when city changes */
const _origSetCity = setCity;
setCity = function(key){
  if (!CITIES[key]) return;
  _origSetCity(key);
  const gn=document.getElementById('hmGridNote');
  if(gn) gn.textContent=`${CITIES[key]?.name}: ${CITIES[key]?.grid} kg CO₂/kWh`;
  syncCityControls(key);
};

function syncCityControls(key=currentCityKey){
  document.querySelectorAll('.city-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.city === key));
  document.querySelectorAll('.sb-city-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.city === key));
  const mtCity = document.getElementById('mtCity');
  if (mtCity && mtCity.value !== key) mtCity.value = key;
  updateSbCity?.();
  updateSbWeather?.();
}


// ──────────────────────────────────────────────────────
//  SIDEBAR — desktop navigation panel
// ──────────────────────────────────────────────────────

function buildSidebar() {
  /* City buttons */
  const sbCities = document.getElementById('sbCities');
  if (sbCities) {
    sbCities.innerHTML = Object.entries(CITIES).map(([k, c]) =>
      `<button class="sb-city-btn${k===currentCityKey?' active':''}" data-city="${k}">
         <span class="sb-city-code">${c.code}</span>
         <span class="sb-city-name">${c.name}</span>
       </button>`
    ).join('');
  }

  /* Mode buttons */
  const sbModes = document.getElementById('sbModes');
  if (sbModes) {
    const modes = [
      {mode:'commute',   icon:'🧍', label:'My Commute'},
      {mode:'workplace', icon:'🏢', label:'My Workplace'},
      {mode:'home',      icon:'🏠', label:'My Home'},
      {mode:'taint',     icon:'🌿', label:'My Taint'},
      {mode:'buy',       icon:'🛒', label:'Taint Buy'},
      {mode:'admin',     icon:'⚙️', label:'Taint Admin', adminOnly:true},
    ];
    sbModes.innerHTML = modes.map(m =>
      `<button class="sb-mode-btn${m.mode==='commute'?' active':''}" data-mode="${m.mode}"${m.adminOnly?' data-admin-only="true" hidden':''}>
         ${m.icon} ${m.label}
       </button>`
    ).join('');
    sbModes.querySelectorAll('.sb-mode-btn').forEach(btn =>
      btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  }

  /* Keep sidebar in sync when mode tabs are clicked */
  document.querySelectorAll('.mode-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      sbModes?.querySelectorAll('.sb-mode-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === tab.dataset.mode));
    }));

  syncCityControls(currentCityKey);
  updateSbCity();
  updateSbWeather();
  updateSbStats();
  syncAdminVisibility();
}

function updateSbCity() {
  const el = document.getElementById('sbCity');
  if (el) el.textContent = city().name;
}

function updateSbWeather() {
  const el = document.getElementById('sbWeather');
  if (!el) return;
  const tempVal  = document.getElementById('tempVal')?.textContent  || '—';
  const aqiEl    = document.getElementById('aqiVal');
  const aqiEmoji = document.getElementById('aqiEmoji')?.textContent || '🌫️';
  el.innerHTML = `
    <div style="font-size:11px;color:var(--hi);margin-bottom:4px;text-transform:uppercase;letter-spacing:.07em">Live · ${city().name}</div>
    <div style="display:flex;gap:10px;align-items:center">
      <span style="font-size:20px;font-weight:700;color:var(--tx)">${tempVal}°C</span>
      <span style="font-size:13px">${aqiEmoji} AQI ${aqiEl?.textContent||'—'}</span>
    </div>`;
}

function updateSbStats() {
  const el = document.getElementById('sbMiniStats');
  if (!el) return;
  const users = document.getElementById('statUsers')?.textContent || '—';
  const calcs = document.getElementById('statCalcs')?.textContent || '—';
  el.innerHTML = `
    <div class="sb-stat">
      <div class="sb-stat-lbl"><span class="dot" style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 1.2s infinite;margin-right:4px;vertical-align:middle"></span>Visitors</div>
      <div class="sb-stat-val">${users}</div>
      <div class="sb-stat-sub" id="sbUsersLbl">${document.getElementById('statUsersLbl')?.textContent||''}</div>
    </div>
    <div class="sb-stat">
      <div class="sb-stat-lbl">Calculations</div>
      <div class="sb-stat-val">${calcs}</div>
    </div>`;
}

/* Hook stat and weather updates into sidebar */
const _origRefreshGlobalStats = typeof refreshGlobalStats==='function' ? refreshGlobalStats : null;
if (_origRefreshGlobalStats) {
  const __rgs = refreshGlobalStats;
  window.refreshGlobalStats = async function() {
    await __rgs();
    updateSbStats();
  };
}

/* Keep sidebar weather in sync with topbar updates */
const _tempValEl = document.getElementById('tempVal');
if (_tempValEl) {
  new MutationObserver(updateSbWeather).observe(_tempValEl, {childList:true, characterData:true, subtree:true});
}
const _aqiValEl = document.getElementById('aqiVal');
if (_aqiValEl) {
  new MutationObserver(updateSbWeather).observe(_aqiValEl, {childList:true, characterData:true, subtree:true});
}

// ──────────────────────────────────────────────────────
function setMode(mode) {
  if (mode === 'admin' && !isTaintAdminOwner()) {
    syncAdminVisibility();
    if (!currentUser) {
      showAuthOverlay('signin');
      showAuthError('Taint Admin is visible only after the Supabase owner signs in.');
    } else {
      notify('Taint Admin is restricted to the configured Supabase owner.', 'warn', 'Admin');
    }
    mode = 'commute';
  }
  document.querySelectorAll('.mode-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.sb-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  ['commute','workplace','home','taint','buy','admin'].forEach(s => {
    const section = document.getElementById(s + 'Section');
    if (section) section.style.display = s === mode ? '' : 'none';
  });
  const siteCarbon = document.getElementById('siteCarbonCard');
  if (siteCarbon) siteCarbon.style.display = '';
  if (mode === 'taint') mtImportSavedModeResults();
  if (mode === 'buy') tbInit();
  if (mode === 'admin') updateAdminStats();
  if (RECENT_MODE_CONFIG[mode]) refreshRecentCalculations(mode);
  syncAdminVisibility();
}

document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// ──────────────────────────────────────────────────────
//  MY TAINT WIZARD
// ──────────────────────────────────────────────────────

const MT_TOTAL_STEPS = 6;
let mtCurrentStep  = 0;
let mtStepDone     = [false,false,false,false,false,false];
let mtSaved        = {};   // accumulated step results (t CO₂e)

function mtSetBadge(id, text) {
  const badge = document.getElementById(id);
  if (!badge || !text) return;
  badge.textContent = text;
  badge.classList.add('show');
}

function mtHomePerCap() {
  const h = mtSaved.home;
  if (!h) return 0;
  if (Number.isFinite(h.perCap)) return h.perCap;
  const occ = Math.max(1, h.occ || parseFloat(document.getElementById('mtOccupants')?.value) || 1);
  return (h.t || 0) / occ;
}

function mtImportSavedModeResults(options={}) {
  const commute = window._commuteResult;
  if (commute?.annualTco2e != null) {
    mtSaved.commute = {
      source: 'commuteMode',
      t: commute.annualTco2e,
      km: commute.distanceKm,
      mode: commute.vehicleLabel || commute.fuel || commute.mode,
      days: Math.round((commute.annualDays || 260) / 52),
      perTripKg: commute.perTripKg,
      puc: commute.puc || null,
      adjustedGPerKm: commute.adjustedGPerKm || null
    };
    mtSetBadge('mtCommuteResult',
      `✓ Imported from My Commute — ${(commute.annualTco2e * 1000).toFixed(1)} kg CO₂/year`);
  }

  const workplace = window._wpResult;
  if (workplace?.perEmp != null) {
    mtSaved.workplace = {
      source: 'workplaceMode',
      t: workplace.perEmp,
      elecT: workplace.s2_elec || 0,
      s1: workplace.s1 || 0,
      s3: workplace.s3 || 0,
      employees: workplace.employees || 1
    };
    mtSetBadge('mtWorkplaceResult',
      `✓ Imported from My Workplace — ${(workplace.perEmp * 1000).toFixed(1)} kg CO₂/year per employee`);
  }

  const home = window._hmResult;
  if (home?.total != null) {
    const occ = Math.max(1, home.occupants || parseFloat(document.getElementById('mtOccupants')?.value) || 1);
    mtSaved.home = {
      source: 'homeMode',
      t: home.total,
      perCap: home.perCap ?? home.total / occ,
      occ,
      s1: home.s1 || 0,
      elecT: home.s2_elec || 0,
      s3: home.s3 || 0,
      lpgT: 0,
      dietT: 0,
      acT: 0,
      carT: 0
    };
    const occInput = document.getElementById('mtOccupants');
    if (occInput) occInput.value = occ;
    mtSetBadge('mtHomeResult',
      `✓ Imported from My Home — ${home.total.toFixed(3)} t CO₂/year household (${occ} people)`);
  }

  if (!options.silent && (commute || workplace || home)) {
    notify('My Taint now includes saved Commute, Workplace, and Home results.', 'success', 'My Taint');
  }
  if (mtCurrentStep === 4) mtRenderResults();
}

/* Commute emission factors (g CO₂/km per person) for simplified mode picker */
const MT_COMMUTE_G = {
  walk:0, cycle:5, two_petrol:63, two_ev:null,
  car_petrol:140, car_ev:null, car_cng:105,
  auto:55, bus:28, metro:null, cab:100
};

function mtCommuteFactor(mode) {
  if (mode==='two_ev')  return city().grid * 0.038 * 1000;
  if (mode==='car_ev')  return city().grid * 0.150 * 1000;
  if (mode==='metro')   return city().grid * 0.060 * 1000;
  return MT_COMMUTE_G[mode] || 0;
}

/* Progress bar + step dots */
function mtUpdateProgress() {
  const pct = mtCurrentStep / (MT_TOTAL_STEPS - 1) * 100;
  document.getElementById('mtProgFill').style.width = pct.toFixed(1) + '%';
  document.querySelectorAll('.mt-step').forEach((el, i) => {
    el.classList.toggle('active', i === mtCurrentStep);
    el.classList.toggle('done',   i < mtCurrentStep);
  });
  document.getElementById('mtPrevBtn').disabled = mtCurrentStep === 0;
  const isLast = mtCurrentStep === MT_TOTAL_STEPS - 1;
  const saveBtn = document.getElementById('mtSaveBtn');
  saveBtn.textContent = isLast ? '✓ Finish' : 'Save & Next →';
  document.getElementById('mtSkipBtn').style.display = isLast ? 'none' : '';
  const calcAction = document.getElementById('mtCalcAction');
  if (calcAction) calcAction.hidden = mtCurrentStep !== 4;
}

/* Show the current step panel */
function mtShowStep(n) {
  for (let i = 0; i < MT_TOTAL_STEPS; i++) {
    const el = document.getElementById('mtStep' + i);
    if (el) el.style.display = i === n ? '' : 'none';
  }
  mtCurrentStep = n;
  mtUpdateProgress();
  if (n === 4) mtRenderResults();
  if (n === 5) mtSyncToolFootprint();
}

/* ── Step 1: Calculate commute contribution ── */
function mtCalcCommute() {
  const km   = parseFloat(document.getElementById('mtCommuteKm').value)  || 0;
  const mode = document.getElementById('mtCommuteMode').value;
  const days = parseFloat(document.getElementById('mtCommuteDays').value) || 5;
  const pax  = parseFloat(document.getElementById('mtCommutePax').value)  || 1;
  const gPerKm = mtCommuteFactor(mode);
  const annualKm = km * 2 * days * 52;  // round-trip × weeks
  const tCO2 = annualKm * gPerKm / pax / 1e6;
  mtSaved.commute = { t: tCO2, km, mode, days };
  const badge = document.getElementById('mtCommuteResult');
  badge.textContent = `✓ Saved — ${(tCO2 * 1000).toFixed(1)} kg CO₂/year (${annualKm.toFixed(0)} km/year)`;
  badge.classList.add('show');
  return tCO2;
}

/* ── Step 2: Workplace contribution (per-employee) ── */
function mtCalcWorkplace() {
  const elec    = parseFloat(document.getElementById('mtOfficeElec').value) || 0;
  const acHrs   = parseFloat(document.getElementById('mtOfficeAcHrs').value) || 8;
  const wfhDays = parseFloat(document.getElementById('mtWfhDays').value) || 0;
  const flights  = parseFloat(document.getElementById('mtBizFlights').value) || 0;
  const g = city().grid;
  // Electricity share (per employee, annual)
  const elecT  = elec * 12 * g / 1000;
  // AC (1 unit 1.5 ton, per employee slot ~0.1 AC unit)
  const acT    = 1 * 1.5 * 1.17 * acHrs * 250 * g / 1000;
  const wfhT   = (80/1000 * 8 * wfhDays * 52 * g) / 1000;
  const flightT = flights * 1800 * 0.255 / 1000; // ~1800km avg domestic RT
  const t = elecT + acT + wfhT + flightT;
  mtSaved.workplace = { t, elecT, acT, wfhT, flightT };
  const badge = document.getElementById('mtWorkplaceResult');
  badge.textContent = `✓ Saved — ${(t * 1000).toFixed(1)} kg CO₂/year (your workplace share)`;
  badge.classList.add('show');
  return t;
}

/* ── Step 3: Home contribution ── */
function mtCalcHome() {
  const elec = parseFloat(document.getElementById('mtHomeElec').value) || 0;
  const lpg  = parseFloat(document.getElementById('mtHomeLpg').value)  || 0;
  const ac   = parseFloat(document.getElementById('mtHomeAc').value)   || 0;
  const acH  = parseFloat(document.getElementById('mtHomeAcHrs').value)|| 0;
  const km   = parseFloat(document.getElementById('mtPersonalKm').value)|| 0;
  const diet = document.getElementById('mtDiet').value;
  const occ  = parseFloat(document.getElementById('mtOccupants').value) || 3;
  const g    = city().grid;
  const dietG = { vegan:2.5, vegetarian:2.8, eggetarian:3.2, nonveg_occ:3.8, nonveg_reg:5.0 };
  const elecT  = elec * 12 * g / 1000;
  const acT    = ac * 1.5 * 1.17 * acH * 365 * g / 1000;
  const lpgT   = lpg * 12 * 14.2 * 2.983 / 1000;
  const dietT  = (dietG[diet] || 2.8) * 365 * occ / 1000;
  const carT   = km * 12 * 0.140 / 1000;
  const t = elecT + acT + lpgT + dietT + carT;
  mtSaved.home = { t, perCap:t / Math.max(1, occ), elecT, lpgT, acT, dietT, carT, occ };
  const badge = document.getElementById('mtHomeResult');
  badge.textContent = `✓ Saved — ${t.toFixed(3)} t CO₂/year household (${occ} people)`;
  badge.classList.add('show');
  return t;
}

/* ── Step 4: Render combined results ── */
function mtRenderResults() {
  const commute   = mtSaved.commute?.t   || 0;
  const workplace = mtSaved.workplace?.t || 0;
  const perCapHome = mtHomePerCap();
  const total     = commute + workplace + perCapHome;

  document.getElementById('mtTotalVal').textContent  = total.toFixed(2);
  const g = total < 1.5 ? 'A' : total < 2.5 ? 'B' : total < 4 ? 'C' : total < 7 ? 'D' : 'F';
  const gEl = document.getElementById('mtGrade');
  gEl.textContent = g; gEl.className = 'sc-grade ' + g;

  /* Breakdown strips */
  const max = Math.max(commute, workplace, perCapHome, 0.001);
  const strips = [
    { icon:'🚗', name:'Daily Commute',  val:commute,     color:'#34d399' },
    { icon:'🏢', name:'Workplace share',val:workplace,   color:'#60a5fa' },
    { icon:'🏠', name:'Home per person',val:perCapHome,  color:'#f59e0b' },
  ];
  document.getElementById('mtBreakdown').innerHTML = strips.map(s => `
    <div class="mt-strip">
      <span class="mt-strip-icon">${s.icon}</span>
      <span class="mt-strip-name">${s.name}</span>
      <div class="mt-strip-bar-wrap">
        <div class="mt-strip-bar" style="width:${(s.val/max*100).toFixed(1)}%;background:${s.color}"></div>
      </div>
      <span class="mt-strip-val">${s.val.toFixed(3)} t</span>
    </div>`).join('');

  /* Budget bar */
  const SCALE = Math.max(total * 1.2, 6);
  document.getElementById('mtBudgetBar').style.width    = Math.max(0,(1-total/SCALE)*100).toFixed(1)+'%';
  document.getElementById('mtMarkerIndia').style.left   = (1.9/SCALE*100).toFixed(1)+'%';
  document.getElementById('mtMarkerParis').style.left   = (2.3/SCALE*100).toFixed(1)+'%';
  document.getElementById('mtMarkerYou').style.left     = Math.min(96,total/SCALE*100).toFixed(1)+'%';
  document.getElementById('mtBudgetScale').textContent  = SCALE.toFixed(1)+' t';

  /* Benchmark */
  document.getElementById('mtBenchmark').innerHTML =
    `<b>Your total:</b> ${total.toFixed(2)} t CO₂e/person/year &nbsp;·&nbsp;
     <b>India urban avg:</b> ~4–5 t &nbsp;·&nbsp; <b>Paris 1.5°C:</b> 2.3 t<br>
     ${total <= 2.3
       ? `<span style="color:var(--green)">✓ Within the 1.5°C sustainable budget</span>`
       : `<span style="color:var(--amber)">⚠ ${((total/2.3-1)*100).toFixed(0)}% above the Paris per-capita budget</span>`}`;

  /* Top tips drawn from largest contributor */
  const tipsPool = [
    { cond: commute > 0.5,    tip: `🚗 Commute is your biggest source. Switching to metro/bus saves ${((commute-commute*0.15)*1000).toFixed(0)} kg/year.` },
    { cond: workplace > 0.3,  tip: `🏢 Advocate for renewable energy at your office — electricity is the top workplace source.` },
    { cond: perCapHome > 1.0, tip: `🏠 Home diet and electricity dominate. Going vegetarian + solar can cut 0.5–1 t/year.` },
    { cond: total > 2.3,      tip: `🌍 You're above the Paris budget. One fewer domestic flight saves ~0.4 t.` },
    { cond: (mtSaved.home?.acT||0) > 0.2, tip: `❄️ AC at home is significant. Set to 24°C and use inverter ACs.` },
    { cond: true,             tip: `🌱 Share this profile — collective action is more effective than individual changes alone.` },
  ].filter(t=>t.cond).slice(0,3);

  document.getElementById('mtTipsList').innerHTML = tipsPool.map((t,i)=>
    `<div class="wp-tip-row"><span class="wp-tip-pct">${i+1}.</span><span>${t.tip}</span></div>`).join('');
  window._mtResult = { total, commute, workplace, perCapHome, grade:g, saved:{ ...mtSaved } };
}

/* ── Step 5: Sync site carbon display ── */
function mtSyncToolFootprint() {
  const totalG  = SC.totalGrams();
  const valEl   = document.getElementById('mtScVal');
  const unitEl  = document.getElementById('mtScUnit');
  const gradeEl = document.getElementById('mtScGrade');
  const summEl  = document.getElementById('mtScSummary');
  if (!valEl) return;
  let val, unit;
  if      (totalG < 0.001) { val=(totalG*1e6).toFixed(1); unit='µg CO₂'; }
  else if (totalG < 1)     { val=(totalG*1000).toFixed(2); unit='mg CO₂'; }
  else                     { val=totalG.toFixed(3);         unit='g CO₂'; }
  valEl.textContent  = val;
  unitEl.textContent = unit;
  const grade = scGrade(totalG);
  gradeEl.textContent = grade; gradeEl.className = 'sc-grade ' + grade.replace('+','');
  const commT = mtSaved.commute?.t || 0;
  if (commT > 0) {
    const pct = (totalG / (commT * 1e6) * 100).toFixed(5);
    summEl.textContent = `${val} ${unit} — that's ${pct}% of your annual commute emissions.`;
  } else {
    summEl.textContent = `${val} ${unit} for this session.`;
  }
}

/* Calculate full My Taint profile from imported mode data or wizard inputs */
function mtCalculateProfile() {
  const cityKey = document.getElementById('mtCity')?.value || currentCityKey;
  setCity(cityKey);
  mtImportSavedModeResults({ silent:true });

  if (!mtSaved.commute) mtCalcCommute();
  if (!mtSaved.workplace) mtCalcWorkplace();
  if (!mtSaved.home) mtCalcHome();

  mtStepDone = mtStepDone.map((done, i) => i <= 4 ? true : done);
  mtRenderResults();
  mtShowStep(4);

  const saveBtn = document.getElementById('mtSaveBtn');
  if (saveBtn) saveBtn.disabled = false;
  const result = window._mtResult || {};
  sbPost('carbon_profiles', {
    profile_type     : 'my_taint',
    city_key         : currentCityKey,
    city_name        : city().name,
    total_tco2e      : result.total || 0,
    per_capita_tco2e : result.total || 0,
    grade            : result.grade || null,
    inputs           : collectFormFields('#taintSection'),
    results          : result
  }, 'functional');
  saveRecentRecord('taint', {
    city: city().name,
    title: 'My Taint profile',
    detail: result.grade ? `Grade ${result.grade}` : 'Combined profile',
    value: result.total || 0,
    unit: 't/yr',
    grade: result.grade || '',
    payload: result
  });
  sbUploadJsonArtifact('my-taint-carbon-profile', result, { profileType:'my_taint', city:city().name });
  notify('My Taint carbon footprint calculated.', 'success', 'My Taint');
}

/* ── Save step ── */
function mtSave() {
  if (mtCurrentStep === 0) {
    /* Apply selected city */
    const cityKey = document.getElementById('mtCity').value;
    setCity(cityKey);
    document.querySelectorAll('.city-pill').forEach(p =>
      p.classList.toggle('active', p.dataset.city === cityKey));
  }
  if (mtCurrentStep === 1) mtCalcCommute();
  if (mtCurrentStep === 2) mtCalcWorkplace();
  if (mtCurrentStep === 3) { mtCalcHome(); }
  mtStepDone[mtCurrentStep] = true;
  if (mtCurrentStep < MT_TOTAL_STEPS - 1) {
    mtShowStep(mtCurrentStep + 1);
  } else {
    /* Finish */
    document.getElementById('mtSaveBtn').textContent = '✓ Done';
    document.getElementById('mtSaveBtn').disabled = true;
  }
}

/* ── Skip step ── */
function mtSkip() {
  mtStepDone[mtCurrentStep] = false;
  if (mtCurrentStep < MT_TOTAL_STEPS - 1) mtShowStep(mtCurrentStep + 1);
}

/* ── Navigation wiring ── */
document.getElementById('mtSaveBtn').addEventListener('click', mtSave);
document.getElementById('mtSkipBtn').addEventListener('click', mtSkip);
document.getElementById('mtPrevBtn').addEventListener('click', () => {
  if (mtCurrentStep > 0) mtShowStep(mtCurrentStep - 1);
});
document.getElementById('mtCalcBtn')?.addEventListener('click', mtCalculateProfile);
document.getElementById('mtCity')?.addEventListener('change', e => setCity(e.target.value));

/* ── Star rating ── */
let mtStarVal = 0;
document.querySelectorAll('#mtStarRow .star').forEach(star => {
  star.addEventListener('click', () => {
    mtStarVal = +star.dataset.v;
    document.querySelectorAll('#mtStarRow .star').forEach(s =>
      s.classList.toggle('lit', +s.dataset.v <= mtStarVal));
  });
  star.addEventListener('mouseenter', () => {
    document.querySelectorAll('#mtStarRow .star').forEach(s =>
      s.classList.toggle('lit', +s.dataset.v <= +star.dataset.v));
  });
  star.addEventListener('mouseleave', () => {
    document.querySelectorAll('#mtStarRow .star').forEach(s =>
      s.classList.toggle('lit', +s.dataset.v <= mtStarVal));
  });
});

document.getElementById('mtFeedbackSubmit').addEventListener('click', async () => {
  const text = document.getElementById('mtFeedbackText').value.trim();
  if (!mtStarVal && !text) return;

  const btn = document.getElementById('mtFeedbackSubmit');
  btn.textContent = 'Sending…'; btn.disabled = true;

  const name  = document.getElementById('mtName').value || 'Anonymous';
  const entry = { rating: mtStarVal, text, ts: new Date().toISOString(), city: city().name, source: 'My Taint' };

  /* Save locally */
  try { localStorage.setItem('fb_mt_' + Date.now(), JSON.stringify(entry)); } catch {}

  /* Send email via FormSubmit AJAX */
  let sent = false;
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${FEEDBACK_EMAIL}`, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body   : JSON.stringify({
        name     : name,
        email    : 'noreply@taint.app',
        message  : `[My Taint Feedback] ★${mtStarVal}/5 | City: ${city().name}\n\n${text || '(no message)'}`,
        _subject : `TAINT My Taint Feedback ★${mtStarVal} — ${name} (${city().name})`,
        _captcha : 'false',
        _template: 'table'
      })
    });
    const data = await res.json();
    sent = data.success === 'true' || data.success === true;
  } catch {}

  document.getElementById('mtFeedbackBody').innerHTML = `
    <div style="text-align:center;padding:16px;font-size:14px;color:var(--green)">
      ${sent
        ? `✅ Thank you, ${name}! Feedback emailed successfully.`
        : `💾 Feedback saved. Email delivery pending — check ${FEEDBACK_EMAIL} for a FormSubmit activation link if this is your first submission.`}
    </div>`;
});

/* ── Export full profile ── */
document.getElementById('mtExportBtn').addEventListener('click', () => {
  const name = document.getElementById('mtName').value || 'User';
  const lines = [
    `MY TAINT — PERSONAL CARBON PROFILE`,
    `Name: ${name}   City: ${city().name}   Date: ${new Date().toLocaleString('en-IN')}`,
    '─'.repeat(48),
  ];
  if (mtSaved.commute) {
    const c = mtSaved.commute;
    lines.push(`COMMUTE  ${(c.t*1000).toFixed(1)} kg CO₂/year`);
    lines.push(`  Mode: ${c.mode}  Distance: ${c.km} km one-way  Days/week: ${c.days}`);
  }
  if (mtSaved.workplace) {
    const w = mtSaved.workplace;
    lines.push(`WORKPLACE  ${(w.t*1000).toFixed(1)} kg CO₂/year (per-employee share)`);
  }
  if (mtSaved.home) {
    const h = mtSaved.home;
    lines.push(`HOME  ${h.t.toFixed(3)} t CO₂/year household (${h.occ} people)`);
    lines.push(`  Electricity: ${(h.elecT*1000).toFixed(0)} kg  LPG: ${(h.lpgT*1000).toFixed(0)} kg  Diet: ${(h.dietT*1000).toFixed(0)} kg`);
  }
  const total = (mtSaved.commute?.t||0) + (mtSaved.workplace?.t||0) + mtHomePerCap();
  lines.push('─'.repeat(48));
  lines.push(`TOTAL PER PERSON  ${total.toFixed(3)} t CO₂e/year`);
  lines.push(`Paris 1.5°C budget: 2.3 t   India urban avg: ~4–5 t`);
  lines.push('');
  lines.push(`Tool session footprint: ${(SC.totalGrams()*1000).toFixed(2)} mg CO₂`);
  lines.push(`Grid intensity: ${city().grid} kg CO₂/kWh (${city().state}, CEA 2023)`);
  const blob = new Blob([lines.join('\n')], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `my_taint_${city().code}_${name.replace(/\s+/g,'_')}.txt`;
  a.click(); URL.revokeObjectURL(a.href);
});

/* Initialise wizard */
mtUpdateProgress();

// ──────────────────────────────────────────────────────
//  TAINT BUY — Green product affiliate marketplace
// ──────────────────────────────────────────────────────

/* Affiliate tag placeholders — replace with your registered IDs */
const TB_TAGS = {
  amazon  : 'taintbuy-21',   // Amazon Associates India tag
  flipkart: 'taintbuyfl',    // Flipkart Affiliate ID
};

function tbAmzLink(asin) {
  return `https://www.amazon.in/dp/${asin}?tag=${TB_TAGS.amazon}&linkCode=ll1&language=en_IN`;
}
function tbFlipLink(pid) {
  return `https://www.flipkart.com/product/p/${pid}?affid=${TB_TAGS.flipkart}&affExtParam1=taintbuy`;
}
function tbAmazonSearchLink(query) {
  const params = new URLSearchParams({ k: query, tag: TB_TAGS.amazon, language: 'en_IN' });
  return `https://www.amazon.in/s?${params.toString()}`;
}
function tbFlipkartSearchLink(query) {
  const params = new URLSearchParams({ q: query });
  if (TB_TAGS.flipkart) {
    params.set('affid', TB_TAGS.flipkart);
    params.set('affExtParam1', 'taintbuy');
  }
  return `https://www.flipkart.com/search?${params.toString()}`;
}
function tbSafeExternalUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : '';
  } catch {
    return '';
  }
}
function tbProductSearchQuery(product) {
  const tags = Array.isArray(product.tags) ? product.tags.slice(0, 2).join(' ') : '';
  return `${product.name} ${tags} India`.replace(/\s+/g, ' ').trim();
}

/* ── Product database ── */
const TAINT_PRODUCTS = [
  /* ── TRANSPORT ── */
  { id:'ather_450x', cat:'transport',
    name:'Ather 450X Gen 3 EV Scooter', tagline:'Best urban EV scooter — 146 km range',
    priceNum:139900, price:'₹1.39 L', eco:95,
    saving:'630 kg CO₂/year vs petrol scooter',
    tags:['Electric','Zero tail-pipe','FAME-II subsidy'],
    links:{ brand:'https://www.atherenergy.com/450x' },
    commission:'Brand referral ~₹2,000/lead', stars:4.6, reviews:3241,
    desc:'Switch from petrol and save ₹18,000/year in fuel + 630 kg CO₂.',
  },
  { id:'ola_s1', cat:'transport',
    name:'Ola Electric S1 X+ Scooter', tagline:'Affordable EV — ₹79,999 ex-showroom',
    priceNum:79999, price:'₹79,999', eco:90,
    saving:'580 kg CO₂/year vs petrol scooter',
    tags:['Electric','App connected','Made in India'],
    links:{ brand:'https://www.olaelectric.com/s1x' },
    commission:'Brand referral ~₹1,500/lead', stars:4.0, reviews:5620,
    desc:'India\'s best-selling EV scooter. Lowest total cost of ownership.',
  },
  { id:'lectrix_charger', cat:'transport',
    name:'Lectrix EV Home Charger (3.3 kW)', tagline:'Level-2 AC charger, BIS certified',
    priceNum:5499, price:'₹5,499', eco:82,
    saving:'Enables overnight EV charging at ₹2.50/km vs ₹8/km petrol',
    tags:['EV accessory','BIS certified','1-year warranty'],
    links:{ amazon: tbAmzLink('B0C8NTLMHD'), flipkart: tbFlipLink('itmghu5fzwjrxhyz') },
    commission:'Amazon Associates ~8%', stars:4.3, reviews:412,
    desc:'Charge your EV overnight. Universal fit for all Indian EVs.',
  },
  { id:'cycle_vector', cat:'transport',
    name:'Vector E-Cycle (250W BLDC)', tagline:'Folding electric cycle for last-mile',
    priceNum:28990, price:'₹28,990', eco:88,
    saving:'Zero CO₂ — replaces car trips up to 25 km',
    tags:['Electric cycle','Foldable','IP54 rated'],
    links:{ amazon: tbAmzLink('B0B3NQ8JH2') },
    commission:'Amazon Associates ~5%', stars:4.2, reviews:289,
    desc:'Pedal-assist up to 25 km/h. Perfect for station-to-office last mile.',
  },

  /* ── ENERGY ── */
  { id:'luminous_solar', cat:'energy',
    name:'Luminous Solar Inverter Kit (3 kW)', tagline:'Complete rooftop solar system',
    priceNum:89000, price:'~₹89,000', eco:98,
    saving:'2,400 kg CO₂/year — offsets most home electricity',
    tags:['Solar','BIS','25-yr panel warranty','PM Surya Ghar subsidy'],
    links:{ amazon: tbAmzLink('B07WFQHS7B'), brand:'https://www.luminous.in/solar' },
    commission:'Amazon ~3% + brand ₹3,000/install', stars:4.4, reviews:1823,
    desc:'3 kW rooftop kit. ₹30,000 subsidy under PM Surya Ghar scheme.',
  },
  { id:'havells_5star_ac', cat:'energy',
    name:'Havells/Voltas 1.5 T 5-Star Inverter AC', tagline:'BEE 5-star — 40% less energy',
    priceNum:38990, price:'₹38,990', eco:78,
    saving:'220 kg CO₂/year vs 3-star AC (same usage)',
    tags:['BEE 5-star','Inverter','R-32 refrigerant','Wi-Fi'],
    links:{ amazon: tbAmzLink('B0BY8JXZWZ'), flipkart: tbFlipLink('itmf3zfhkggycgjz') },
    commission:'Amazon Associates ~4%', stars:4.5, reviews:6720,
    desc:'Inverter technology adapts to load. Saves ₹4,500/year in electricity vs a 3-star unit.',
  },
  { id:'philips_led', cat:'energy',
    name:'Philips LED Bulb 9W (Pack of 10)', tagline:'Replace 60W incandescent — save 85%',
    priceNum:599, price:'₹599', eco:85,
    saving:'38 kg CO₂/year for 10 bulbs (6 hrs/day)',
    tags:['LED','3-yr warranty','BIS','BEE labelled'],
    links:{ amazon: tbAmzLink('B075SFG5XW'), flipkart: tbFlipLink('itmf39z5fhkbcdfg') },
    commission:'Amazon Associates ~7%', stars:4.6, reviews:42800,
    desc:'Switch all CFL/incandescent bulbs. Saves ₹2,100/year in a typical 2BHK.',
  },
  { id:'enphase_monitor', cat:'energy',
    name:'Sense Energy Monitor (Smart Plug Kit)', tagline:'Track appliance-level power use',
    priceNum:4499, price:'₹4,499', eco:75,
    saving:'Up to 15% electricity reduction via usage awareness',
    tags:['IoT','Real-time','App-based','Wi-Fi'],
    links:{ amazon: tbAmzLink('B01NB5YTIF') },
    commission:'Amazon Associates ~6%', stars:4.1, reviews:1230,
    desc:'See exactly which appliance costs you what. Average household saves ₹1,800/year.',
  },
  { id:'solar_water_heater', cat:'energy',
    name:'V-Guard 200L Solar Water Heater', tagline:'No electricity for hot water',
    priceNum:18500, price:'₹18,500', eco:92,
    saving:'280 kg CO₂/year vs electric geyser',
    tags:['Solar thermal','5-yr warranty','BIS','MNRE approved'],
    links:{ amazon: tbAmzLink('B07CGNQDFK'), brand:'https://www.vguard.in/solar' },
    commission:'Amazon ~3%', stars:4.4, reviews:2100,
    desc:'Payback in 3–4 years. Eliminates geyser electricity in Indian climate.',
  },

  /* ── HOME ── */
  { id:'compost_ugaoo', cat:'home',
    name:'Ugaoo Balcony Compost Kit', tagline:'Convert wet waste to manure in 30 days',
    priceNum:899, price:'₹899', eco:80,
    saving:'50–80 kg CO₂e/year by diverting wet waste from landfill',
    tags:['Zero waste','Compostable bags','Balcony-friendly'],
    links:{ amazon: tbAmzLink('B09XXKM7FS'), brand:'https://www.ugaoo.com/composting' },
    commission:'Amazon ~8% + brand 10%', stars:4.3, reviews:3480,
    desc:'Includes microbe powder. No smell, no leaks. Works in any apartment.',
  },
  { id:'copper_bottle', cat:'home',
    name:'Milton Copper Water Bottle 1L', tagline:'Replace single-use plastic forever',
    priceNum:699, price:'₹699', eco:83,
    saving:'2.1 kg CO₂ avoided per 100 plastic bottles replaced',
    tags:['Plastic-free','Antimicrobial','Leak-proof','BPA-free'],
    links:{ amazon: tbAmzLink('B07KTRSJ5S'), flipkart: tbFlipLink('itmfa9zkxrewdbcc') },
    commission:'Amazon Associates ~9%', stars:4.5, reviews:18700,
    desc:'Eliminate 500+ plastic bottles/year per person.',
  },
  { id:'bamboo_products', cat:'home',
    name:'Bamboo Daily Essentials Kit (12pc)', tagline:'Toothbrush, cotton buds, combs, razors',
    priceNum:499, price:'₹499', eco:87,
    saving:'~1.5 kg plastic waste avoided per kit/year',
    tags:['Biodegradable','Plastic-free','FSC bamboo'],
    links:{ amazon: tbAmzLink('B09C3NRPHM') },
    commission:'Amazon Associates ~10%', stars:4.4, reviews:9200,
    desc:'Complete bathroom switch from plastic. Certified sustainable bamboo.',
  },
  { id:'reusable_bags', cat:'home',
    name:'ECOBOO Reusable Mesh Produce Bags (15pc)', tagline:'Grocery & veggie bags — zero plastic',
    priceNum:349, price:'₹349', eco:85,
    saving:'Eliminates ~400 single-use plastic bags/year',
    tags:['Mesh','Washable','Tare weight printed','GOTS certified'],
    links:{ amazon: tbAmzLink('B08L5PXKM6') },
    commission:'Amazon Associates ~10%', stars:4.4, reviews:7600,
    desc:'Replace every single-use bag from supermarket to wet market.',
  },
  { id:'rainwater_harvester', cat:'home',
    name:'Harvest Water 100L Rainwater Tank Kit', tagline:'Harvest rooftop rainwater for garden',
    priceNum:2499, price:'₹2,499', eco:78,
    saving:'Saves ~15,000 L treated water/year = 5.2 kg CO₂',
    tags:['Water conservation','HDPE food-grade','Overflow diverter'],
    links:{ amazon: tbAmzLink('B09T5HGFND') },
    commission:'Amazon Associates ~7%', stars:4.2, reviews:840,
    desc:'Diverts first flush, stores clean rain for garden and car wash.',
  },

  /* ── KITCHEN ── */
  { id:'prestige_induction', cat:'kitchen',
    name:'Prestige Induction Cooktop 1800W', tagline:'70% more efficient than LPG gas',
    priceNum:2299, price:'₹2,299', eco:82,
    saving:'Saves 30–60 kg CO₂/year vs LPG (on renewables)',
    tags:['BIS','Auto shut-off','7 preset menus','1-yr warranty'],
    links:{ amazon: tbAmzLink('B009KBZFQS'), flipkart: tbFlipLink('itmezdtqfanzvbwz') },
    commission:'Amazon Associates ~6%', stars:4.4, reviews:82300,
    desc:'India\'s top-rated induction cooktop. Instant heat, easy cleanup.',
  },
  { id:'instant_pot', cat:'kitchen',
    name:'Instant Pot Duo 6L Pressure Cooker', tagline:'70% less energy than stovetop cooking',
    priceNum:7999, price:'₹7,999', eco:80,
    saving:'35 kg CO₂/year vs gas pressure cooker (with induction)',
    tags:['Energy efficient','7-in-1','BPA-free','Safety certified'],
    links:{ amazon: tbAmzLink('B00FLYWNYQ') },
    commission:'Amazon Associates ~6%', stars:4.5, reviews:46200,
    desc:'Replaces 7 appliances. 70% less energy, 35–70% faster than stovetop.',
  },
  { id:'electric_kettle_ss', cat:'kitchen',
    name:'Butterfly Stainless Steel Electric Kettle 1.5L', tagline:'Faster & safer than gas',
    priceNum:799, price:'₹799', eco:72,
    saving:'5 kg CO₂/year vs LPG for daily tea/coffee (800 cups)',
    tags:['Stainless steel','Auto shut-off','BIS certified','BPA-free'],
    links:{ amazon: tbAmzLink('B00FF0NW3K'), flipkart: tbFlipLink('itmez3fhkdg4ztyh') },
    commission:'Amazon Associates ~8%', stars:4.4, reviews:31400,
    desc:'Boils 1.5L in 3 min. No more leaving gas on.',
  },

  /* ── LIFESTYLE ── */
  { id:'air_purifier_smart', cat:'lifestyle',
    name:'Dyson Pure Cool TP07 Air Purifier Fan', tagline:'HEPA + carbon filter — removes PM2.5',
    priceNum:45900, price:'₹45,900', eco:70,
    saving:'Reduces need for AC cooling by improving air circulation',
    tags:['HEPA','CADR 300','App connected','Energy Star'],
    links:{ amazon: tbAmzLink('B08G1DTVCL'), brand:'https://www.dyson.in/air-treatment' },
    commission:'Amazon ~3% + brand 5%', stars:4.4, reviews:5890,
    desc:'Filters 99.95% of pollutants + cools. Reduces AC dependence in shoulder months.',
  },
  { id:'yoga_mat_natural', cat:'lifestyle',
    name:'Boldfit Natural Rubber Yoga Mat 6mm', tagline:'Biodegradable — no PVC foam',
    priceNum:1299, price:'₹1,299', eco:88,
    saving:'Avoids ~2 kg microplastic vs PVC mat over lifetime',
    tags:['Natural rubber','Biodegradable','Non-slip','No phthalates'],
    links:{ amazon: tbAmzLink('B09BZMXY7T') },
    commission:'Amazon Associates ~9%', stars:4.3, reviews:6750,
    desc:'Lasts 3× longer than PVC mats. Sustainably sourced natural rubber.',
  },
  { id:'solar_lantern', cat:'lifestyle',
    name:'Philips Solar LED Lantern 7W', tagline:'Off-grid lighting + phone charger',
    priceNum:1499, price:'₹1,499', eco:91,
    saving:'20 kg CO₂/year vs kerosene lantern',
    tags:['Solar','USB charger','IP65','7-hr runtime'],
    links:{ amazon: tbAmzLink('B09FCK6TXH'), flipkart: tbFlipLink('itm9bq7fhkdgzzcd') },
    commission:'Amazon Associates ~6%', stars:4.5, reviews:4200,
    desc:'Eliminates kerosene. USB charges phones. Perfect for load-shedding.',
  },

  /* ── FASHION ── */
  { id:'organic_tshirt', cat:'fashion',
    name:'No Nasties Organic Cotton T-Shirt', tagline:'GOTS certified — zero pesticides',
    priceNum:999, price:'₹999', eco:85,
    saving:'~3 kg CO₂ saved vs conventional cotton shirt',
    tags:['GOTS certified','Organic','Fair Trade','Made in India'],
    links:{ brand:'https://www.nonasties.in', amazon: tbAmzLink('B08QRSPVGW') },
    commission:'Brand direct 12% + Amazon 8%', stars:4.5, reviews:3100,
    desc:'100% GOTS organic cotton. Fair wage certified. Ships in recycled packaging.',
  },
  { id:'recycled_backpack', cat:'fashion',
    name:'Ecoright Recycled PET Backpack 20L', tagline:'Made from 15 recycled plastic bottles',
    priceNum:1799, price:'₹1,799', eco:87,
    saving:'~2.5 kg CO₂ avoided vs virgin nylon backpack',
    tags:['Recycled PET','Water resistant','OEKO-TEX','RPET certified'],
    links:{ amazon: tbAmzLink('B09BZH9M4Y'), brand:'https://www.ecoright.in' },
    commission:'Amazon ~9% + brand 10%', stars:4.4, reviews:5680,
    desc:'Durable, water-resistant, and every bag diverts 15 plastic bottles from landfill.',
  },
  { id:'bamboo_socks', cat:'fashion',
    name:'Bonjour Bamboo Socks (Pack of 5)', tagline:'Antibacterial, moisture-wicking, biodegradable',
    priceNum:599, price:'₹599', eco:83,
    saving:'~1 kg CO₂ saved vs synthetic fibre socks per pack',
    tags:['Bamboo','Biodegradable','Antibacterial','Seamless toe'],
    links:{ amazon: tbAmzLink('B07YZDB9FK'), flipkart: tbFlipLink('itmfhkdgzyxcv123') },
    commission:'Amazon Associates ~10%', stars:4.3, reviews:9800,
    desc:'Bamboo fibres are naturally antimicrobial. Last 3× longer than cotton socks.',
  },
  { id:'second_hand_platform', cat:'fashion',
    name:'Sell & Buy Pre-loved Clothing — OLX/Meesho', tagline:'Best eco option: buy second-hand',
    priceNum:0, price:'Free listing', eco:99,
    saving:'Up to 95% lower CO₂ vs new garment',
    tags:['Circular economy','Zero waste','Community','Free to list'],
    links:{ brand:'https://www.olx.in/fashion', amazon: null, flipkart: null },
    commission:'No commission — included for planet impact', stars:5, reviews:0,
    desc:'The greenest choice of all. Buying second-hand saves 95% of a garment\'s carbon.',
  },
];

function tbNormalizeVendorLinks() {
  TAINT_PRODUCTS.forEach(product => {
    if (!product.links) product.links = {};
    const query = tbProductSearchQuery(product);
    if (product.links.amazon) product.links.amazon = tbAmazonSearchLink(query);
    if (product.links.flipkart) product.links.flipkart = tbFlipkartSearchLink(query);
    if (product.links.brand) product.links.brand = tbSafeExternalUrl(product.links.brand);
  });
}
tbNormalizeVendorLinks();

function tbVendorIcon(domain) {
  return `https://www.google.com/s2/favicons?sz=96&domain=${encodeURIComponent(domain)}`;
}

const TB_VENDOR_IMAGES = {
  ather_450x:tbVendorIcon('atherenergy.com'),
  ola_s1:tbVendorIcon('olaelectric.com'),
  lectrix_charger:tbVendorIcon('lectrixev.com'),
  cycle_vector:tbVendorIcon('herolectro.com'),
  luminous_solar:tbVendorIcon('luminousindia.com'),
  havells_5star_ac:tbVendorIcon('havells.com'),
  philips_led:tbVendorIcon('philips.co.in'),
  enphase_monitor:tbVendorIcon('enphase.com'),
  solar_water_heater:tbVendorIcon('vguard.in'),
  compost_ugaoo:tbVendorIcon('ugaoo.com'),
  copper_bottle:tbVendorIcon('milton.in'),
  bamboo_products:tbVendorIcon('bamboopecker.com'),
  reusable_bags:tbVendorIcon('ecoboo.in'),
  rainwater_harvester:tbVendorIcon('kent.co.in'),
  prestige_induction:tbVendorIcon('prestigeappliances.com'),
  instant_pot:tbVendorIcon('instantpot.in'),
  electric_kettle_ss:tbVendorIcon('butterflyindia.com'),
  air_purifier_smart:tbVendorIcon('dyson.in'),
  yoga_mat_natural:tbVendorIcon('decathlon.in'),
  solar_lantern:tbVendorIcon('philips.co.in'),
  organic_tshirt:tbVendorIcon('nonasties.in'),
  recycled_backpack:tbVendorIcon('ecoright.com'),
  bamboo_socks:tbVendorIcon('bonjourretail.com'),
  second_hand_platform:tbVendorIcon('olx.in')
};

function tbProductImage(product) {
  return product.image || TB_VENDOR_IMAGES[product.id] || tbVendorIcon('example.com');
}

function tbBuyButton(platform, url, productId) {
  const safeUrl = tbSafeExternalUrl(url);
  if (!safeUrl) return '';
  const labels = { amazon:'Amazon', flipkart:'Flipkart', brand:'Brand Site' };
  const label = labels[platform] || platform;
  return `<a class="tb-buy-btn ${platform}" href="${safeUrl}" target="_blank" rel="noopener noreferrer sponsored" onclick="tbTrack('${platform}','${productId}')">${label}</a>`;
}

/* ── Render product cards ── */
function tbRenderGrid(products) {
  const grid = document.getElementById('tbGrid');
  if (!products.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--hi)">No products in this category yet.</div>';
    return;
  }
  grid.innerHTML = products.map(p => {
    const ecoCls  = p.eco >= 85 ? '' : 'amber';
    const buyBtns = [
      tbBuyButton('amazon', p.links.amazon, p.id),
      tbBuyButton('flipkart', p.links.flipkart, p.id),
      tbBuyButton('brand', p.links.brand, p.id),
    ].filter(Boolean).join('');

    return `
    <div class="tb-card" data-cat="${p.cat}" data-id="${p.id}">
      <span class="tb-eco-badge ${ecoCls}">Eco ${p.eco}/100</span>
      <div class="tb-card-header">
        <img class="tb-card-img" src="${tbProductImage(p)}" alt="${p.name}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">
        <div class="tb-card-info">
          <div class="tb-card-name">${p.name}</div>
          <div class="tb-card-tagline">${p.tagline}</div>
        </div>
      </div>
      <div class="tb-saving">Saves <b>${p.saving}</b></div>
      <div class="tb-tags">${p.tags.map(t=>`<span class="tb-tag">${t}</span>`).join('')}</div>
      <div class="tb-meta">
        <span class="tb-price">${p.price}</span>
        <span class="tb-stars">${'★'.repeat(Math.round(p.stars))}${'☆'.repeat(5-Math.round(p.stars))} ${p.stars}${p.reviews?` (${p.reviews.toLocaleString('en-IN')})`:''}
        </span>
      </div>
      <div class="tb-commission">${p.commission}</div>
      <div class="tb-buy-row">${buyBtns}</div>
      <button class="tb-owned-btn" type="button" onclick="tbRecordProductStatus('bought','${p.id}')">Mark Bought</button>
    </div>`;
  }).join('');
  document.getElementById('tbCount').textContent = `${products.length} product${products.length!==1?'s':''}`;
}

/* ── Track clicks (analytics stub) ── */
function tbProductById(productId) {
  return TAINT_PRODUCTS.find(p => p.id === productId) || null;
}

function tbStoreLocalStatus(record) {
  const row = {
    id: record.id || `buy-${Date.now()}`,
    mode:'buy',
    at: record.at || new Date().toISOString(),
    city: record.city || city().name,
    title: record.productName || record.product_id || 'Taint Buy product',
    detail: `${record.status === 'bought' ? 'Bought' : 'Checked out'}${record.platform ? ` · ${record.platform}` : ''}`,
    value: Number(record.priceNum || 0),
    unit:'INR',
    payload: record
  };
  const existing = readLocalRecent('buy').filter(item => item.id !== row.id);
  writeLocalRecent('buy', [row, ...existing]);
  renderRecentCalculations('buy');
}

function tbRecordProductStatus(status, productId, platform='manual') {
  const product = tbProductById(productId);
  if (!product) return;
  const normalizedStatus = status === 'bought' ? 'bought' : 'checked_out';
  const record = {
    product_id : product.id,
    productName: product.name,
    platform,
    status: normalizedStatus,
    priceNum: product.priceNum || 0,
    city: city().name,
    at: new Date().toISOString()
  };
  tbStoreLocalStatus(record);
  sbPost('product_purchases', {
    product_id  : product.id,
    product_name: product.name,
    platform,
    status      : normalizedStatus,
    price_num   : product.priceNum || 0,
    quantity    : 1,
    city_key    : currentCityKey,
    city_name   : city().name,
    metadata    : { eco:product.eco, saving:product.saving, tags:product.tags, source:'taint_buy' }
  }, 'functional');
  if (normalizedStatus === 'bought') notify(`${product.name} added to your bought list.`, 'success', 'Taint Buy');
}

function tbTrack(platform, productId) {
  const product = tbProductById(productId);
  try {
    const key = `tb_click_${Date.now()}`;
    localStorage.setItem(key, JSON.stringify({ platform, productId, city: city().name, ts: new Date().toISOString() }));
  } catch {}
  sbPost('product_clicks', {
    platform,
    product_id: productId,
    city_key  : currentCityKey,
    city_name : city().name,
    metadata  : product ? { productName:product.name, priceNum:product.priceNum || 0 } : {}
  }, 'functional');
  tbRecordProductStatus('checked_out', productId, platform);
}

/* ── Filter + sort ── */
let tbCurrentCat  = 'all';
let tbCurrentSort = 'saving';

function tbApplyFilter() {
  let list = TAINT_PRODUCTS.filter(p => tbCurrentCat === 'all' || p.cat === tbCurrentCat);
  if (tbCurrentSort === 'saving')      list.sort((a,b) => b.eco - a.eco);
  else if (tbCurrentSort === 'eco')    list.sort((a,b) => b.eco - a.eco);
  else if (tbCurrentSort === 'price_asc')  list.sort((a,b) => a.priceNum - b.priceNum);
  else if (tbCurrentSort === 'price_desc') list.sort((a,b) => b.priceNum - a.priceNum);
  tbRenderGrid(list);
}

document.querySelectorAll('.tb-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tb-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tbCurrentCat = btn.dataset.cat;
    tbApplyFilter();
  });
});

document.getElementById('tbSort').addEventListener('change', function() {
  tbCurrentSort = this.value;
  tbApplyFilter();
});

/* ── AI personalised picks using Claude API ── */
document.getElementById('tbAiBtn').addEventListener('click', async () => {
  const btn  = document.getElementById('tbAiBtn');
  const body = document.getElementById('tbAiBody');

  /* Build profile from My Taint saved data */
  const profile = {
    city      : city().name,
    commute   : mtSaved?.commute  || null,
    workplace : mtSaved?.workplace || null,
    home      : mtSaved?.home     || null,
  };
  const hasProfile = profile.commute || profile.home;

  btn.textContent = '⏳ Analysing your carbon profile…';
  btn.disabled    = true;
  body.innerHTML  = '<div class="tb-ai-loading">Calling Claude AI…</div>';

  const systemPrompt = `You are a carbon-reduction product advisor for Indian urban consumers.
Given a user's carbon profile, recommend exactly 3 products from the list that will give the HIGHEST CO₂ reduction for that specific user.
Return ONLY a JSON array of 3 objects: [{"rank":1,"id":"product_id","name":"product name","why":"1-sentence reason specific to their profile, mentioning the kg CO₂ they'd save"}]
No extra text, no markdown, no explanation outside the JSON.`;

  const userMsg = hasProfile
    ? `My carbon profile — City: ${profile.city}.
${profile.commute ? `Commute: ${profile.commute.mode} ${profile.commute.km}km/day, ${profile.commute.days} days/week.` : ''}
${profile.home ? `Home: ${profile.home.occ} people, electricity ${(profile.home.elecT*1000).toFixed(0)}kg CO₂/yr, LPG ${(profile.home.lpgT*1000).toFixed(0)}kg CO₂/yr, diet ${document.getElementById('mtDiet')?.value||'vegetarian'}.` : ''}
Available product IDs: ${TAINT_PRODUCTS.map(p=>p.id).join(', ')}.
Pick the 3 that would most reduce MY specific footprint.`
    : `Urban Indian consumer, city: ${profile.city}. No detailed profile yet — recommend the 3 highest-impact green products for a typical urban household from these IDs: ${TAINT_PRODUCTS.map(p=>p.id).join(', ')}.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        model      : 'claude-sonnet-4-20250514',
        max_tokens : 500,
        system     : systemPrompt,
        messages   : [{ role:'user', content: userMsg }]
      })
    });
    const data  = await res.json();
    const raw   = data.content?.find(b => b.type==='text')?.text || '[]';
    const clean = raw.replace(/```json|```/g,'').trim();
    const picks = JSON.parse(clean);

    body.innerHTML = '<div class="tb-ai-picks">' +
      picks.map(p => {
        const prod = TAINT_PRODUCTS.find(x => x.id === p.id);
        if (!prod) return '';
        return `<div class="tb-ai-pick">
          <span class="tb-ai-pick-num">#${p.rank}</span>
          <img class="tb-ai-pick-img" src="${tbProductImage(prod)}" alt="${prod.name}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">
          <div class="tb-ai-pick-body">
            <div class="tb-ai-pick-name">${p.name || prod.name}</div>
            <div class="tb-ai-pick-why">${p.why}</div>
          </div>
        </div>`;
      }).join('') + '</div>';
    btn.textContent = 'Refresh Picks';
    btn.disabled    = false;
  } catch (err) {
    body.innerHTML = '<div class="tb-ai-hint" style="color:var(--amber)">Could not load AI recommendations. Showing all products below.</div>';
    btn.textContent = 'Get My Picks';
    btn.disabled    = false;
  }
});

/* Initialise grid on first show */
let tbInitialised = false;
function tbInit() {
  if (tbInitialised) return;
  tbInitialised = true;
  tbApplyFilter();
}
