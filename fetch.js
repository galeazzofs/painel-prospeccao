#!/usr/bin/env node
// =============================================================================
// fetch.js — Puxa deals do HubSpot e gera data.json para o Painel Prospecção
// Roda via GitHub Actions (cron diário) ou local: node fetch.js
// =============================================================================

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;  // fetch.js está na raiz do repo

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
if (!HUBSPOT_TOKEN) { console.error('❌ HUBSPOT_ACCESS_TOKEN não definido'); process.exit(1); }

const API = 'https://api.hubapi.com';

// Pipeline e stages (idênticos ao Cortex)
const PIPELINE_ID = '8582978';

const STAGES_SDR = [
  { id: '72557853',  name: 'Mapeamento' },
  { id: '24595558',  name: 'Abordar' },
  { id: '24595559',  name: 'Em cadência' },
  { id: '24595562',  name: 'Lead Conectado' },
  { id: '24595560',  name: 'Qual. Agendada' },
  { id: '24595561',  name: 'Qual. Realizada' },
  { id: '9102669',   name: 'SAO' },
];

const STAGES_OPP = [
  { id: '9102669',               name: 'SAO' },
  { id: 'presentationscheduled', name: 'Elab. Proposta' },
  { id: '11505970',              name: 'Proposta Enviada' },
  { id: 'decisionmakerboughtin', name: 'Em negociação' },
  { id: '26183057',              name: 'Proposta Aceita' },
];

const STAGE_SDR_LOST = '24595564';
const STAGE_OPP_LOST = 'closedlost';

const ALL_STAGE_IDS = [
  ...new Set([
    ...STAGES_SDR.map(s => s.id),
    ...STAGES_OPP.map(s => s.id),
    STAGE_SDR_LOST,
    STAGE_OPP_LOST,
  ])
];

// Propriedades a buscar
const DEAL_PROPS = [
  'dealname', 'dealstage', 'pipeline', 'amount', 'createdate',
  'hubspot_owner_id', 'closed_lost_reason',
  'porte',
  'setor',
  'origem',
  'origem_micro_',
  'ev_responsavel',
  ...ALL_STAGE_IDS.map(id => `hs_date_entered_${id}`),
];

// ─── FILTROS: origem = Prospecção AND origem_micro_ = Motor sinais ──────────
function buildSearchBody() {
  return {
    filterGroups: [{
      filters: [
        { propertyName: 'pipeline',      operator: 'EQ', value: PIPELINE_ID },
        { propertyName: 'origem',        operator: 'EQ', value: 'Prospecção' },
        { propertyName: 'origem_micro_', operator: 'EQ', value: 'Motor sinais' },
      ]
    }],
    properties: DEAL_PROPS,
    limit: 100,
    sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
  };
}

// ─── HUBSPOT API ────────────────────────────────────────────────────────────
const headers = {
  'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

async function hubGet(path) {
  const r = await fetch(`${API}${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function hubPost(path, body) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchAllDeals(body) {
  const deals = [];
  let after = 0;
  while (true) {
    const data = await hubPost('/crm/v3/objects/deals/search', { ...body, after });
    deals.push(...(data.results || []));
    console.log(`  … ${deals.length} deals`);
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return deals;
}

async function fetchOwners() {
  const map = {};
  let after;
  while (true) {
    const url = after ? `/crm/v3/owners?limit=100&after=${after}` : '/crm/v3/owners?limit=100';
    const data = await hubGet(url);
    for (const o of data.results || []) {
      map[o.id] = `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email;
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }
  return map;
}

// ─── BUSINESS DAYS ──────────────────────────────────────────────────────────
function countBusinessDays(from, to) {
  let count = 0;
  const d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ─── TRANSFORM DEAL ─────────────────────────────────────────────────────────
function transformDeal(raw, owners) {
  const p = raw.properties || {};

  const stages = {};
  for (const id of ALL_STAGE_IDS) {
    const val = p[`hs_date_entered_${id}`];
    if (val) stages[id] = val;
  }

  const currentStage = p.dealstage;
  const isSDRLost = !!stages[STAGE_SDR_LOST];
  const isOPPLost = currentStage === STAGE_OPP_LOST || !!stages[STAGE_OPP_LOST];
  const isLost = isSDRLost || isOPPLost;

  let lostStage = null;
  let lostFunnel = null;
  if (isLost) {
    const activeEntries = Object.entries(stages)
      .filter(([id]) => id !== STAGE_SDR_LOST && id !== STAGE_OPP_LOST)
      .sort((a, b) => new Date(b[1]) - new Date(a[1]));
    if (activeEntries.length > 0) {
      const lostId = activeEntries[0][0];
      const allStages = [...STAGES_SDR, ...STAGES_OPP];
      const found = allStages.find(s => s.id === lostId);
      lostStage = found?.name || lostId;
    }
    lostFunnel = isOPPLost ? 'OPP' : 'SDR';
  }

  const ownerId = p.hubspot_owner_id;
  const ownerName = owners[ownerId] || (ownerId ? `Owner ${ownerId}` : null);
  const evId = p.ev_responsavel;
  const evName = evId ? (owners[evId] || evId) : ownerName;

  return {
    id: raw.id,
    company: p.dealname || '— sem nome',
    porte: p.porte || null,
    setor: p.setor || '— sem categoria',
    cn: ownerName,
    ev: evName,
    stages,
    amount: Number(p.amount) || 0,
    isLost,
    lostStage,
    lostFunnel,
    lostReason: isLost ? (p.closed_lost_reason || null) : null,
  };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 Painel Prospecção — sync HubSpot\n');

  const targetsFile = JSON.parse(readFileSync(resolve(ROOT, 'targets.json'), 'utf-8'));
  const { month, monthLabel, businessDays, targets } = targetsFile;
  const monthStart = `${month}-01`;
  const lastDay = new Date(Number(month.split('-')[0]), Number(month.split('-')[1]), 0).getDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

  console.log(`📅 ${monthLabel} (${monthStart} → ${monthEnd})`);
  console.log(`🎯 ${targets.map(t => `${t.name}=${t.target}`).join(', ')}\n`);

  console.log('👥 Buscando owners…');
  const owners = await fetchOwners();
  console.log(`   ${Object.keys(owners).length} owners\n`);

  console.log('📊 Buscando deals (origem=Prospecção, origem_micro_=Motor sinais)…');
  const rawDeals = await fetchAllDeals(buildSearchBody());
  console.log(`   ${rawDeals.length} deals encontrados\n`);

  const deals = rawDeals.map(d => transformDeal(d, owners));

  const today = new Date().toISOString().slice(0, 10);
  const effectiveToday = today > monthEnd ? monthEnd : today;
  const bizElapsed = countBusinessDays(monthStart, effectiveToday);

  const porteCounts = { all: deals.length };
  const porteSet = new Set();
  deals.forEach(d => {
    if (d.porte) {
      porteSet.add(d.porte);
      porteCounts[d.porte] = (porteCounts[d.porte] || 0) + 1;
    }
  });

  const setores = [...new Set(deals.map(d => d.setor).filter(Boolean))].sort();
  const cns     = [...new Set(deals.map(d => d.cn).filter(Boolean))].sort();
  const evs     = [...new Set(deals.map(d => d.ev).filter(Boolean))].sort();

  const data = {
    meta: {
      updatedAt: new Date().toISOString(),
      monthLabel,
      monthStart,
      monthEnd,
      businessDays,
      businessDaysElapsed: bizElapsed,
      companiesTotal: new Set(deals.map(d => d.company)).size,
      availablePortes: [...porteSet].sort(),
      porteCounts,
    },
    targets,
    deals,
    filters: { setores, cns, evs },
    debug: {
      totalDeals: deals.length,
      dealsWithoutPorte: deals.filter(d => !d.porte).length,
      query: 'origem=Prospecção AND origem_micro_=Motor sinais',
    },
  };

  const outPath = resolve(ROOT, 'data.json');
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✅ data.json: ${deals.length} deals → ${outPath}`);
}

main().catch(err => { console.error('💥', err.message); process.exit(1); });
